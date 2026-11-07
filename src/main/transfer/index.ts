// Importing a Spotify library into YouTube Music. Reads the library (spotify.ts), finds each song,
// album and artist on YouTube Music (youtube.ts, match.ts) and adds it to the signed-in account.
//
// Progress is saved as it goes, so an import can be stopped and resumed, survives quitting the app,
// and importing again later adds only what's new. This module is loaded the first time the import
// page asks for it (see main/index.ts), so it costs nothing until someone uses it.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import * as spotify from './spotify'
import * as youtube from './youtube'
import type { Source, Target } from './ports'
import type { Candidate, LibrarySummary, Missing, Selection, SourceAlbum, SourceArtist, SourceTrack, TransferApi, TransferItem, TransferPhase, TransferState } from '../../shared/transfer'

export interface Deps {
  send: (s: TransferState) => void
  file: string // where progress is saved
  signedIn: () => boolean // to YouTube Music
  fixture?: string[] // test runs: public playlists standing in for a library (fixture.ts)
}

// What's kept on disk, saved often while importing.
interface Saved {
  version: 1
  phase: TransferPhase
  library?: LibrarySummary
  items?: TransferItem[]
  error?: string
  // Kept across imports. Spotify song → YouTube Music video (null when not found), so a song is
  // looked up once; each playlist's YouTube Music copy and the songs added to it; what's been liked,
  // saved and followed.
  matches: Record<string, string | null>
  links: Record<string, { target: string; added: string[] }>
  liked: string[]
  albumsSaved: string[]
  artistsFollowed: string[]
}

const empty = (): Saved => ({ version: 1, phase: 'idle', matches: {}, links: {}, liked: [], albumsSaved: [], artistsFollowed: [] })

// The songs, albums and artists being imported, so an import resumes after a restart. Saved once
// when it starts, in a file of its own: it can be large, and doesn't change.
interface Picked {
  songs: Record<string, SourceTrack[]>
  descriptions: Record<string, string>
  albums: SourceAlbum[]
  artists: SourceArtist[]
}
const nothing = (): Picked => ({ songs: {}, descriptions: {}, albums: [], artists: [] })

// Songs looked up at once (each is a YouTube Music search), ahead of adding them in order.
const LOOKAHEAD = 4
// Songs per "add to playlist" call.
const BATCH = 25
// Failed calls in a row before the import stops (offline, signed out) instead of skipping songs.
const GIVE_UP_AFTER = 3

let deps: Deps
// Where music comes from and goes to (see ports.ts).
let source: Source = spotify
let target: Target = youtube
let saved: Saved = empty()
let picked: Picked = nothing()
const pickedFile = () => deps.file.replace(/\.json$/, '-songs.json')
let connected = false
let found = 0
// The library as last read, kept in memory only while choosing what to import.
let library: spotify.SourceLibrary | null = null
// The run in progress (reading or importing), to stop it.
let job: AbortController | null = null
let startedAt = 0
let doneAtStart = 0

export async function init(d: Deps): Promise<void> {
  deps = d
  if (d.fixture?.length) ({ source, target } = (await import('./fixture')).fixture(d.fixture))
  try {
    saved = { ...empty(), ...(JSON.parse(readFileSync(d.file, 'utf8')) as Saved) }
    if (saved.items) picked = { ...nothing(), ...(JSON.parse(readFileSync(pickedFile(), 'utf8')) as Picked) }
  } catch {
    // Never imported, or the file is unreadable: start fresh.
  }
  // An import that was running when the app quit waits to be resumed; anything earlier than
  // importing (a library read into memory) is gone.
  if (saved.phase === 'moving') saved.phase = 'stopped'
  else if (saved.phase !== 'stopped' && saved.phase !== 'done') saved.phase = 'idle'
  saved.items?.forEach((i) => i.status === 'working' && (i.status = 'waiting'))
  connected = await source.signedIn().catch(() => false)
}

// Signing in to or out of YouTube Music changes what the page offers.
export function authChanged(): void {
  if (deps) emit(true)
}

// ---------- state ----------

const total = (items: TransferItem[] = []) => items.reduce((n, i) => n + i.done, 0)

function view(): TransferState {
  return {
    phase: saved.phase,
    ytm: deps.signedIn(),
    connected,
    found: saved.phase === 'reading' ? found : undefined,
    library: saved.library,
    items: saved.items,
    startedAt: saved.phase === 'moving' ? startedAt : undefined,
    doneAtStart: saved.phase === 'moving' ? doneAtStart : undefined,
    error: saved.error
  }
}

// Updates go out at most a few times a second, and to disk every few seconds while importing.
// (Written aside and moved into place, so quitting mid-write can't leave half a file.)
function write(file: string, data: unknown): void {
  try {
    writeFileSync(`${file}.tmp`, JSON.stringify(data))
    renameSync(`${file}.tmp`, file)
  } catch (e) {
    console.error('[transfer] save', (e as Error).message)
  }
}

let sendTimer: NodeJS.Timeout | null = null
function emit(now = false): void {
  if (now) {
    if (sendTimer) clearTimeout(sendTimer)
    sendTimer = null
    deps.send(view())
  } else sendTimer ??= setTimeout(() => ((sendTimer = null), deps.send(view())), 250)
}

let saveTimer: NodeJS.Timeout | null = null
function persist(now = false): void {
  if (!now) return void (saveTimer ??= setTimeout(() => persist(true), 4000))
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  write(deps.file, saved)
}

function setPhase(phase: TransferPhase, error?: string): void {
  saved.phase = phase
  saved.error = error
  persist(true)
  emit(true)
}

// Saves everything right away (the app is quitting).
export function flush(): void {
  if (deps) persist(true)
}

// The UI window was (re)opened: show it where things are, so a running import's progress shows.
export function resend(): void {
  if (deps) emit(true)
}

// ---------- reading Spotify ----------

function summary(lib: spotify.SourceLibrary): LibrarySummary {
  return {
    account: lib.account,
    liked: lib.liked.length,
    playlists: lib.playlists.map(({ tracks: _t, description: _d, ...p }) => ({ ...p, linked: !!saved.links[p.id] })),
    albums: lib.albums,
    artists: lib.artists
  }
}

async function connect(): Promise<void> {
  if (saved.phase !== 'idle' && saved.phase !== 'ready') return
  saved.error = undefined
  if (!(await source.signedIn())) {
    setPhase('connecting')
    const ok = await source.logIn()
    connected = ok
    if (!ok) return setPhase('idle')
  }
  connected = true
  await read()
}

async function read(): Promise<void> {
  found = 0
  library = null
  saved.library = undefined
  setPhase('reading')
  const run = (job = new AbortController())
  try {
    library = await source.readLibrary(run.signal, (n) => ((found = n), emit()))
    saved.library = summary(library)
    if (!library.liked.length && !library.playlists.length && !library.albums.length && !library.artists.length)
      return setPhase('idle', 'Your Spotify library is empty: there’s nothing to import.')
    setPhase('ready')
  } catch (e) {
    if (run.signal.aborted) return setPhase('idle')
    if (e instanceof spotify.SignedOut) {
      await source.logOut().catch(() => undefined)
      connected = false
    }
    setPhase('idle', (e as Error).message)
  } finally {
    if (job === run) job = null
  }
}

function cancel(): void {
  if (saved.phase === 'connecting') source.cancelLogIn()
  else if (saved.phase === 'reading') job?.abort()
}

async function disconnect(): Promise<void> {
  job?.abort()
  await source.logOut()
  connected = false
  library = null
  if (saved.phase === 'ready' || saved.phase === 'reading' || saved.phase === 'connecting') {
    saved.library = undefined
    setPhase('idle')
  } else emit(true)
}

// ---------- importing ----------

function start(sel: Selection): void {
  if (saved.phase !== 'ready' || !library) throw new Error('Read your Spotify library first.')
  if (!deps.signedIn()) throw new Error('Log in to YouTube Music first.')
  const lib = library
  const items: TransferItem[] = []
  const songs: Record<string, SourceTrack[]> = {}
  const descriptions: Record<string, string> = {}
  const item = (i: Omit<TransferItem, 'done' | 'moved' | 'missing' | 'status'>): TransferItem => ({ ...i, done: 0, moved: 0, missing: [], status: 'waiting' })
  if (sel.liked && lib.liked.length) {
    items.push(item({ id: 'liked', kind: 'liked', title: 'Liked Songs', total: lib.liked.length }))
    // Oldest first: YouTube Music lists liked songs newest first, as Spotify does.
    songs.liked = [...lib.liked].reverse()
  }
  for (const p of lib.playlists.filter((p) => sel.playlists.includes(p.id))) {
    items.push(item({ id: p.id, kind: 'playlist', title: p.title, thumb: p.thumb, total: p.tracks.length, target: saved.links[p.id]?.target }))
    songs[p.id] = p.tracks
    descriptions[p.id] = p.description
  }
  if (sel.albums && lib.albums.length) items.push(item({ id: 'albums', kind: 'albums', title: 'Saved albums', total: lib.albums.length }))
  if (sel.artists && lib.artists.length) items.push(item({ id: 'artists', kind: 'artists', title: 'Followed artists', total: lib.artists.length }))
  if (!items.length) throw new Error('Choose something to import.')
  // Songs that weren't found last time get another try: YouTube Music adds songs all the time.
  for (const [id, v] of Object.entries(saved.matches)) if (v === null) delete saved.matches[id]
  saved.items = items
  picked = { songs, descriptions, albums: sel.albums ? lib.albums : [], artists: sel.artists ? lib.artists : [] }
  write(pickedFile(), picked)
  library = null
  void run()
}

function resume(): void {
  const failed = saved.items?.some((i) => i.status === 'failed')
  if (fixing || !saved.items || !(saved.phase === 'stopped' || (saved.phase === 'done' && failed))) return
  if (!deps.signedIn()) throw new Error('Log in to YouTube Music first.')
  void run()
}

function stop(): void {
  if (saved.phase === 'moving') job?.abort()
}

function reset(): void {
  if (saved.phase === 'moving') return
  job?.abort()
  library = null
  // What was imported stays recorded, so importing again only adds what's new.
  const { matches, links, liked, albumsSaved, artistsFollowed } = saved
  saved = { ...empty(), matches, links, liked, albumsSaved, artistsFollowed }
  picked = nothing()
  rmSync(pickedFile(), { force: true })
  setPhase('idle')
}

class Fatal extends Error {}

async function run(): Promise<void> {
  const items = saved.items ?? []
  const current = (job = new AbortController())
  const { signal } = current
  startedAt = Date.now()
  doneAtStart = total(items)
  setPhase('moving')
  try {
    for (const item of items) {
      if (item.status === 'done') continue
      if (signal.aborted) break
      item.status = 'working'
      item.error = undefined
      emit()
      try {
        if (item.kind === 'liked' || item.kind === 'playlist') await moveSongs(item, signal)
        else await moveOthers(item, signal)
        item.status = 'done'
      } catch (e) {
        if (signal.aborted) {
          item.status = 'waiting'
          break
        }
        if (e instanceof Fatal) {
          item.status = 'waiting'
          throw e
        }
        item.status = 'failed'
        item.error = (e as Error).message
      }
      persist()
      emit()
    }
    setPhase(signal.aborted ? 'stopped' : 'done')
  } catch (e) {
    setPhase('stopped', (e as Error).message)
  } finally {
    if (job === current) job = null
  }
}

const offline = (e: unknown) => new Fatal(`${String((e as Error)?.message ?? e).replace(/\.$/, '')}. Resume when you’re back online.`)

// YouTube Music calls during an import. api.ts already retries a dropped connection; a call that
// still fails is tried again. Adding (a write) that keeps failing stops the import, to resume
// later, rather than skip songs. A search that keeps failing (`soft`) leaves that one song out, unless
// several in a row do, which means the connection is gone: then the import stops too.
function guard(signal: AbortSignal) {
  let strikes = 0
  return async <T>(fn: () => Promise<T>, soft = false): Promise<T | undefined> => {
    for (let n = 1; ; n++) {
      signal.throwIfAborted()
      if (!deps.signedIn()) throw new Fatal('Log in to YouTube Music to continue.')
      try {
        const out = await fn()
        strikes = 0
        return out
      } catch (e) {
        if (signal.aborted) throw e
        // Searches get a third try: a momentary hiccup shouldn't list a song as not found.
        if (n < (soft ? 3 : 2)) {
          await abortable(new Promise((r) => setTimeout(r, 1500 * n)), signal)
          continue
        }
        if (!soft || ++strikes >= GIVE_UP_AFTER) throw offline(e)
        return undefined
      }
    }
  }
}

// Waits for `p`, or stops waiting as soon as the import is stopped.
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

// Each song is looked up (a few ahead at once) and added in its original order.
async function inOrder<T, R>(list: T[], signal: AbortSignal, find: (x: T) => Promise<R>, add: (x: T, r: R) => Promise<void>): Promise<void> {
  const pending: Promise<R>[] = []
  const launch = (i: number) => {
    if (i >= list.length) return
    pending[i] = find(list[i])
    pending[i].catch(() => undefined) // awaited below, in turn
  }
  for (let i = 0; i < LOOKAHEAD; i++) launch(i)
  for (let i = 0; i < list.length; i++) {
    const r = await abortable(pending[i], signal)
    delete pending[i]
    launch(i + LOOKAHEAD)
    await add(list[i], r)
  }
}

// An item's count only goes up while an import resumes through what it had already done, so the
// progress bar never jumps back; something earlier missing that's found now leaves the list.
function counter(item: TransferItem) {
  const floor = item.done
  let n = 0
  return {
    tick: () => void (item.done = Math.max(floor, ++n)),
    missing: (m: Missing) => void (item.missing.some((x) => x.id === m.id) || item.missing.push(m)),
    found: (id: string) => void (item.missing = item.missing.filter((x) => x.id !== id))
  }
}

async function moveSongs(item: TransferItem, signal: AbortSignal): Promise<void> {
  const songs = picked.songs[item.id] ?? []
  const call = guard(signal)
  const count = counter(item)
  const liked = item.kind === 'liked'
  item.total = songs.length

  let link = liked ? null : saved.links[item.id]
  // Songs the YouTube Music copy already has, from an earlier import or an interrupted one, aren't
  // added again. A copy that's since been deleted is made again.
  const videos = new Set<string>()
  if (link) {
    const present = await call(() => target.contents(link!.target))
    if (present) present.forEach((v) => videos.add(v))
    else {
      delete saved.links[item.id]
      link = null
    }
  }
  if (!liked && !link) {
    const made = (await call(() => target.newPlaylist(item.title, picked.descriptions[item.id] ?? '')))!
    link = saved.links[item.id] = { target: made, added: [] }
    persist(true)
  }
  if (link) item.target = link.target
  const done = new Set(liked ? saved.liked : link!.added)
  let batch: SourceTrack[] = []

  const flush = async () => {
    if (!batch.length) return
    const ids = batch.map((t) => saved.matches[t.id]!)
    await call(() => target.addSongs(link!.target, ids))
    for (const t of batch) (link!.added.push(t.id), done.add(t.id))
    item.moved += batch.length
    batch = []
    // Saved straight away: songs recorded as added are never added twice, even after a crash.
    persist(true)
    emit()
  }

  await inOrder(
    songs,
    signal,
    async (t) => {
      if (t.id in saved.matches) return saved.matches[t.id]
      // A search that fails isn't recorded, so the song is looked up again next time.
      const m = await call(() => target.findSong(t), true)
      if (m !== undefined) saved.matches[t.id] = m?.videoId ?? null
      return m === undefined ? undefined : (m?.videoId ?? null)
    },
    async (t, videoId) => {
      if (!videoId) {
        count.missing({ id: t.id, title: t.title, artists: t.artists.join(', '), album: t.album || undefined })
      } else if (done.has(t.id) || (!liked && videos.has(videoId))) {
        count.found(t.id)
      } else if (liked) {
        await call(() => target.like(videoId))
        saved.liked.push(t.id)
        done.add(t.id)
        item.moved++
        count.found(t.id)
        persist()
      } else {
        // Counted as done once it's queued for the next batch; if that batch fails, the import
        // stops and counts again on resuming. Songs that turn out to be the same video go in once.
        videos.add(videoId)
        batch.push(t)
        count.found(t.id)
        if (batch.length >= BATCH) await flush()
      }
      count.tick()
      emit()
    }
  )
  await flush()
}

async function moveOthers(item: TransferItem, signal: AbortSignal): Promise<void> {
  const call = guard(signal)
  const count = counter(item)
  const albums = item.kind === 'albums'
  const list: (SourceAlbum | SourceArtist)[] = albums ? picked.albums : picked.artists
  const done = new Set(albums ? saved.albumsSaved : saved.artistsFollowed)
  item.total = list.length
  for (const x of list) {
    signal.throwIfAborted()
    if (!done.has(x.id)) {
      const id = albums ? await call(() => target.findAlbum(x as SourceAlbum), true) : await call(() => target.findArtist(x as SourceArtist), true)
      if (id) {
        await call(() => (albums ? target.saveAlbum(id) : target.follow(id)))
        ;(albums ? saved.albumsSaved : saved.artistsFollowed).push(x.id)
        item.moved++
        count.found(x.id)
      } else
        count.missing(
          albums ? { id: x.id, title: (x as SourceAlbum).title, artists: (x as SourceAlbum).artists.join(', ') } : { id: x.id, title: (x as SourceArtist).name, artists: '' }
        )
    }
    count.tick()
    persist()
    emit()
  }
}

// ---------- fixing songs that weren't found ----------

const song = (itemId: string, trackId: string) => picked.songs[itemId]?.find((t) => t.id === trackId)
// A fix in progress: resuming waits for it, so the two never add at once.
let fixing = false
const settled = () => saved.phase === 'done' || saved.phase === 'stopped'

async function find(itemId: string, trackId: string): Promise<Candidate[]> {
  const t = song(itemId, trackId)
  return t ? target.offers(t) : []
}

async function fix(itemId: string, trackId: string, videoId: string): Promise<void> {
  const item = saved.items?.find((i) => i.id === itemId)
  if (fixing || !item || !settled() || !item.missing.some((m) => m.id === trackId)) return
  fixing = true
  try {
    if (item.kind === 'liked') {
      await target.like(videoId)
      saved.liked.push(trackId)
    } else if (item.kind === 'playlist') {
      const link = saved.links[itemId]
      if (!link) throw new Error('That playlist isn’t on YouTube Music yet. Resume the import first.')
      await target.addSongs(link.target, [videoId])
      link.added.push(trackId)
    } else return
  } finally {
    fixing = false
  }
  saved.matches[trackId] = videoId
  item.missing = item.missing.filter((m) => m.id !== trackId)
  item.moved++
  persist(true)
  emit(true)
}

// ---------- the UI's calls ----------

export const api: TransferApi = {
  state: async () => view(),
  connect,
  cancel: async () => cancel(),
  start: async (s) => start(s),
  stop: async () => stop(),
  resume: async () => resume(),
  reset: async () => reset(),
  disconnect,
  find,
  fix
}
