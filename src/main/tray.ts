import { Menu, nativeImage, net, Tray, type NativeImage } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import noteIcon from '../../resources/trayTemplate.png?asset'
import playIcon from '../../resources/trayPlayTemplate.png?asset'
import pauseIcon from '../../resources/trayPauseTemplate.png?asset'
import type { MenuBarIcon, MenuBarMode, PlayerCommand, PlayerState } from '../shared/types'

// Menu bar "now playing": the song next to an icon (a note, or play/pause showing whether it's
// playing), and a native menu with the cover art and the playback controls. Native only (no
// window), so it costs nothing beyond the state main already polls.
const MAX = 40
const ART = 40 // cover art size in the menu, in points

interface TrayActions {
  command: (c: PlayerCommand) => void
  show: () => void
  quit: () => void
  dump?: string // test runs: draw the item into files in this folder instead of the menu bar
}

type TrayLike = Pick<Tray, 'setImage' | 'setTitle' | 'setToolTip' | 'setContextMenu' | 'destroy'>

let tray: TrayLike | null = null
let actions: TrayActions
let mode: MenuBarMode = 'off'
let iconMode: MenuBarIcon = 'note'
let last: PlayerState | null = null // the song on show, so a mode change redraws right away
let shown = ''
let icon = '' // the icon file on show, so the image is only swapped when it changes
let art: { url: string; image: NativeImage | null } | null = null

// Menu item subtitles need macOS 14.4; before that the artist goes on a line of its own.
const [major, minor] = process.getSystemVersion().split('.').map(Number)
const sublabels = major > 14 || (major === 14 && minor >= 4)

export function initTray(on: TrayActions): void {
  actions = on
}

// Whether the tray wants player state, so main can stop polling when nothing is shown.
export const trayOn = (): boolean => !!tray

// 'off' removes the item from the menu bar; any other mode creates it if needed and redraws.
export function setTrayMode(m: MenuBarMode, i: MenuBarIcon): void {
  if (m === mode && i === iconMode) return
  mode = m
  iconMode = i
  if (m === 'off') {
    tray?.destroy()
    tray = null
    icon = ''
    return
  }
  if (!tray) tray = actions.dump ? dumpTray(actions.dump) : new Tray(nativeImage.createEmpty())
  render(last)
}

// Rebuilds only when something the menu bar shows changes, not on every clock tick.
export function updateTray(s: PlayerState | null): void {
  // A song that just changed has no trustworthy title yet (see player.ts); keep the old one.
  if (!tray || s?.pending) return
  const key = s?.videoId ? JSON.stringify([s.title, s.artist, s.album, s.thumb, s.playing, s.liked]) : ''
  if (key === shown) return
  shown = key
  last = s?.videoId ? s : null
  render(last)
}

// A 36px template image at 2x: 18pt in the menu bar, recoloured by macOS for light/dark.
function template(file: string): NativeImage {
  const img = nativeImage.createFromBuffer(readFileSync(file), { scaleFactor: 2 })
  img.setTemplateImage(true)
  return img
}

function render(s: PlayerState | null): void {
  if (!tray) return
  const file = iconMode === 'status' && s ? (s.playing ? playIcon : pauseIcon) : noteIcon
  if (file !== icon) tray.setImage(template((icon = file)))
  const full = s ? [s.title, s.artist].filter(Boolean).join(' · ') : ''
  const line = !s ? '' : mode === 'song' ? s.title : mode === 'artist' ? s.artist : mode === 'both' ? full : ''
  tray.setTitle(line.length > MAX ? `${line.slice(0, MAX - 1).trimEnd()}…` : line)
  tray.setToolTip(full || 'ytspot')
  const cmd = (type: 'toggle' | 'next' | 'prev' | 'like') => () => actions.command({ type })
  const sub = s ? [s.artist, s.album].filter(Boolean).join(' · ') : ''
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(s
        ? [
            // The song, with its cover art; clicking it opens the app.
            { label: s.title, ...(sublabels ? { sublabel: sub } : {}), icon: cover(s.thumb) ?? undefined, click: actions.show },
            ...(sublabels ? [] : [{ label: sub, enabled: false }]),
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

// The song's cover art for the menu, or null while it loads (the menu is redrawn once it has).
// Only the latest song's art is kept.
function cover(url: string): NativeImage | null {
  if (!url) return null
  if (art?.url === url) return art.image
  const entry: { url: string; image: NativeImage | null } = (art = { url, image: null })
  net
    .fetch(url)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((buf) => {
      entry.image = rounded(nativeImage.createFromBuffer(Buffer.from(buf)))
      if (art === entry && last?.thumb === url) render(last)
    })
    .catch((e) => console.error('[tray] art', (e as Error).message))
  return null
}

// Square (a video frame is cropped to its middle), at 2x, with rounded corners like macOS artwork.
function rounded(img: NativeImage): NativeImage | null {
  const { width, height } = img.getSize()
  if (!width || !height) return null
  const side = Math.min(width, height)
  const px = ART * 2
  const sq = img
    .crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side })
    .resize({ width: px, height: px, quality: 'best' })
  const bmp = sq.toBitmap() // BGRA, premultiplied: scale every channel by how much of a pixel is inside
  const r = 8
  for (let y = 0; y < px; y++)
    for (let x = 0; x < px; x++) {
      const dx = Math.max(r - x - 0.5, x + 0.5 - (px - r), 0)
      const dy = Math.max(r - y - 0.5, y + 0.5 - (px - r), 0)
      const cover = Math.min(Math.max(r - Math.hypot(dx, dy) + 0.5, 0), 1)
      if (cover < 1) for (let c = 0; c < 4; c++) bmp[(y * px + x) * 4 + c] *= cover
    }
  return nativeImage.createFromBitmap(bmp, { width: px, height: px, scaleFactor: 2 })
}

// Test runs stay off the user's menu bar: this stands in for the menu bar item and writes what it
// would show into `dir` (icon.png, title.txt, menu.json, art.png) for a test to read.
function dumpTray(dir: string): TrayLike {
  mkdirSync(dir, { recursive: true })
  const write = (name: string, data: string | Buffer) => writeFileSync(join(dir, name), data)
  return {
    setImage: (img) => write('icon.png', (img as NativeImage).toPNG({ scaleFactor: 2 })),
    setTitle: (t) => write('title.txt', t),
    setToolTip: () => {},
    setContextMenu: (menu) => {
      const items = menu?.items ?? []
      write('menu.json', JSON.stringify(items.map((i) => ({ label: i.label, sublabel: i.sublabel, type: i.type, enabled: i.enabled, checked: i.checked, icon: !!i.icon })), null, 1))
      const withArt = items.find((i) => i.icon)
      if (withArt) write('art.png', (withArt.icon as NativeImage).toPNG({ scaleFactor: 2 }))
    },
    destroy: () => {}
  }
}
