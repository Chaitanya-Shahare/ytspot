// The YouTube Music side of an import: finding songs, albums and artists, and adding them to the
// signed-in library. Uses the app's own YouTube Music calls (api.ts, player.ts).
import * as yt from '../api'
import { rateVideo, saveToLibrary, subscribe } from '../player'
import { albumScore, artistNameScore, best, queries, SURE, type Candidate, type Match } from './match'
import type { Candidate as Offer, SourceAlbum, SourceArtist, SourceTrack } from '../../shared/transfer'
import type { Track } from '../../shared/types'

// Only the first few results are worth scoring; past them it's other songs.
const LOOK_AT = 8

const asCandidate = (t: Track, video: boolean): Candidate => ({ videoId: t.videoId, title: t.title, artists: t.artists, album: t.album, duration: t.duration, video })

// A song found for a Spotify song: how sure the match is, and what it is (shown when it's worth a check).
export interface Found extends Match {
  song: Offer
}

const offer = (t: Track): Offer => ({ videoId: t.videoId, title: t.title, artists: t.artists, album: t.album, duration: t.duration, thumb: t.thumb })

// The YouTube Music song for a Spotify song, or null. Most songs are found by the first search; for
// the rest, music videos and a search with every artist are tried together.
export async function findSong(song: SourceTrack): Promise<Found | null> {
  const [plain, full] = queries(song)
  // The better of `top` and the best of `list`.
  const better = (top: Found | null, list: Track[], video: boolean): Found | null => {
    const shown = list.slice(0, LOOK_AT)
    const m = best(song, shown.map((t) => asCandidate(t, video)))
    return m && (!top || m.score > top.score) ? { ...m, song: offer(shown.find((t) => t.videoId === m.videoId)!) } : top
  }
  const top = better(null, (await yt.search(plain, 'song')).songs, false)
  if (top && top.score >= SURE) return top
  const [videos, all] = await Promise.all([yt.search(plain, 'video'), full ? yt.search(full, 'song') : null])
  return better(better(top, videos.songs, true), all?.songs ?? [], false)
}

// Songs to choose from when one wasn't found: songs first, then videos.
export async function offers(song: SourceTrack): Promise<Offer[]> {
  const [plain] = queries(song)
  const [songs, videos] = await Promise.all([yt.search(plain, 'song'), yt.search(plain, 'video')])
  const seen = new Set<string>()
  return [...songs.songs.slice(0, 5), ...videos.songs.slice(0, 3)]
    .filter((t) => !seen.has(t.videoId) && !!seen.add(t.videoId))
    .map(offer)
}

export const like = (videoId: string) => rateVideo(videoId, true)
export const unlike = (videoId: string) => rateVideo(videoId, false)

// YouTube Music caps playlist titles at 150 characters and descriptions at 5000.
export const newPlaylist = (title: string, description: string) =>
  yt.createPlaylist(title.slice(0, 150) || 'Untitled playlist', [], 'PRIVATE', description.slice(0, 5000))

export const addSongs = (playlistId: string, videoIds: string[]) => yt.addSongs(playlistId, videoIds)
export const removeSong = (playlistId: string, videoId: string) => yt.removeFromPlaylist(playlistId, videoId)

// The songs (video ids) in a playlist made by an earlier import, or null when it's been deleted since.
export async function contents(playlistId: string): Promise<string[] | null> {
  try {
    await yt.playlist(playlistId, true)
  } catch (e) {
    if (/couldn.t find that playlist|not found|does not exist|404/i.test((e as Error).message)) return null
    throw e
  }
  return (await yt.playlistTracks(playlistId)).map((t) => t.videoId)
}

// The matching album's library id (what "Save to library" saves), or null when YouTube Music
// doesn't have it.
export async function findAlbum(album: SourceAlbum): Promise<string | null> {
  const res = await yt.search(`${album.title} ${album.artists[0] ?? ''}`.trim(), 'album')
  const cards = [...(res.top?.kind === 'album' ? [res.top] : []), ...res.shelves.flatMap((s) => s.cards)].filter((c) => c.kind === 'album')
  const pick = cards
    .slice(0, LOOK_AT)
    .map((c) => ({ c, s: albumScore(album, c) }))
    .sort((a, b) => b.s - a.s)[0]
  if (!pick || pick.s < 0.75) return null
  // Its "Save to library" id, or else its own playlist (the same id, whenever YTM offers both).
  const al = await yt.album(pick.c.id)
  return al.saveId ?? al.playlistId ?? null
}

export const saveAlbum = (saveId: string) => saveToLibrary(saveId, true)

// The matching artist's channel, or null when YouTube Music doesn't have them.
export async function findArtist(artist: SourceArtist): Promise<string | null> {
  const res = await yt.search(artist.name, 'artist')
  const cards = [...(res.top?.kind === 'artist' ? [res.top] : []), ...res.shelves.flatMap((s) => s.cards)].filter((c) => c.kind === 'artist')
  const pick = cards
    .slice(0, 5)
    .map((c) => ({ c, s: artistNameScore(artist.name, c.title) }))
    .sort((a, b) => b.s - a.s)[0]
  return pick && pick.s >= 0.85 && pick.c.id.startsWith('UC') ? pick.c.id : null
}

export const follow = (channelId: string) => subscribe(channelId, true)
