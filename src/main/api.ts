// YouTube Music data via youtubei.js (InnerTube), mapped to the small DTOs in shared/types.
// youtubei.js node classes are a wide union; we read them structurally, so `any` is used
// deliberately for parser nodes in this file only.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Innertube } from 'youtubei.js'
import type { YTMusic } from 'youtubei.js'
import type {
  ArtistPage,
  Card,
  Collection,
  HomeData,
  Kind,
  More,
  LibraryFilter,
  SearchFilter,
  SearchResult,
  Shelf,
  Track
} from '../shared/types'

type Playlist = YTMusic.Playlist

let yt: Innertube | null = null

export async function connect(cookie?: string): Promise<void> {
  yt = await Innertube.create({ cookie, retrieve_player: false })
  homeFeed = null
}

export const ready = () => yt !== null

function api(): Innertube {
  if (!yt) throw new Error('YouTube Music session not ready')
  return yt
}

const text = (t: any): string => (t ? String(t.toString?.() ?? t.text ?? '') : '')

function thumb(list: any): string {
  const arr = Array.isArray(list) ? list : list?.contents
  const url: string = arr?.length ? arr[arr.length - 1].url : ''
  return url.replace(/=w\d+-h\d+/, '=w544-h544')
}

function findKey(obj: any, key: string, depth = 0): string | undefined {
  if (!obj || typeof obj !== 'object' || depth > 8) return undefined
  if (typeof obj[key] === 'string') return obj[key]
  for (const v of Object.values(obj)) {
    const hit = findKey(v, key, depth + 1)
    if (hit) return hit
  }
  return undefined
}

function kindOf(t?: string): Kind {
  if (t === 'song' || t === 'video' || t === 'album' || t === 'playlist') return t
  if (t === 'artist' || t === 'library_artist') return 'artist'
  return 'other'
}

function toTrack(n: any): Track | null {
  const videoId = n.id ?? findKey(n.endpoint, 'videoId') ?? findKey(n.overlay, 'videoId')
  if (!videoId || n.type !== 'MusicResponsiveListItem') return null
  const people = n.artists ?? n.authors ?? (n.author ? [n.author] : [])
  return {
    videoId,
    title: n.title ?? text(n.name),
    artists: people.map((a: any) => a.name).join(', '),
    artistId: people[0]?.channel_id,
    album: n.album?.name,
    albumId: n.album?.id,
    duration: n.duration?.text ?? '',
    thumb: thumb(n.thumbnail),
    plays: n.flex_columns?.map((c: any) => text(c.title)).find((t: string) => /\bplays?$/.test(t))
  }
}

function toCard(n: any): Card | null {
  if (n.type === 'MusicTwoRowItem') {
    const kind = kindOf(n.item_type)
    const id = n.id ?? findKey(n.endpoint, 'videoId') ?? findKey(n.endpoint, 'browseId')
    if (!id) return null
    const song = kind === 'song' || kind === 'video'
    return {
      kind,
      id,
      title: text(n.title),
      subtitle: song ? `${kind === 'video' ? 'Video' : 'Song'} • ${text(n.subtitle)}` : text(n.subtitle),
      thumb: thumb(n.thumbnail),
      playlistId: findKey(n.thumbnail_overlay, 'playlistId') ?? findKey(n.endpoint, 'playlistId')
    }
  }
  if (n.type === 'MusicResponsiveListItem') {
    const kind = kindOf(n.item_type)
    // Library artists link to "MPLA" + channel id (YTM's library view of them); open the artist.
    const id = (n.id ?? findKey(n.endpoint, 'browseId'))?.replace(/^MPLA(?=UC)/, '')
    if (!id) return null
    const people = n.artists ?? n.authors ?? []
    const song = kind === 'song' || kind === 'video'
    // Filtered search rows carry "Album • Artist • 2024" in the second column instead of a subtitle.
    const sub = text(n.subtitle) || text(n.flex_columns?.[1]?.title) || people.map((a: any) => a.name).join(', ')
    return {
      kind,
      id,
      title: n.title ?? n.name ?? text(n.flex_columns?.[0]?.title),
      subtitle: song && !/^(Song|Video)\b/.test(sub) ? `${kind === 'video' ? 'Video' : 'Song'} • ${sub}` : sub,
      thumb: thumb(n.thumbnail),
      playlistId: findKey(n.overlay, 'playlistId')
    }
  }
  return null
}

const cards = (items: any[] = []): Card[] =>
  items.map(toCard).filter((c): c is Card => !!c)
const tracks = (items: any[] = []): Track[] =>
  items.map(toTrack).filter((t): t is Track => !!t)

function moreOf(s: any): More | undefined {
  const p = (s.header?.more_content ?? s.header)?.endpoint?.payload ?? s.bottom_endpoint?.payload ?? s.endpoint?.payload
  return p?.browseId ? { browseId: p.browseId, params: p.params } : undefined
}

function shelfOf(s: any): Shelf | null {
  if (s.type !== 'MusicCarouselShelf' && s.type !== 'MusicShelf') return null
  const title = text(s.header?.title ?? s.title)
  const c = cards(s.contents)
  return c.length ? { title, cards: c, more: moreOf(s) } : null
}

// A shelf's "Show all" page: everything in its grid.
export async function browseMore(more: More): Promise<Card[]> {
  const res: any = await api().actions.execute('/browse', { browseId: more.browseId, params: more.params, client: 'YTMUSIC', parse: true })
  const items = (res.contents_memo?.get('Grid') ?? []).flatMap((g: any) => g.items ?? [])
  const rows = (res.contents_memo?.get('MusicShelf') ?? []).flatMap((s: any) => s.contents ?? [])
  return cards([...items, ...rows])
}

// The unfiltered feed, kept so a mood chip ("Relax", "Workout", …) can be applied to it.
let homeFeed: YTMusic.HomeFeed | null = null

export async function home(chip?: string): Promise<HomeData> {
  const client = api()
  // A feed that arrives after signing in or out belongs to the old session; don't keep it.
  const current = () => {
    if (yt !== client) throw new Error('YouTube Music session changed, try again')
  }
  if (!chip || !homeFeed) {
    const fresh = await client.music.getHomeFeed()
    current()
    homeFeed = fresh
  }
  // The chip may not exist in this session's feed (e.g. after switching accounts): show All.
  const feed = chip && homeFeed.filters.includes(chip) ? await homeFeed.applyFilter(chip) : homeFeed
  current()
  // The second page is optional; YTM sometimes returns it empty, which youtubei.js throws on.
  const more = feed.has_continuation ? await feed.getContinuation().catch(() => null) : null
  return {
    // Podcasts aren't playable here, so that chip is left out.
    chips: homeFeed.filters.filter((f) => f !== 'Podcasts'),
    shelves: [...(feed.sections ?? []), ...(more?.sections ?? [])].map(shelfOf).filter((s): s is Shelf => !!s)
  }
}

export async function explore(): Promise<Shelf[]> {
  const ex = await api().music.getExplore()
  return ex.sections.map(shelfOf).filter((s): s is Shelf => !!s)
}

// "Browse all" tiles for the search page: YTM's Moods & genres.
export async function moods(): Promise<{ title: string; tiles: { title: string; params: string }[] }[]> {
  const res: any = await api().actions.execute('/browse', { browseId: 'FEmusic_moods_and_genres', client: 'YTMUSIC', parse: true })
  return (res.contents_memo?.get('Grid') ?? []).map((g: any) => ({
    title: text(g.header?.title),
    tiles: (g.items ?? [])
      .filter((b: any) => b.type === 'MusicNavigationButton')
      .map((b: any) => ({ title: b.button_text, params: b.endpoint?.payload?.params }))
  }))
}

export async function mood(params: string): Promise<Shelf[]> {
  const res: any = await api().actions.execute('/browse', {
    browseId: 'FEmusic_moods_and_genres_category',
    params,
    client: 'YTMUSIC',
    parse: true
  })
  const shelves = (res.contents_memo?.get('MusicCarouselShelf') ?? []).map(shelfOf)
  const grids = (res.contents_memo?.get('Grid') ?? []).map((g: any) => {
    const c = cards(g.items)
    return c.length ? { title: text(g.header?.title), cards: c } : null
  })
  return [...shelves, ...grids].filter((x): x is Shelf => !!x)
}

export async function addToPlaylist(playlistId: string, videoId: string): Promise<void> {
  await api().playlist.addVideos(playlistId.replace(/^VL/, ''), [videoId])
}

// youtubei.js finds the entry by video id and refuses playlists you can't edit.
export async function removeFromPlaylist(playlistId: string, videoId: string): Promise<void> {
  await api().playlist.removeVideos(playlistId.replace(/^VL/, ''), [videoId])
}

export async function library(filter: LibraryFilter): Promise<Card[]> {
  let lib = await api().music.getLibrary()
  if (lib.filters.includes(filter)) lib = await lib.applyFilter(filter)
  const items = (lib.contents ?? []).flatMap((s: any) => s.items ?? s.contents ?? [])
  return cards(items).filter((c) => c.kind !== 'other' && c.kind !== 'song')
}

function header(h: any): { title: string; subtitle: string; meta: string; thumb: string; owner?: string; ownerId?: string } {
  if (h?.type === 'MusicEditablePlaylistDetailHeader') h = h.header
  // The strapline is the album's artist (or the playlist's owner), linked to their channel.
  const owner = text(h?.strapline_text_one).replace(/^N\/A$/, '')
  return {
    title: text(h?.title),
    subtitle: text(h?.subtitle),
    meta: text(h?.second_subtitle),
    thumb: thumb(h?.thumbnail ?? h?.thumbnails),
    owner: owner || undefined,
    ownerId: findKey(h?.strapline_text_one, 'browseId')
  }
}

// Long playlists (Liked Songs can be 1000+) return their first page immediately; the renderer
// pulls the rest with playlistMore(id, have). Pages are fetched one at a time per playlist and
// accumulated here, so a repeated or concurrent call never skips or duplicates tracks.
const pending = new Map<string, { pl: Playlist; tracks: Track[]; busy?: Promise<void> }>()

export async function playlist(id: string): Promise<Collection> {
  const pl = await api().music.getPlaylist(id)
  const first = tracks(pl.items as any[])
  if (!pl.header && !first.length) throw new Error('Couldn’t find that playlist. It may have been deleted or made private.')
  pending.set(id, { pl, tracks: [...first] })
  return {
    kind: 'playlist',
    id,
    playlistId: id.replace(/^VL/, ''),
    ...header(pl.header),
    tracks: first,
    more: pl.has_continuation
  }
}

export async function playlistMore(id: string, have: number): Promise<{ tracks: Track[]; more: boolean }> {
  const p = pending.get(id)
  if (!p) return { tracks: [], more: false }
  await p.busy
  if (p.tracks.length <= have && p.pl.has_continuation) {
    // A failed page is retried by the next call instead of failing every call after it.
    p.busy = p.pl
      .getContinuation()
      .then((next) => {
        p.pl = next
        p.tracks.push(...tracks(next.items as any[]))
      })
      .finally(() => (p.busy = undefined))
    await p.busy
  }
  const more = p.pl.has_continuation
  // Fully loaded: the renderer has every track cached, so drop youtubei.js's page objects.
  if (!more) pending.delete(id)
  return { tracks: p.tracks.slice(have), more }
}

export async function account(): Promise<{ name: string; photo: string } | null> {
  const all = await api().account.getInfo(true)
  const me: any = all.find((a: any) => a.is_selected) ?? all[0]
  return me ? { name: text(me.account_name), photo: thumb(me.account_photo) } : null
}

export async function createPlaylist(title: string): Promise<string> {
  const res = await api().playlist.create(title, [], 'PRIVATE')
  if (!res.playlist_id) throw new Error('YouTube did not return a playlist id')
  return `VL${res.playlist_id}`
}

export async function album(id: string): Promise<Collection> {
  const al = await api().music.getAlbum(id)
  const h = header(al.header)
  return {
    kind: 'album',
    id,
    ...h,
    playlistId: findKey(al.contents?.[0], 'playlistId') ?? findKey(al.header, 'playlistId'),
    // Album rows usually leave out the artist when it's the album's own.
    tracks: tracks(al.contents).map((t) => ({
      ...t,
      album: t.album ?? h.title,
      albumId: t.albumId ?? id,
      artists: t.artists || h.owner || '',
      artistId: t.artistId ?? h.ownerId
    }))
  }
}

export async function artist(id: string): Promise<ArtistPage> {
  const ar = await api().music.getArtist(id)
  const h: any = ar.header
  const songShelf: any = ar.sections.find((s: any) => s.type === 'MusicShelf')
  return {
    id,
    title: text(h?.title),
    thumb: thumb(h?.thumbnail ?? h?.foreground_thumbnail),
    description: text(h?.description).replace(/^N\/A$/, ''),
    subscribed: !!h?.subscription_button?.subscribed,
    songs: tracks(songShelf?.contents),
    songsMore: songShelf ? moreOf(songShelf) : undefined,
    shelves: ar.sections.map(shelfOf).filter((s): s is Shelf => !!s && s.title !== text(songShelf?.title))
  }
}

export async function search(query: string, filter: SearchFilter = 'all'): Promise<SearchResult> {
  const res = await api().music.search(query, filter === 'all' ? undefined : { type: filter })
  const out: SearchResult = { songs: [], shelves: [] }
  // YTM returns a top-result card plus either titled shelves or a flat mixed list of single-item sections.
  const items: any[] = []
  for (const s of (res.contents ?? []) as any[]) {
    if (s.type === 'MusicCardShelf') {
      const id = findKey(s.on_tap, 'videoId') ?? findKey(s.on_tap, 'browseId')
      if (id)
        out.top = {
          kind: findKey(s.on_tap, 'videoId') ? 'song' : guessKind(id),
          id,
          title: text(s.title),
          subtitle: text(s.subtitle),
          thumb: thumb(s.thumbnail)
        }
    }
    items.push(...(s.contents ?? []))
  }
  out.songs = tracks(items.filter((n) => n.item_type === 'song' || n.item_type === 'video'))
  const groups: [string, Kind][] = [['Artists', 'artist'], ['Albums', 'album'], ['Playlists', 'playlist']]
  const all = cards(items)
  for (const [title, kind] of groups) {
    const c = all.filter((x) => x.kind === kind && x.id !== out.top?.id)
    if (c.length) out.shelves.push({ title, cards: c })
  }
  return out
}

function guessKind(browseId: string): Kind {
  if (browseId.startsWith('MPRE')) return 'album'
  if (browseId.startsWith('UC')) return 'artist'
  if (browseId.startsWith('VL')) return 'playlist'
  return 'other'
}

// YTM's own lyrics (Musixmatch/LyricFind): plain text, no timings.
export async function ytmLyrics(videoId: string): Promise<{ text: string; source: string } | null> {
  // youtubei.js throws when a song simply has no lyrics tab; only a request failure is an error.
  const shelf: any = await api()
    .music.getLyrics(videoId)
    .catch((e: Error) => {
      if (/fetch|network|timed? ?out|ENOTFOUND|ECONN/i.test(e.message)) throw e
    })
  const body = text(shelf?.description).trim()
  return body ? { text: body, source: text(shelf?.footer).replace(/^Source:\s*/, '') } : null
}
