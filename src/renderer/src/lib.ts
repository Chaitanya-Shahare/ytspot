import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
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
  // The songs it covers; once something else plays (radio, autoplay) it no longer applies.
  ids?: string[]
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
  toast: (msg: string, action?: ToastAction) => void
  // Spotify's "Add to playlist" popover for a song, next to the button that opened it.
  openSave: (song: SaveSong, from: HTMLElement) => void
  prefs: Prefs
  setPrefs: (p: Partial<Prefs>) => void
  openQueue: () => void
}

export interface ToastAction {
  label: string
  run: () => void
}

export interface SaveSong {
  videoId: string
  title: string
  liked?: boolean // known like state (the playing song's is read live instead)
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
export function moreRoute(m: More, title: string): Route {
  if (m.browseId.startsWith('VL')) return { name: 'playlist', id: m.browseId }
  if (!m.params && m.browseId.startsWith('UC')) return { name: 'artist', id: m.browseId }
  if (m.browseId.startsWith('MPRE')) return { name: 'album', id: m.browseId }
  return { name: 'more', title, browseId: m.browseId, params: m.params }
}

export function routeFor(c: Card): Route | null {
  if (c.kind === 'album') return { name: 'album', id: c.id }
  if (c.kind === 'playlist') return { name: 'playlist', id: c.id }
  if (c.kind === 'artist') return { name: 'artist', id: c.id }
  return null
}

export function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = String(Math.floor(sec % 60)).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

// Page data cache: revisits and back/forward render instantly from cache. Feeds (home, search,
// library) refresh quietly in the background; collections are kept for the session. Keys marked
// `persist` are also saved to disk so the app opens with the last home feed/library already drawn.
const cache = new Map<string, unknown>()
localStorage.removeItem('cache:home') // pre-0.2 home feed, saved without its mood chips
// Bumped when a key is invalidated, so a request (or a playlist page) that was already on its way
// can't put the stale copy back.
const generation = new Map<string, number>()
// Bumped on sign-in/out, so requests still on their way from the old session are dropped too.
let session = 0
const gen = (key: string) => `${session}:${generation.get(key) ?? 0}`
// Pages showing a key reload it in place when it's invalidated (e.g. a song added to the open playlist).
const keyWatchers = new Map<string, Set<() => void>>()
export function invalidate(key: string): void {
  cache.delete(key)
  generation.set(key, (generation.get(key) ?? 0) + 1)
  keyWatchers.get(key)?.forEach((f) => f())
}
// A playlist changed: its page reloads and the library's song counts follow.
export function playlistChanged(id: string): void {
  invalidate(`playlist:${id}`)
  if (id === 'LM' || id === 'VLLM') invalidate(`playlist:${id === 'LM' ? 'VLLM' : 'LM'}`)
  else libraryChanged()
}
// Signing in or out: nothing cached belongs to the new session.
export function resetCache(): void {
  session++
  ownPlaylists = null
  cache.clear()
  for (const k of Object.keys(localStorage)) if (k.startsWith('cache:')) localStorage.removeItem(k)
}

// Lets the library sidebar reload after a playlist is created elsewhere (e.g. a song's menu).
const libraryWatchers = new Set<() => void>()
export const libraryChanged = () => {
  ownPlaylists = null
  libraryWatchers.forEach((f) => f())
}
export const onLibraryChange = (f: () => void) => (libraryWatchers.add(f), () => void libraryWatchers.delete(f))
// The playlists you can add songs to (your own), for "Add to playlist"; YTM lists the same ones
// whatever the song, so one fetch serves every menu until the library changes.
let ownPlaylists: Promise<Card[]> | null = null
export function savablePlaylists(videoId: string): Promise<Card[]> {
  ownPlaylists ??= window.ytm.savablePlaylists(videoId).catch((e: Error) => {
    ownPlaylists = null
    throw e
  })
  return ownPlaylists
}

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
  // The result remembers its key: on the render where the key changes, the old key's data must not
  // show (e.g. the previous artist's card) before the effect below catches up.
  const [res, setRes] = useState<{ key: string; data?: T; error?: string }>(() => ({ key, data: read<T>(key, persist) }))
  const [attempt, setAttempt] = useState(0)
  const [loadedGen, setLoadedGen] = useState(() => gen(key))
  const store = (data: T) => {
    cache.set(key, data)
    if (persist) localStorage.setItem(`cache:${key}`, JSON.stringify(data))
  }
  const set = (data: T) => {
    if (gen(key) === loadedGen) store(data)
    setRes({ key, data })
  }
  // Invalidated while on screen: fetch again and swap it in, keeping the current page up meanwhile.
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    let live = true
    const reload = () => {
      const g = gen(key)
      fnRef.current().then(
        (data) => {
          if (gen(key) === g) store(data)
          if (live) (setLoadedGen(g), setRes({ key, data }))
        },
        () => undefined
      )
    }
    let set = keyWatchers.get(key)
    if (!set) keyWatchers.set(key, (set = new Set()))
    set.add(reload)
    return () => {
      live = false
      set.delete(reload)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => {
    let live = true
    const cached = read<T>(key, persist)
    const g = gen(key)
    setLoadedGen(g)
    setRes({ key, data: cached })
    if (cache.has(key) && !revalidate) return
    fn()
      .then((data) => {
        if (gen(key) === g) store(data)
        if (live) setRes({ key, data })
      })
      .catch((e: Error) => live && cached === undefined && setRes({ key, error: e.message }))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt])
  const current = res.key === key ? res : { key, data: read<T>(key, persist) }
  return { data: current.data, error: current.error, set, retry: () => setAttempt((n) => n + 1) }
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
