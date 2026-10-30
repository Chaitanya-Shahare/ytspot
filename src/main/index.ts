import { app, BrowserWindow, clipboard, ipcMain, Menu, shell } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yt from './api'
import { lyrics } from './lyrics'
import { buildMenu } from './menu'
import { initTray, setTrayMode, trayOn, updateTray } from './tray'
import { command, createPlayerWindow, placeVideo, rateVideo, saveToLibrary, subscribe, getState, onLoggedIn, setVideoMode, applyYtmSetting, showLogin, signOut, uploadImage, ytmSession, ytmSettings } from './player'
import { bindings, DEFAULT_PREFS, type Action } from '../shared/shortcuts'
import type { MainPrefs, MenuBarMode, PlayerCommand, PlayerState } from '../shared/types'

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
// Main's copy of the menu bar setting, so launch shows (or skips) the tray before the UI has loaded.
const prefsFile = join(app.getPath('userData'), 'prefs.json')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let main: BrowserWindow | null = null
let keys = bindings(DEFAULT_PREFS)
let sent: { info: string; time: number; queue: unknown; autoplay: unknown } | null = null
let loggedIn: boolean | null = null // unknown until the first cookie check
let quitting = false
let keepPlaying = true
let menuBar: MenuBarMode = 'both'
try {
  menuBar = JSON.parse(readFileSync(prefsFile, 'utf8')).menuBar ?? menuBar
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
  main?.webContents.send('auth', loggedIn)
}

function createMain(): BrowserWindow {
  let bounds = {}
  try {
    bounds = JSON.parse(readFileSync(boundsFile, 'utf8'))
  } catch {
    // first launch: default size
  }
  const win = (main = new BrowserWindow({
    width: 1400,
    height: 900,
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    // A test run opens behind whatever the user is doing instead of taking focus.
    show: !testProfile,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 25 },
    webPreferences: { preload: join(dir, '../preload/index.mjs'), sandbox: false, spellcheck: false, backgroundThrottling: !headless }
  }))
  // Like Spotify, closing the window keeps the music playing (the hidden player window lives on).
  // The UI window is destroyed rather than hidden so its renderer's memory is freed while in the
  // background; the Dock, Raycast or a menu action recreate it in under a second from cache.
  win.on('close', () => {
    // Move the player page out before this window (and its views) is destroyed.
    placeVideo(null, null)
    writeFileSync(boundsFile, JSON.stringify(win.getNormalBounds()))
    if (!quitting && !keepPlaying) app.quit()
  })
  win.on('closed', () => (main = null))
  if (testProfile && !headless) win.once('ready-to-show', () => win.showInactive())
  win.on('enter-full-screen', () => win.webContents.send('fullscreen', true))
  win.on('leave-full-screen', () => win.webContents.send('fullscreen', false))
  // A reloading UI can't report that the video slot went away; put the video back out of sight.
  win.webContents.on('did-start-loading', () => placeVideo(null, null))
  sent = null
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(dir, '../renderer/index.html'))
  return win
}

// Show the UI window (recreating it if it was closed); `then` runs once it can receive messages.
function showMain(then?: (w: BrowserWindow) => void): void {
  if (main) {
    main.show()
    then?.(main)
    return
  }
  const win = createMain()
  if (then) win.webContents.once('did-finish-load', () => setTimeout(() => then(win), 300))
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
  const ui = !!main && (main.isVisible() || headless)
  if (!ui && !trayOn()) return
  const s = await getState()
  updateTray(s)
  if (!s || !main || !ui) return
  if (s.pending) {
    if (pendingSince?.id !== s.videoId) pendingSince = { id: s.videoId, at: Date.now() }
    if (Date.now() - pendingSince.at < 1000) return void setTimeout(pushState, 200)
  } else pendingSince = null
  const { time, queue, autoplay, ...rest }: PlayerState = s
  const info = JSON.stringify(rest)
  if (!sent || info !== sent.info || queue !== sent.queue || autoplay !== sent.autoplay) {
    sent = { info, time, queue, autoplay }
    main.webContents.send('player:state', s)
  } else if (time !== sent.time) {
    sent.time = time
    main.webContents.send('player:time', time)
  }
}

async function playerCommand(c: PlayerCommand): Promise<void> {
  await command(c)
  setTimeout(pushState, 150)
}

// Headless test runs stay off the user's menu bar. Fill a newly shown tray in right away.
function applyMenuBar(): void {
  setTrayMode(headless ? 'off' : menuBar)
  pushState()
}

const rebuildMenu = () => buildMenu(() => main, showMain, keys)

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
      window: BrowserWindow.fromWebContents(e.sender) ?? undefined,
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
  ipcMain.handle('yt:lyrics', data(lyrics))
  ipcMain.handle('player:cmd', (_, c: PlayerCommand) => playerCommand(c))
  ipcMain.handle('player:get', () => getState())
  ipcMain.handle('ui:popup', popup)
  ipcMain.handle('ui:open', (_, url: string) => shell.openExternal(url))
  ipcMain.handle('ui:copy', (_, text: string) => clipboard.writeText(text))
  ipcMain.handle('ui:log', (_, msg: string) => console.error('[ui]', msg))
  ipcMain.handle('ui:videoRect', (_, r: Electron.Rectangle | null) => placeVideo(main, r))
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
    if (p.menuBar !== menuBar) {
      menuBar = p.menuBar
      writeFileSync(prefsFile, JSON.stringify({ menuBar }))
      applyMenuBar()
    }
  })

  createPlayerWindow()
  createMain()
  rebuildMenu()
  initTray({ command: playerCommand, show: () => showMain(), quit: () => app.quit() })
  applyMenuBar()

  let t: NodeJS.Timeout
  ses.cookies.on('changed', (_, cookie) => {
    if (cookie.name !== 'SAPISID') return
    clearTimeout(t)
    t = setTimeout(syncAuth, 1500)
  })

  setInterval(pushState, 1000)
})
