import { app, BrowserWindow, Menu, webContents, type BaseWindow, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { accel, SHORTCUTS, type Action } from '../shared/shortcuts'

// Spotify-style menu bar. Accelerators are display-only and mirror the user's current bindings:
// the renderer's keydown handler owns the keys (so typing in search still works), and menu
// clicks are forwarded to it as actions. (On macOS `registerAccelerator: false` still leaves the
// key on the menu item, which gets every key the page let through: Space typed into the search
// box would also press Play/Pause. So a key only reaches an item when the app's page isn't focused.)
export function buildMenu(
  main: () => BaseWindow | null,
  ui: () => WebContents | null,
  show: (then: (page: WebContents) => void) => void,
  keys: Record<Action, string[]>
): void {
  const item = (action: Action, label?: string): MenuItemConstructorOptions => ({
    label: label ?? SHORTCUTS.find((x) => x.action === action)!.label,
    accelerator: accel(keys[action] ?? []),
    registerAccelerator: false,
    click: (_, win, e) => {
      if (e.triggeredByAccelerator && webContents.getFocusedWebContents() === ui()) return
      // Back/Forward in the sign-in window navigate that page instead of the app.
      const nav = win instanceof BrowserWindow && win !== main() ? win.webContents.navigationHistory : null
      if (nav && action === 'back') return nav.goBack()
      if (nav && action === 'forward') return nav.goForward()
      show((page) => page.send('menu:action', action))
    }
  })
  const sep: MenuItemConstructorOptions = { type: 'separator' }
  // The app window's page is a view, which the built-in Reload, DevTools and zoom roles don't reach.
  const pageOf = (win?: BaseWindow) => (win instanceof BrowserWindow ? win.webContents : win && win === main() ? ui() : null)
  const zoom = (by: number) => (_: unknown, win?: BaseWindow) => {
    const page = pageOf(win)
    if (page) page.zoomLevel = by ? page.zoomLevel + by : 0
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' }, sep, item('settings', 'Settings…'), sep,
          { role: 'services' }, sep, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, sep, { role: 'quit' }
        ]
      },
      { label: 'File', submenu: [{ role: 'close' }] },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          item('home'), item('explore'), item('search'), item('liked'), item('library'), sep,
          item('back', 'Back'), item('forward', 'Forward'), sep,
          item('queue'), item('lyrics'), item('toggleLeft'), item('toggleRight'), sep,
          // Cmd+R is Spotify's Repeat, so Reload keeps no shortcut of its own.
          { label: 'Reload', click: (_i, win) => pageOf(win)?.reload() },
          { label: 'Toggle Developer Tools', accelerator: 'Alt+Cmd+I', click: (_i, win) => pageOf(win)?.toggleDevTools() }, sep,
          { label: 'Actual Size', accelerator: 'Cmd+0', click: zoom(0) },
          { label: 'Zoom In', accelerator: 'Cmd+Plus', click: zoom(0.5) },
          { label: 'Zoom Out', accelerator: 'Cmd+-', click: zoom(-0.5) }, sep,
          item('fullscreen')
        ]
      },
      {
        label: 'Playback',
        submenu: [
          item('toggle', 'Play/Pause'), item('next', 'Next'), item('prev', 'Previous'), sep,
          item('seekFwd'), item('seekBack'), sep,
          item('shuffle'), item('repeat'), sep,
          item('volUp', 'Volume Up'), item('volDown', 'Volume Down'), item('mute'), sep,
          item('like', 'Like Song'), item('dislike', 'Dislike Song')
        ]
      },
      { role: 'windowMenu' },
      { role: 'help', submenu: [item('help')] }
    ])
  )
}
