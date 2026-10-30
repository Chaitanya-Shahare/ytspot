import { Menu, nativeImage, Tray } from 'electron'
import { readFileSync } from 'node:fs'
import icon from '../../resources/trayTemplate.png?asset'
import type { MenuBarMode, PlayerCommand, PlayerState } from '../shared/types'

// Menu bar "now playing": the song next to a note icon, and a native menu with the playback
// controls. Native only (no window), so it costs nothing beyond the state main already polls.
const MAX = 40

interface TrayActions {
  command: (c: PlayerCommand) => void
  show: () => void
  quit: () => void
}

let tray: Tray | null = null
let actions: TrayActions
let mode: MenuBarMode = 'off'
let last: PlayerState | null = null // the song on show, so a mode change redraws right away
let shown = ''

export function initTray(on: TrayActions): void {
  actions = on
}

// Whether the tray wants player state, so main can stop polling when nothing is shown.
export const trayOn = (): boolean => !!tray

// 'off' removes the item from the menu bar; any other mode creates it if needed and redraws.
export function setTrayMode(m: MenuBarMode): void {
  if (m === mode) return
  mode = m
  if (m === 'off') {
    tray?.destroy()
    tray = null
    return
  }
  if (!tray) {
    // A 36px template image at 2x: 18pt in the menu bar, recoloured by macOS for light/dark.
    const img = nativeImage.createFromBuffer(readFileSync(icon), { scaleFactor: 2 })
    img.setTemplateImage(true)
    tray = new Tray(img)
  }
  render(last)
}

// Rebuilds only when something the menu bar shows changes, not on every clock tick.
export function updateTray(s: PlayerState | null): void {
  // A song that just changed has no trustworthy title yet (see player.ts); keep the old one.
  if (!tray || s?.pending) return
  const key = s?.videoId ? JSON.stringify([s.title, s.artist, s.album, s.playing, s.liked]) : ''
  if (key === shown) return
  shown = key
  last = s?.videoId ? s : null
  render(last)
}

function render(s: PlayerState | null): void {
  if (!tray) return
  const full = s ? [s.title, s.artist].filter(Boolean).join(' · ') : ''
  const line = !s ? '' : mode === 'song' ? s.title : mode === 'artist' ? s.artist : mode === 'both' ? full : ''
  tray.setTitle(line.length > MAX ? `${line.slice(0, MAX - 1).trimEnd()}…` : line)
  tray.setToolTip(full || 'ytspot')
  const cmd = (type: 'toggle' | 'next' | 'prev' | 'like') => () => actions.command({ type })
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(s
        ? [
            { label: s.title, enabled: false },
            { label: [s.artist, s.album].filter(Boolean).join(' · '), enabled: false },
            { type: 'separator' as const },
            { label: s.playing ? 'Pause' : 'Play', click: cmd('toggle') },
            { label: 'Next', click: cmd('next') },
            { label: 'Previous', click: cmd('prev') },
            { label: 'Like Song', type: 'checkbox' as const, checked: s.liked, click: cmd('like') }
          ]
        : [{ label: 'Nothing playing', enabled: false }]),
      { type: 'separator' },
      { label: 'Show ytspot', click: actions.show },
      { label: 'Quit ytspot', click: actions.quit }
    ])
  )
}
