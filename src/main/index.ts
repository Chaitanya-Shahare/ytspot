import { app, BaseWindow, BrowserWindow, clipboard, ipcMain, Menu, protocol, shell, WebContentsView, type WebContents } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yt from './api'
import { lyrics, type LyricsQuery } from './lyrics'
import { download, downloaded, downloadsState, initDownloads, MEDIA_SCHEME, removeDownloads, savedLyrics, serve } from './downloads'
import { leaveLocal, localActive, localCommand, localState, playLocal, setLocalLiked } from './local'
import { buildMenu } from './menu'
import { initTray, setTrayMode, trayOn, updateTray } from './tray'
import { checkForUpdates, initUpdater, promptUpdate, setAutoUpdate, updateState } from './updater'
import { command, createPlayerWindow, fitVideo, parkVideo, pauseYtm, placeVideo, rateVideo, saveToLibrary, subscribe, getState, onLoggedIn, setVideoMode, applyYtmSetting, showLogin, signOut, uploadImage, ytmSession, ytmSettings } from './player'
import { bindings, DEFAULT_PREFS, type Action } from '../shared/shortcuts'
import type { Download, DownloadQuality, MainPrefs, MenuBarIcon, MenuBarMode, PlayerCommand, PlayerState, Track, VideoRect } from '../shared/types'

const dir = fileURLToPath(new URL('.', import.meta.url))
// Test runs (YTSPOT_PROFILE=<dir>) get their own profile so they never share data, the keychain
// entry or the media keys with an installed copy; YTSPOT_MUTE=1 silences the player.
const testProfile = process.env.YTSPOT_PROFILE
// YTSPOT_HEADLESS=1 (test runs only): no window on screen and no Dock icon; the UI still renders,
// unthrottled, for driving over CDP.
const headless = !!testProfile && !!process.env.YTSPOT_HEADLESS
if (testProfile) {
  app.setPath('userData', testProfile)
  app.commandLine.appendSwitch('use-mock-keychain')
  app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService')
}
const boundsFile = join(app.getPath('userData'), 'window.json')
// Main's copy of the menu bar and auto-update settings, so launch acts on them before the UI has loaded.
const prefsFile = join(app.getPath('userData'), 'prefs.json')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// Downloaded songs and their artwork (see downloads.ts): a secure, streamable scheme so the audio
// can seek and the UI can show the artwork.
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])

// The app window and the page drawn in it. The page is a view of its own (not a BrowserWindow's
// built-in page) so the player's video can be stacked beneath it in full screen.
let main: BaseWindow | null = null
let ui: WebContents | null = null
let keys = bindings(DEFAULT_PREFS)
let sent: { info: string; time: number; queue: unknown; autoplay: unknown } | null = null
let loggedIn: boolean | null = null // unknown until the first cookie check
let quitting = false
let keepPlaying = true
let menuBar: MenuBarMode = 'both'
let menuBarIcon: MenuBarIcon = 'note'
let autoUpdate = false
try {
  const saved = JSON.parse(readFileSync(prefsFile, 'utf8'))
  menuBar = saved.menuBar ?? menuBar
  menuBarIcon = saved.menuBarIcon ?? menuBarIcon
  autoUpdate = saved.autoUpdate ?? autoUpdate
} catch {
  // first launch: default
}

async function syncAuth(): Promise<void> {
  const cookies = await ytmSession().cookies.get({ url: 'https://music.youtube.com' })
  const now = cookies.some((c) => c.name === 'SAPISID')
  try {
    const jar = (list: Electron.Cookie[]) => list.map((c) => `${c.name}=${c.value}`).join('; ')
    const fresh = async () => jar(await ytmSession().cookies.get({ url: 'https://music.youtube.com' }))
    if (now !== loggedIn || !yt.ready()) await yt.connect(now ? jar(cookies) : undefined, now ? fresh : undefined)
  } catch (e) {
    // Offline: the window still opens, and data calls try to connect again (see `data` below).
    console.error('[auth]', (e as Error).message)
  }
  // Only after a real sign-in (not on startup) does the player page need reloading.
  if (now && loggedIn === false) onLoggedIn()
  loggedIn = now
  ui?.send('auth', loggedIn)
}

function createMain(): BaseWindow {
  let bounds = {}
  try {
    bounds = JSON.parse(readFileSync(boundsFile, 'utf8'))
  } catch {
    // first launch: default size
  }
  const win = (main = new BaseWindow({
    width: 1400,
    height: 900,
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    // A test run opens behind whatever the user is doing instead of taking focus.
    show: !testProfile,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 25 }
  }))
  const view = new WebContentsView({
    webPreferences: { preload: join(dir, '../preload/index.mjs'), sandbox: false, spellcheck: false, backgroundThrottling: !headless }
  })
  // See-through where the page is: the window paints black behind it, and a full-screen video sits
  // between the two.
  view.setBackgroundColor('#00000000')
  win.contentView.addChildView(view)
  const fit = () => {
    const { width, height } = win.getContentBounds()
    view.setBounds({ x: 0, y: 0, width, height })
    fitVideo(win)
  }
  fit()
  win.on('resize', fit)
  const wc = (ui = view.webContents)
  // Like Spotify, closing the window keeps the music playing (the hidden player window lives on).
  // The UI window is destroyed rather than hidden so its renderer's memory is freed while in the
  // background; the Dock, Raycast or a menu action recreate it in under a second from cache.
  win.on('close', () => {
    // Move the player page out before this window (and its views) is destroyed.
    parkVideo()
    writeFileSync(boundsFile, JSON.stringify(win.getNormalBounds()))
    if (!quitting && !keepPlaying) app.quit()
  })
  // A window's views outlive it unless closed, and the point of closing is freeing the page.
  win.on('closed', () => {
    main = ui = null
    wc.close()
  })
  if (testProfile && !headless) wc.once('did-finish-load', () => win.showInactive())
  win.on('enter-full-screen', () => wc.send('fullscreen', true))
  win.on('leave-full-screen', () => wc.send('fullscreen', false))
  // A reloading UI can't report that the video slot went away; put the video back out of sight.
  wc.on('did-start-loading', () => parkVideo())
  sent = null
  if (process.env.ELECTRON_RENDERER_URL) wc.loadURL(process.env.ELECTRON_RENDERER_URL)
  else wc.loadFile(join(dir, '../renderer/index.html'))
  return win
}

// Show the UI window (recreating it if it was closed); `then` runs once its page can receive messages.
function showMain(then?: (page: WebContents) => void): void {
  if (main && ui) {
    main.show()
    then?.(ui)
    return
  }
  createMain()
  const page = ui!
  if (then) page.once('did-finish-load', () => setTimeout(() => then(page), 300))
}

// Push player state while someone can see it: the whole state when anything besides the clock
// changed, otherwise just the time. Each push repaints the window, so once a second (an m:ss clock)
// is enough; commands refresh right away so the controls still respond instantly.
// The menu bar item needs the song even with the window closed, so the poll keeps running then;
// the tray itself only redraws when the song or play state changes.
// A track change briefly has no trustworthy title/artwork (see player.ts); hold the update back
// for up to a second so the UI never shows the old song's art under the new song.
let pendingSince: { id: string; at: number } | null = null
async function pushState(): Promise<void> {
  const shown = !!main && (main.isVisible() || headless)
  if (!shown && !trayOn()) return
  const s = await currentState()
  updateTray(s)
  if (!s || !ui || !shown) return
  if (s.pending) {
    if (pendingSince?.id !== s.videoId) pendingSince = { id: s.videoId, at: Date.now() }
    if (Date.now() - pendingSince.at < 1000) return void setTimeout(pushState, 200)
  } else pendingSince = null
  const { time, queue, autoplay, ...rest }: PlayerState = s
  const info = JSON.stringify(rest)
  if (!sent || info !== sent.info || queue !== sent.queue || autoplay !== sent.autoplay) {
    sent = { info, time, queue, autoplay }
    ui.send('player:state', s)
  } else if (time !== sent.time) {
    sent.time = time
    ui.send('player:time', time)
  }
}

// Whichever is playing: YouTube Music, or downloaded songs from disk (local.ts).
const currentState = () => (localActive() ? localState() : getState())

const songsOf = async (ids: string[]) => (await Promise.all(ids.map(downloaded))).filter((d): d is Download => !!d)

async function playerCommand(c: PlayerCommand): Promise<void> {
  if (c.type === 'playLocal') {
    const songs = await songsOf(c.videoIds)
    const at = Math.max(0, songs.findIndex((d) => d.videoId === c.videoIds[c.index]))
    if (!songs.length) return
    // Carry the volume over, so switching to a downloaded song isn't suddenly louder.
    const ytm = localActive() ? null : await getState()
    if (ytm?.playing) await pauseYtm()
    await playLocal(songs, at, ytm ? (ytm.muted ? 0 : ytm.volume) : undefined)
  } else if (c.type === 'play' || c.type === 'videoMode' || !localActive()) {
    if (c.type === 'play' && localActive()) leaveLocal()
    await command(c)
  } else if (c.type === 'like') {
    const s = await localState()
    if (s) {
      setLocalLiked(s.videoId, !s.liked)
      rateVideo(s.videoId, !s.liked).catch(() => undefined)
    }
  } else await localCommand(c, songsOf)
  setTimeout(pushState, 150)
}

// Headless test runs stay off the user's menu bar, unless YTSPOT_TRAY_DUMP=<dir> asks for the item
// to be drawn into files there instead (see tray.ts). Fill a newly shown tray in right away.
const trayDump = headless ? process.env.YTSPOT_TRAY_DUMP : undefined
function applyMenuBar(): void {
  setTrayMode(headless && !trayDump ? 'off' : menuBar, menuBarIcon)
  pushState()
}

const rebuildMenu = () => buildMenu(() => main, () => ui, showMain, keys)

// Native popup menu for "…" / avatar / Create; resolves with the chosen id or null.
interface PopupItem {
  id: string
  label: string
  enabled?: boolean
  checked?: boolean // shown as a radio choice
  submenu?: PopupItem[]
}
function popup(e: Electron.IpcMainInvokeEvent, items: PopupItem[]) {
  return new Promise<string | null>((resolve) => {
    let picked: string | null = null
    const build = (list: PopupItem[]): Electron.MenuItemConstructorOptions[] =>
      list.map((i) =>
        i.label === '-'
          ? { type: 'separator' }
          : i.submenu
            ? { label: i.label, submenu: build(i.submenu) }
            : {
                label: i.label,
                enabled: i.enabled ?? true,
                ...(i.checked !== undefined ? { type: 'radio' as const, checked: i.checked } : {}),
                click: () => (picked = i.id)
              }
      )
    Menu.buildFromTemplate(build(items)).popup({
      window: (e.sender === ui ? main : BrowserWindow.fromWebContents(e.sender)) ?? undefined,
      // The click handler runs after the menu closes, so resolve on the next tick.
      callback: () => setTimeout(() => resolve(picked))
    })
  })
}

app.on('before-quit', () => (quitting = true))
app.on('activate', () => showMain())

app.whenReady().then(() => {
  if (headless) app.dock?.hide()
  const ses = ytmSession()
  // Open the window right away; data handlers wait for the YouTube session instead.
  const init = syncAuth()
  // One reconnect at a time when YouTube couldn't be reached earlier.
  let reconnect: Promise<void> | null = null
  const data =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (_: unknown, ...a: A) => {
      await init
      if (!yt.ready()) await (reconnect ??= syncAuth().finally(() => (reconnect = null)))
      return fn(...a)
    }

  ipcMain.handle('auth:status', async () => (await init, loggedIn))
  ipcMain.handle('auth:login', () => showLogin())
  ipcMain.handle('auth:logout', async () => {
    await signOut()
    await syncAuth()
  })
  ipcMain.handle('yt:account', data(yt.account))
  ipcMain.handle('yt:home', data(yt.home))
  ipcMain.handle('yt:explore', data(yt.explore))
  ipcMain.handle('yt:moods', data(yt.moods))
  ipcMain.handle('yt:mood', data(yt.mood))
  ipcMain.handle('yt:addToPlaylist', data(yt.addToPlaylist))
  ipcMain.handle('yt:removeFromPlaylist', data(yt.removeFromPlaylist))
  ipcMain.handle('yt:savablePlaylists', data(yt.savablePlaylists))
  ipcMain.handle('yt:updatePlaylist', data(yt.updatePlaylist))
  ipcMain.handle('yt:deletePlaylist', data(yt.deletePlaylist))
  ipcMain.handle('yt:playlistSuggestions', data(yt.playlistSuggestions))
  ipcMain.handle('yt:setPlaylistCover', data((id: string, image: { base64: string; mime: string }) => yt.setPlaylistCover(id, image, uploadImage)))
  ipcMain.handle('yt:rate', (_, videoId: string, like: boolean) => rateVideo(videoId, like))
  ipcMain.handle('yt:subscribe', (_, channelId: string, on: boolean) => subscribe(channelId, on))
  ipcMain.handle('yt:saveToLibrary', (_, playlistId: string, on: boolean) => saveToLibrary(playlistId, on))
  ipcMain.handle('yt:browseMore', data(yt.browseMore))
  ipcMain.handle('ytm:settings', () => ytmSettings())
  ipcMain.handle('ytm:applySetting', (_, endpoint: unknown) => applyYtmSetting(endpoint))
  ipcMain.handle('yt:library', data(yt.library))
  ipcMain.handle('yt:playlist', data(yt.playlist))
  ipcMain.handle('yt:playlistMore', data(yt.playlistMore))
  ipcMain.handle('yt:createPlaylist', data(yt.createPlaylist))
  ipcMain.handle('yt:album', data(yt.album))
  ipcMain.handle('yt:artist', data(yt.artist))
  ipcMain.handle('yt:search', data(yt.search))
  // A downloaded song's lyrics were saved with it, so they show offline too.
  const onlineLyrics = data(lyrics)
  ipcMain.handle('yt:lyrics', async (e, q: LyricsQuery) => (await savedLyrics(q.videoId)) ?? onlineLyrics(e, q))
  ipcMain.handle('dl:state', () => downloadsState())
  ipcMain.handle('dl:add', (_, tracks: Track[], quality: DownloadQuality) => download(tracks, quality))
  ipcMain.handle('dl:remove', (_, videoIds: string[]) => removeDownloads(videoIds))
  ipcMain.handle('player:cmd', (_, c: PlayerCommand) => playerCommand(c))
  ipcMain.handle('player:get', () => currentState())
  ipcMain.handle('update:state', () => updateState())
  ipcMain.handle('update:check', () => checkForUpdates(true))
  ipcMain.handle('update:prompt', () => promptUpdate())
  ipcMain.handle('ui:popup', popup)
  ipcMain.handle('ui:open', (_, url: string) => shell.openExternal(url))
  ipcMain.handle('ui:copy', (_, text: string) => clipboard.writeText(text))
  ipcMain.handle('ui:log', (_, msg: string) => console.error('[ui]', msg))
  ipcMain.handle('ui:videoRect', (_, r: VideoRect | null) => placeVideo(main, ui, r))
  // A test run stays in its window: native full screen would take over the user's screen.
  // Returns whether the window was already in full screen, so a caller only undoes its own change.
  ipcMain.handle('ui:fullscreen', (_, on?: boolean) => {
    const was = !!main?.isFullScreen()
    if (!testProfile) main?.setFullScreen(on ?? !was)
    return was
  })
  ipcMain.handle('ui:bindings', (_, b: Record<Action, string[]>) => {
    keys = b
    rebuildMenu()
  })
  ipcMain.handle('ui:prefs', (_, p: MainPrefs) => {
    keepPlaying = p.keepPlaying
    setVideoMode(p.videoMode)
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: p.openAtLogin })
    if (p.menuBar !== menuBar || p.menuBarIcon !== menuBarIcon || p.autoUpdate !== autoUpdate) {
      const tray = p.menuBar !== menuBar || p.menuBarIcon !== menuBarIcon
      menuBar = p.menuBar
      menuBarIcon = p.menuBarIcon
      autoUpdate = p.autoUpdate
      writeFileSync(prefsFile, JSON.stringify({ menuBar, menuBarIcon, autoUpdate }))
      if (tray) applyMenuBar()
      setAutoUpdate(autoUpdate)
    }
  })

  protocol.handle(MEDIA_SCHEME, serve)
  initDownloads((s) => ui?.send('downloads', s))
  createPlayerWindow()
  createMain()
  rebuildMenu()
  initTray({ command: playerCommand, show: () => showMain(), quit: () => app.quit(), dump: trayDump })
  applyMenuBar()
  initUpdater({ window: () => main, page: () => ui })
  setAutoUpdate(autoUpdate)

  let t: NodeJS.Timeout
  ses.cookies.on('changed', (_, cookie) => {
    if (cookie.name !== 'SAPISID') return
    clearTimeout(t)
    t = setTimeout(syncAuth, 1500)
  })

  setInterval(pushState, 1000)
})
