import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import type { ShortcutPrefs } from '../../shared/shortcuts'
import { DEFAULT_PREFS } from '../../shared/shortcuts'
import type { Card, More, PlayerState, Track } from '../../shared/types'

export type Route =
  | { name: 'home' }
  | { name: 'search'; q: string }
  | { name: 'playlist'; id: string }
  | { name: 'album'; id: string }
  | { name: 'artist'; id: string }
  | { name: 'explore' }
  | { name: 'mood'; params: string; title: string }
  | { name: 'settings' }
  | { name: 'lyrics' }
  | { name: 'more'; title: string; browseId: string; params?: string }

// Where playback was started from (a playlist, album or artist page), for "Playing from".
export interface Source {
  route: Route
  title: string
}
export const sameRoute = (a?: Route | null, b?: Route | null) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b)

export interface AppCtx {
  route: Route
  go: (r: Route) => void
  // Everything except the playback clock, so long lists don't re-render every tick.
  player: PlayerState | null
  playTrack: (t: Track, playlistId?: string, from?: Source) => void
  source: Source | null
  openCard: (c: Card) => void
  playCard: (c: Card) => void
  toast: (msg: string) => void
  prefs: Prefs
  setPrefs: (p: Partial<Prefs>) => void
  openQueue: () => void
}

export interface Prefs {
  shortcuts: ShortcutPrefs
  keepPlaying: boolean
  openAtLogin: boolean
  videoMode: boolean
}

const PREF_DEFAULTS: Prefs = { shortcuts: DEFAULT_PREFS, keepPlaying: true, openAtLogin: false, videoMode: false }
export const loadPrefs = (): Prefs => ({ ...PREF_DEFAULTS, ...JSON.parse(localStorage.getItem('prefs') ?? '{}') })
export const savePrefs = (p: Prefs) => localStorage.setItem('prefs', JSON.stringify(p))

export const Ctx = createContext<AppCtx>(null as unknown as AppCtx)
export const useApp = () => useContext(Ctx)

// The playback clock lives outside React state, so a tick re-renders only what shows the time.
let clock = 0
let clockAt = 0
const clockSubs = new Set<() => void>()
export const getClock = () => clock
export function setClock(t: number): void {
  clock = t
  clockAt = performance.now()
  clockSubs.forEach((f) => f())
}
// Main sends the time about once a second; synced lyrics need finer, so extrapolate while playing.
export const liveClock = (playing: boolean) => (playing ? clock + Math.min(2, (performance.now() - clockAt) / 1000) : clock)
const subscribeClock = (f: () => void) => (clockSubs.add(f), () => void clockSubs.delete(f))
export const useTime = () => useSyncExternalStore(subscribeClock, getClock)

// Ask YouTube's image CDN for roughly the size we display (2x for retina) instead of 544px everywhere.
export const sized = (url: string, px: number) => url.replace(/=w\d+-h\d+/, `=w${px * 2}-h${px * 2}`)

// A "Show all" target: playlists open as playlists, anything else as a grid of cards.
export const moreRoute = (m: More, title: string): Route =>
  m.browseId.startsWith('VL') ? { name: 'playlist', id: m.browseId } : { name: 'more', title, browseId: m.browseId, params: m.params }

export function routeFor(c: Card): Route | null {
  if (c.kind === 'album') return { name: 'album', id: c.id }
  if (c.kind === 'playlist') return { name: 'playlist', id: c.id }
  if (c.kind === 'artist') return { name: 'artist', id: c.id }
  return null
}

export function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// Page data cache: revisits and back/forward render instantly from cache. Feeds (home, search,
// library) refresh quietly in the background; collections are kept for the session. Keys marked
// `persist` are also saved to disk so the app opens with the last home feed/library already drawn.
const cache = new Map<string, unknown>()
localStorage.removeItem('cache:home') // pre-0.2 home feed, saved without its mood chips
// Bumped when a key is invalidated, so a request (or a playlist page) that was already on its way
// can't put the stale copy back.
const generation = new Map<string, number>()
const gen = (key: string) => generation.get(key) ?? 0
export function invalidate(key: string): void {
  cache.delete(key)
  generation.set(key, gen(key) + 1)
}
// Signing in or out: nothing cached belongs to the new session.
export function resetCache(): void {
  for (const key of cache.keys()) invalidate(key)
  for (const k of Object.keys(localStorage)) if (k.startsWith('cache:')) localStorage.removeItem(k)
}

// Lets the library sidebar reload after a playlist is created elsewhere (e.g. a song's menu).
const libraryWatchers = new Set<() => void>()
export const libraryChanged = () => libraryWatchers.forEach((f) => f())
export const onLibraryChange = (f: () => void) => (libraryWatchers.add(f), () => void libraryWatchers.delete(f))
// The user's playlists as last loaded by the library sidebar (for "Add to playlist").
export const cachedPlaylists = (): Card[] =>
  ([...cache].reverse().find(([k]) => k.startsWith('library:true:Playlists:'))?.[1] as Card[] | undefined) ?? []

function read<T>(key: string, persist: boolean): T | undefined {
  if (cache.has(key) || !persist) return cache.get(key) as T | undefined
  const saved = localStorage.getItem(`cache:${key}`)
  return saved ? (JSON.parse(saved) as T) : undefined
}

export function useCached<T>(
  key: string,
  fn: () => Promise<T>,
  { revalidate = true, persist = false } = {}
): { data?: T; error?: string; set: (d: T) => void; retry: () => void } {
  const [res, setRes] = useState<{ data?: T; error?: string }>(() => ({ data: read<T>(key, persist) }))
  const [attempt, setAttempt] = useState(0)
  const [loadedGen, setLoadedGen] = useState(() => gen(key))
  const store = (data: T) => {
    cache.set(key, data)
    if (persist) localStorage.setItem(`cache:${key}`, JSON.stringify(data))
  }
  const set = (data: T) => {
    if (gen(key) === loadedGen) store(data)
    setRes({ data })
  }
  useEffect(() => {
    let live = true
    const cached = read<T>(key, persist)
    const g = gen(key)
    setLoadedGen(g)
    setRes({ data: cached })
    if (cache.has(key) && !revalidate) return
    fn()
      .then((data) => {
        if (gen(key) === g) store(data)
        if (live) setRes({ data })
      })
      .catch((e: Error) => live && cached === undefined && setRes({ error: e.message }))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt])
  return { ...res, set, retry: () => setAttempt((n) => n + 1) }
}

// Average colour of an image, darkened, for Spotify-style header gradients.
export function useColor(src?: string): string {
  const [color, setColor] = useState('rgb(83,83,83)')
  useEffect(() => {
    if (!src) return
    let live = true
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const c = document.createElement('canvas')
        c.width = c.height = 8
        const g = c.getContext('2d')!
        g.drawImage(img, 0, 0, 8, 8)
        const d = g.getImageData(0, 0, 8, 8).data
        let r = 0, gr = 0, b = 0
        for (let i = 0; i < d.length; i += 4) (r += d[i]), (gr += d[i + 1]), (b += d[i + 2])
        const n = d.length / 4
        const k = 0.75
        if (live) setColor(`rgb(${(r / n) * k | 0},${(gr / n) * k | 0},${(b / n) * k | 0})`)
      } catch {
        if (live) setColor('rgb(83,83,83)')
      }
    }
    img.src = src
    return () => {
      live = false
    }
  }, [src])
  return color
}
