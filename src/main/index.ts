import { app, BrowserWindow, clipboard, ipcMain, Menu, shell } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yt from './api'
import { buildMenu } from './menu'
import { command, createPlayerWindow, placeVideo, rateVideo, getState, onLoggedIn, setVideoMode, applyYtmSetting, showLogin, signOut, ytmSession, ytmSettings } from './player'
import { bindings, DEFAULT_PREFS, type Action } from '../shared/shortcuts'

const dir = fileURLToPath(new URL('.', import.meta.url))
const boundsFile = join(app.getPath('userData'), 'window.json')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let main: BrowserWindow | null = null
let keys = bindings(DEFAULT_PREFS)
let lastState = ''
let loggedIn: boolean | null = null // unknown until the first cookie check
let quitting = false
let keepPlaying = true

async function syncAuth(): Promise<void> {
  const cookies = await ytmSession().cookies.get({ url: 'https://music.youtube.com' })
  const now = cookies.some((c) => c.name === 'SAPISID')
  if (now !== loggedIn || !yt.ready()) await yt.connect(now ? cookies.map((c) => `${c.name}=${c.value}`).join('; ') : undefined)
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
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 20 },
    webPreferences: { preload: join(dir, '../preload/index.mjs'), sandbox: false, spellcheck: false }
  }))
  // Like Spotify, closing the window keeps the music playing (the hidden player window lives on).
  // The UI window is destroyed rather than hidden so its renderer's memory is freed while in the
  // background; the Dock, Raycast or a menu action recreate it in under a second from cache.
  win.on('close', () => {
    // Move the player page out before this window (and its views) is destroyed.
    placeVideo(null, null)
    writeFileSync(boundsFile, JSON.stringify(win.getBounds()))
    if (!quitting && !keepPlaying) app.quit()
  })
  win.on('closed', () => (main = null))
  // A reloading UI can't report that the video slot went away; put the video back out of sight.
  win.webContents.on('did-start-loading', () => placeVideo(null, null))
  lastState = ''
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

const rebuildMenu = () => buildMenu(() => main, showMain, keys)

// Native popup menu for "…" / avatar / Create; resolves with the chosen id or null.
interface PopupItem {
  id: string
  label: string
  enabled?: boolean
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
            : { label: i.label, enabled: i.enabled ?? true, click: () => (picked = i.id) }
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
  const ses = ytmSession()
  // Open the window right away; data handlers wait for the YouTube session instead.
  const init = syncAuth()
  const data =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (_: unknown, ...a: A) => {
      await init
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
  ipcMain.handle('yt:rate', (_, videoId: string, like: boolean) => rateVideo(videoId, like))
  ipcMain.handle('ytm:settings', () => ytmSettings())
  ipcMain.handle('ytm:applySetting', (_, endpoint: unknown) => applyYtmSetting(endpoint))
  ipcMain.handle('yt:library', data(yt.library))
  ipcMain.handle('yt:playlist', data(yt.playlist))
  ipcMain.handle('yt:playlistMore', data(yt.playlistMore))
  ipcMain.handle('yt:createPlaylist', data(yt.createPlaylist))
  ipcMain.handle('yt:album', data(yt.album))
  ipcMain.handle('yt:artist', data(yt.artist))
  ipcMain.handle('yt:search', data(yt.search))
  ipcMain.handle('player:cmd', (_, c) => command(c))
  ipcMain.handle('player:get', () => getState())
  ipcMain.handle('ui:popup', popup)
  ipcMain.handle('ui:open', (_, url: string) => shell.openExternal(url))
  ipcMain.handle('ui:copy', (_, text: string) => clipboard.writeText(text))
  ipcMain.handle('ui:log', (_, msg: string) => console.error('[ui]', msg))
  ipcMain.handle('ui:videoRect', (_, r: Electron.Rectangle | null) => placeVideo(main, r))
  ipcMain.handle('ui:fullscreen', () => main?.setFullScreen(!main.isFullScreen()))
  ipcMain.handle('ui:bindings', (_, b: Record<Action, string[]>) => {
    keys = b
    rebuildMenu()
  })
  ipcMain.handle('ui:prefs', (_, p: { keepPlaying: boolean; videoMode: boolean; openAtLogin: boolean }) => {
    keepPlaying = p.keepPlaying
    setVideoMode(p.videoMode)
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: p.openAtLogin })
  })

  createPlayerWindow()
  createMain()
  rebuildMenu()

  let t: NodeJS.Timeout
  ses.cookies.on('changed', (_, cookie) => {
    if (cookie.name !== 'SAPISID') return
    clearTimeout(t)
    t = setTimeout(syncAuth, 1500)
  })

  // Push player state only when it changed and someone can see it.
  setInterval(async () => {
    if (!main?.isVisible()) return
    const s = await getState()
    const json = JSON.stringify(s)
    if (s && json !== lastState) {
      lastState = json
      main?.webContents.send('player:state', s)
    }
  }, 500)
})
