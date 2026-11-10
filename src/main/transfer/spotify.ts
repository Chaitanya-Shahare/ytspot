// Reading a Spotify library the way Spotify's own web player does. Spotify's public Web API turns
// away apps without a registered (and approved) developer account, so instead the user logs in to
// open.spotify.com in a window here, and the library is read through the same API the web player
// uses, with the web player's own access token. No server of ours is involved, and nothing runs
// until the user starts an import: the windows below exist only while logging in or reading.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { app, BrowserWindow, session, type Session } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SourceAlbum, SourceArtist, SourcePlaylist, SourceTrack } from '../../shared/transfer'

const OPEN = 'https://open.spotify.com/'
const LOGIN = `https://accounts.spotify.com/login?continue=${encodeURIComponent(OPEN)}`
const PATHFINDER = 'https://api-partner.spotify.com/pathfinder/v2/query'
// Its own partition: a Spotify login never mixes with the YouTube one, and forgetting it is one call.
const PARTITION = 'spotify'
const ses = (): Session => session.fromPartition(`persist:${PARTITION}`)

// The web player's queries are stored on Spotify's side and named by a hash, which changes when
// Spotify ships a new web player. The current hashes are read from the web player's script each
// time; these are the ones it had when this was written, in case that fails.
const OPS = {
  profileAttributes: '08ffb4730af3746e04a8301396f20875dbbce10c75243803091a9274eacc8ac0',
  libraryV3: '390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455',
  fetchLibraryTracks: '087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240',
  fetchPlaylist: '21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf'
}
type Op = keyof typeof OPS

// Google's and Spotify's login pages turn away browsers that say they're Electron.
const chromeAgent = (ua: string) => ua.replace(/ Electron\/\S+/, '').replace(/ ytspot\/\S+/, '')

export class SignedOut extends Error {
  constructor() {
    super('Your Spotify login has expired. Connect again.')
  }
}

// Spotify wouldn't give this one thing (a playlist that's been taken down, say), but is otherwise fine.
class Unreadable extends Error {}

// Never connected means no partition on disk yet; asking the session would create one.
export async function signedIn(): Promise<boolean> {
  if (!existsSync(join(app.getPath('userData'), 'Partitions', PARTITION))) return false
  return (await ses().cookies.get({ url: OPEN, name: 'sp_dc' })).some((c) => !!c.value)
}

// Opens Spotify's login page; resolves true once logged in, false if the window was closed first.
let login: { win: BrowserWindow; done: Promise<boolean> } | null = null
export function logIn(): Promise<boolean> {
  if (login) {
    login.win.focus()
    return login.done
  }
  const win = new BrowserWindow({ width: 480, height: 760, title: 'Log in to Spotify', webPreferences: { session: ses() } })
  win.webContents.setUserAgent(chromeAgent(win.webContents.getUserAgent()))
  // "Continue with Google/Apple/Facebook" open their own windows; they share the login session and
  // close with it.
  const popups = new Set<BrowserWindow>()
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { width: 480, height: 700, webPreferences: { session: ses() } }
  }))
  win.webContents.on('did-create-window', (popup) => (popups.add(popup), popup.on('closed', () => popups.delete(popup))))
  const done = new Promise<boolean>((resolve) => {
    const onCookie = (_: unknown, c: Electron.Cookie, __: string, removed: boolean) => {
      if (c.name === 'sp_dc' && c.value && !removed) finish(true)
    }
    const finish = (ok: boolean) => {
      ses().cookies.removeListener('changed', onCookie)
      login = null
      for (const p of popups) if (!p.isDestroyed()) p.destroy()
      if (!win.isDestroyed()) win.destroy()
      resolve(ok)
    }
    ses().cookies.on('changed', onCookie)
    win.on('closed', () => finish(false))
  })
  login = { win, done }
  win.loadURL(LOGIN).catch(() => undefined) // a failed load shows in the window itself
  return done
}

// Closes the login window, if it's open (its logIn() resolves false).
export function cancelLogIn(): void {
  login?.win.close()
}

export async function logOut(): Promise<void> {
  cancelLogIn()
  await ses().clearStorageData()
  await ses().clearCache()
}

// The headers the web player sends with its API calls (its access token, among others), and the
// current query hashes. Taken from a hidden copy of the web player that's closed straight after.
interface Auth {
  headers: Record<string, string>
  ops: Record<Op, string>
}

const TOKEN_WAIT_MS = 30000

async function authorize(signal: AbortSignal): Promise<Auth> {
  const s = ses()
  const win = new BrowserWindow({ show: false, webPreferences: { session: s, backgroundThrottling: false } })
  const page = win.webContents
  page.setAudioMuted(true)
  page.setUserAgent(chromeAgent(page.getUserAgent()))
  let script = ''
  try {
    const headers = await new Promise<Record<string, string>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Spotify didn’t respond. Check your internet connection and try again.')), TOKEN_WAIT_MS)
      signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true })
      // Nobody sees this page: skip its pictures, video and fonts.
      s.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
        if (d.webContentsId === page.id && /\/web-player\/web-player\.[0-9a-f]+\.js$/.test(d.url)) script = d.url
        cb({ cancel: d.webContentsId === page.id && ['image', 'media', 'font'].includes(d.resourceType) })
      })
      s.webRequest.onBeforeSendHeaders({ urls: ['https://api-partner.spotify.com/*'] }, (d, cb) => {
        const h = Object.fromEntries(Object.entries(d.requestHeaders).map(([k, v]) => [k.toLowerCase(), v]))
        if (h.authorization && h['client-token']) {
          clearTimeout(timer)
          resolve(h)
        }
        cb({ requestHeaders: d.requestHeaders })
      })
      page.on('did-fail-load', (_, code, desc, url, main) => {
        if (main && code !== -3) {
          clearTimeout(timer)
          reject(new Error(`Couldn’t reach Spotify (${desc}). Check your internet connection and try again.`))
        }
      })
      // Failures are reported by did-fail-load above (and destroying the window mid-load rejects too).
      win.loadURL(OPEN).catch(() => undefined)
    })
    return {
      headers: {
        authorization: headers.authorization,
        'client-token': headers['client-token'],
        'spotify-app-version': headers['spotify-app-version'] ?? '',
        'app-platform': headers['app-platform'] ?? 'WebPlayer',
        'user-agent': headers['user-agent'] ?? '',
        'accept-language': headers['accept-language'] ?? 'en',
        'content-type': 'application/json;charset=UTF-8',
        accept: 'application/json',
        origin: 'https://open.spotify.com',
        referer: OPEN
      },
      ops: await currentOps(script)
    }
  } finally {
    s.webRequest.onBeforeRequest(null)
    s.webRequest.onBeforeSendHeaders(null)
    win.destroy()
    // The web player's scripts and styles aren't needed again until the next import.
    s.clearCache().catch(() => undefined)
  }
}

async function currentOps(script: string): Promise<Record<Op, string>> {
  const ops = { ...OPS }
  if (!script) return ops
  try {
    const js = await (await fetch(script, { signal: AbortSignal.timeout(20000) })).text()
    for (const name of Object.keys(ops) as Op[]) {
      const hash = js.match(new RegExp(`"${name}","query","([0-9a-f]{64})"`))?.[1]
      if (hash) ops[name] = hash
    }
  } catch {
    // The hashes above may still be current.
  }
  return ops
}

// Queries in flight at once, across everything being read in parallel.
const IN_FLIGHT = 6

class Client {
  private auth: Promise<Auth> | null = null
  private running = 0
  private queue: (() => void)[] = []
  constructor(private signal: AbortSignal) {}

  private async slot(): Promise<() => void> {
    if (this.running >= IN_FLIGHT) await new Promise<void>((r) => this.queue.push(r))
    this.running++
    return () => {
      this.running--
      this.queue.shift()?.()
    }
  }

  private authorized(): Promise<Auth> {
    this.auth ??= authorize(this.signal).catch((e) => {
      this.auth = null
      throw e
    })
    return this.auth
  }

  // One query, retried when Spotify is busy, the connection drops, or the token runs out.
  async query(op: Op, variables: object): Promise<any> {
    let renewed = false
    for (let n = 1; ; n++) {
      this.signal.throwIfAborted()
      const pending = this.authorized()
      const auth = await pending
      let res: Response
      const release = await this.slot()
      try {
        res = await fetch(PATHFINDER, {
          method: 'POST',
          headers: auth.headers,
          body: JSON.stringify({ variables, operationName: op, extensions: { persistedQuery: { version: 1, sha256Hash: auth.ops[op] } } }),
          signal: AbortSignal.any([this.signal, AbortSignal.timeout(20000)])
        })
      } catch (e) {
        release()
        if (this.signal.aborted || n >= 4) throw this.signal.aborted ? e : new Error('Lost the connection to Spotify. Check your internet connection and try again.')
        await wait(1000 * n, this.signal)
        continue
      }
      // The body is read inside the slot too: a slow answer still counts as in flight.
      const json: any = res.ok ? await res.json().finally(release) : (release(), await res.body?.cancel(), null)
      if (res.status === 401 && !renewed) {
        renewed = true
        // Several queries can see the token expire at once; only one fetches a new one.
        if (this.auth === pending) this.auth = null
        continue
      }
      if ((res.status === 429 || res.status >= 500) && n < 6) {
        const after = Number(res.headers.get('retry-after'))
        await wait(Math.min(30, after > 0 ? after : 2 ** n) * 1000, this.signal)
        continue
      }
      if (!res.ok) {
        const message = `Spotify answered ${res.status}. Try again in a while.`
        // Refused or gone is about this one query; a login that's still refused after renewing isn't.
        throw [400, 403, 404, 410].includes(res.status) ? new Unreadable(message) : new Error(message)
      }
      const error = json.errors?.[0]?.message as string | undefined
      if (error) console.error('[transfer] spotify', op, error)
      if (error && /not authorized/i.test(error) && json.data?.me === null) throw new SignedOut()
      if (error && /PersistedQueryNotFound/i.test(error)) throw new Error('Spotify changed its web player. Update ytspot to import.')
      // An answer with only errors (a partial one still has data) shouldn't read as an empty library.
      if (error && !json.data) throw new Unreadable('Spotify couldn’t read your library. Try again in a while.')
      return json.data
    }
  }
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true })
  })

// Runs `fn` over `list`, `n` at a time, keeping the results in order.
async function pool<T, R>(list: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, list.length) }, async () => {
      while (next < list.length) {
        const i = next++
        out[i] = await fn(list[i])
      }
    })
  )
  return out
}

// The largest artwork Spotify offers.
const art = (sources: any): string => {
  const list: any[] = sources?.sources ?? sources ?? []
  return list.reduce((top: any, s: any) => (!top || (s.width ?? 0) > (top.width ?? 0) ? s : top), null)?.url ?? ''
}

function trackOf(wrapper: any): SourceTrack | null {
  const d = wrapper?.data
  const id: string = d?.uri ?? wrapper?._uri ?? ''
  // Podcast episodes, local files and tracks Spotify no longer has.
  if (d?.__typename !== 'Track' || !id.startsWith('spotify:track:') || !d.name) return null
  return {
    id,
    title: d.name,
    artists: (d.artists?.items ?? []).map((a: any) => a?.profile?.name).filter(Boolean),
    album: d.albumOfTrack?.name ?? '',
    ms: d.trackDuration?.totalMilliseconds ?? d.duration?.totalMilliseconds ?? 0
  }
}

// Spotify playlist descriptions are HTML ("<a href=spotify:…>").
const plain = (html = '') =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/')
    .trim()

export interface SourcePlaylistFull extends SourcePlaylist {
  description: string
  tracks: SourceTrack[]
}

export interface SourceLibrary {
  account: string
  liked: SourceTrack[] // newest first, as Spotify lists them
  playlists: SourcePlaylistFull[]
  albums: SourceAlbum[]
  artists: SourceArtist[]
  unread: string[] // playlists Spotify wouldn't hand over (their titles)
}

const PAGE = 50
const PLAYLIST_PAGE = 100

// Everything in the library: Liked Songs, playlists (with their songs), saved albums and followed
// artists. `found` reports the running song count.
export async function readLibrary(signal: AbortSignal, found: (songs: number) => void): Promise<SourceLibrary> {
  // Everything below is read at once; if one part fails, the rest stop too.
  const stop = new AbortController()
  const quit = () => stop.abort(signal.reason)
  signal.addEventListener('abort', quit, { once: true })
  const api = new Client(stop.signal)
  let songs = 0
  const count = (n: number) => found((songs += n))
  try {
    // Signed in? (This also starts the hidden web player, which every call below shares.)
    const profile = await api.query('profileAttributes', {})
    if (!profile?.me) throw new SignedOut()
    const account: string = profile.me.profile?.name ?? profile.me.profile?.username ?? ''
    const unread: string[] = []
    const [liked, playlists, albums, artists] = await Promise.all([
      readLiked(api, count),
      readShelf(api, 'Playlists').then((items) => readPlaylists(api, items.flatMap(playlistOf), count, unread)),
      readShelf(api, 'Albums').then((items) => items.flatMap(albumOf)),
      readShelf(api, 'Artists').then((items) => items.flatMap(artistOf))
    ])
    return { account, liked, playlists, albums, artists, unread }
  } catch (e) {
    stop.abort(e)
    throw signal.aborted ? signal.reason : e
  } finally {
    signal.removeEventListener('abort', quit)
  }
}

// Playlists with their songs, a few at a time. One Spotify won't hand over is left out (and named
// in `unread`) rather than failing the whole library; empty ones are left out too.
async function readPlaylists(api: Client, list: Omit<SourcePlaylistFull, 'tracks'>[], count: (n: number) => void, unread: string[]): Promise<SourcePlaylistFull[]> {
  const read = await pool(list, 4, async (p): Promise<SourcePlaylistFull | null> => {
    try {
      const tracks = await readPlaylist(api, p.id, count)
      return { ...p, tracks, count: tracks.length }
    } catch (e) {
      if (!(e instanceof Unreadable)) throw e
      unread.push(p.title)
      return null
    }
  })
  return read.filter((p): p is SourcePlaylistFull => !!p?.tracks.length)
}

async function readLiked(api: Client, count: (n: number) => void): Promise<SourceTrack[]> {
  const page = async (offset: number) => (await api.query('fetchLibraryTracks', { offset, limit: PAGE }))?.me?.library?.tracks
  const first = await page(0)
  const total: number = first?.totalCount ?? 0
  const offsets = Array.from({ length: Math.max(0, Math.ceil(total / PAGE) - 1) }, (_, i) => (i + 1) * PAGE)
  const pages = [first, ...(await pool(offsets, 4, page))]
  const tracks = pages.flatMap((p) => (p?.items ?? []).map((i: any) => trackOf(i.track)).filter(Boolean)) as SourceTrack[]
  count(tracks.length)
  return dedupe(tracks)
}

// One shelf of "Your Library" (Playlists, Albums or Artists), folders opened up. Asked for the way
// the web player lists it, a folder at a time.
async function readShelf(api: Client, filter: 'Playlists' | 'Albums' | 'Artists', folderUri: string | null = null, depth = 0): Promise<any[]> {
  const out: any[] = []
  for (let offset = 0; ; offset += PAGE) {
    const data = await api.query('libraryV3', {
      filters: [filter],
      order: null,
      textFilter: null,
      features: ['LIKED_SONGS', 'YOUR_EPISODES_V2', 'PRERELEASES', 'PRERELEASES_V2', 'EVENTS'],
      limit: PAGE,
      offset,
      flatten: false,
      expandedFolders: [],
      folderUri,
      includeFoldersWhenFlattening: true
    })
    const lib = data?.me?.libraryV3
    if (lib?.__typename && lib.__typename !== 'LibraryPage') throw new Error('Spotify couldn’t list your library. Try again in a while.')
    const items: any[] = lib?.items ?? []
    for (const it of items) {
      const item = it?.item
      if (item?.__typename === 'LibraryFolderResponseWrapper' && depth < 4) out.push(...(await readShelf(api, filter, item._uri ?? item.data?.uri, depth + 1)))
      else if (item) out.push(item)
    }
    if (!items.length || offset + items.length >= (lib?.totalCount ?? 0)) return out
  }
}

function playlistOf(item: any): Omit<SourcePlaylistFull, 'tracks'>[] {
  const d = item?.data
  const id: string = d?.uri ?? item?._uri ?? ''
  if (item?.__typename !== 'PlaylistResponseWrapper' || d?.__typename !== 'Playlist' || !id.startsWith('spotify:playlist:')) return []
  return [
    {
      id,
      title: d.name || 'Untitled playlist',
      owner: d.ownerV2?.data?.name ?? '',
      thumb: art(d.images?.items?.[0]),
      description: plain(d.description),
      count: 0
    }
  ]
}

function albumOf(item: any): SourceAlbum[] {
  const d = item?.data
  if (item?.__typename !== 'AlbumResponseWrapper' || d?.__typename !== 'Album') return []
  return [{ id: d.uri ?? item._uri, title: d.name, artists: (d.artists?.items ?? []).map((a: any) => a?.profile?.name).filter(Boolean), thumb: art(d.coverArt) }]
}

function artistOf(item: any): SourceArtist[] {
  const d = item?.data
  if (item?.__typename !== 'ArtistResponseWrapper' || d?.__typename !== 'Artist') return []
  return [{ id: d.uri ?? item._uri, name: d.profile?.name ?? '', thumb: art(d.visuals?.avatarImage) }].filter((a) => a.name)
}

async function readPlaylist(api: Client, uri: string, count: (n: number) => void, about?: (first: any) => void): Promise<SourceTrack[]> {
  const page = async (offset: number) => (await api.query('fetchPlaylist', { uri, offset, limit: PLAYLIST_PAGE, enableWatchFeedEntrypoint: false }))?.playlistV2
  const first = await page(0)
  // Taken down, made private, or never there: Spotify answers with a stand-in ("NotFound") instead.
  if (first?.__typename && first.__typename !== 'Playlist') throw new Unreadable(`Spotify couldn’t open this playlist (${first.__typename}).`)
  about?.(first)
  const total: number = first?.content?.totalCount ?? 0
  const offsets = Array.from({ length: Math.max(0, Math.ceil(total / PLAYLIST_PAGE) - 1) }, (_, i) => (i + 1) * PLAYLIST_PAGE)
  const pages = [first, ...(await pool(offsets, 2, page))]
  const tracks = pages.flatMap((p) => (p?.content?.items ?? []).map((i: any) => trackOf(i.itemV2)).filter(Boolean)) as SourceTrack[]
  count(tracks.length)
  return tracks
}

const dedupe = (tracks: SourceTrack[]) => {
  const seen = new Set<string>()
  return tracks.filter((t) => !seen.has(t.id) && !!seen.add(t.id))
}

// Public playlists, without logging in (Spotify's web player works signed out too). Test runs use
// these as a stand-in library (fixture.ts).
export async function readPublicPlaylists(uris: string[], signal: AbortSignal, count: (n: number) => void): Promise<{ playlists: SourcePlaylistFull[]; unread: string[] }> {
  const api = new Client(signal)
  const unread: string[] = []
  const list = uris.map((uri) => ({ id: uri, title: uri, owner: '', thumb: '', description: '', count: 0 }))
  const read = await pool(list, 4, async (p): Promise<SourcePlaylistFull | null> => {
    let meta: any = null
    try {
      const tracks = await readPlaylist(api, p.id, count, (first) => (meta = first))
      if (!meta) throw new Unreadable('No such playlist')
      return { ...p, title: meta.name || 'Untitled playlist', owner: meta.ownerV2?.data?.name ?? '', thumb: art(meta.images?.items?.[0]), description: plain(meta.description), count: tracks.length, tracks }
    } catch (e) {
      if (!(e instanceof Unreadable)) throw e
      unread.push(p.id)
      return null
    }
  })
  return { playlists: read.filter((p): p is SourcePlaylistFull => !!p), unread }
}
