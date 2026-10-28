import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { accel, SHORTCUTS, type Action } from '../shared/shortcuts'

// Spotify-style menu bar. Accelerators are display-only and mirror the user's current bindings:
// the renderer's keydown handler owns the keys (so typing in search still works), and menu
// clicks are forwarded to it as actions.
export function buildMenu(
  main: () => BrowserWindow | null,
  show: (then: (w: BrowserWindow) => void) => void,
  keys: Record<Action, string[]>
): void {
  const item = (action: Action, label?: string): MenuItemConstructorOptions => ({
    label: label ?? SHORTCUTS.find((x) => x.action === action)!.label,
    accelerator: accel(keys[action] ?? []),
    registerAccelerator: false,
    click: (_, win) => {
      // Back/Forward in the sign-in window navigate that page instead of the app.
      const nav = win instanceof BrowserWindow && win !== main() ? win.webContents.navigationHistory : null
      if (nav && action === 'back') return nav.goBack()
      if (nav && action === 'forward') return nav.goForward()
      show((w) => w.webContents.send('menu:action', action))
    }
  })
  const sep: MenuItemConstructorOptions = { type: 'separator' }
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
          { role: 'reload' }, { role: 'toggleDevTools' }, sep,
          { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, sep,
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
