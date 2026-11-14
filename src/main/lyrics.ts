// Lyrics for the playing song: time-synced lines from LRCLIB (an open lyrics database, also used
// by Pear Desktop), falling back to YouTube Music's own plain lyrics.
import type { Lyrics } from '../shared/types'
import { ytmLyrics } from './api'

export interface LyricsQuery {
  videoId: string
  title: string
  artist: string
  album: string
  duration: number
}

interface LrclibHit {
  duration: number
  instrumental: boolean
  plainLyrics: string | null
  syncedLyrics: string | null
}

const LRCLIB = 'https://lrclib.net/api'
const HEADERS = { 'User-Agent': 'ytspot (https://github.com/Chaitanya-Shahare/ytspot)' }

async function lrclib(path: string, params: Record<string, string>): Promise<unknown> {
  const res = await fetch(`${LRCLIB}/${path}?${new URLSearchParams(params)}`, { headers: HEADERS, signal: AbortSignal.timeout(8000) })
  return res.ok ? res.json() : null
}

// Music videos and uploads carry decorations LRCLIB's exact match won't find.
const NOISE = /\s*[([][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|remaster(ed)?|hd|4k|mv|m\/v|slowed|reverb|sped|lo-?fi|nightcore|8d)\b[^)\]]*[)\]]/gi
// Slowed / sped-up edits run on a different clock than the original, so its timings don't apply.
const ALTERED = /\b(slowed|reverb|sped[ -]?up|nightcore|8d audio)\b/i
const cleanTitle = (t: string) => t.replace(NOISE, '').replace(/\s+(ft\.?|feat\.?)\s.*$/i, '').trim()
const cleanArtist = (a: string) => a.replace(/\s*-\s*Topic$|VEVO$/i, '').trim()
// The artist as given, then only the first of several ("A, B & C"): the full name first, so a duo
// or band ("Simon & Garfunkel", "Earth, Wind & Fire") isn't matched to another artist's entry
// under the first word ("Simon", "Earth"), often a cover or a copy timed differently.
const artistNames = (a: string) => [...new Set([cleanArtist(a), cleanArtist(a.split(/,|&| x | and /i)[0])])].filter(Boolean)

// "[01:23.45] text" lines; untimed lines (credits, blanks) are dropped.
function parseLrc(lrc: string): Lyrics['lines'] {
  const out: Lyrics['lines'] = []
  for (const line of lrc.split('\n')) {
    const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/)
    if (m) out.push({ time: Number(m[1]) * 60 + Number(m[2]), text: m[3].trim() })
  }
  return out
}

async function fromLrclib(q: LyricsQuery, altered: boolean): Promise<LrclibHit | null> {
  let title = cleanTitle(q.title)
  let artists = artistNames(q.artist)
  // "Artist - Title" uploads.
  const dash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/)
  if (dash && !q.album) [artists, title] = [artistNames(dash[1]), dash[2]]
  // A 404 is "no lyrics"; a network failure throws, so the caller can tell the two apart. The names
  // are asked at once, but a synced match under the full name wins over one under the first.
  const exacts = (await Promise.all(
    artists.map((artist) =>
      lrclib('get', {
        track_name: title,
        artist_name: artist,
        ...(q.album ? { album_name: q.album } : {}),
        ...(q.duration && !altered ? { duration: String(Math.round(q.duration)) } : {})
      })
    )
  )) as (LrclibHit | null)[]
  const timed = (e: LrclibHit | null) => !!(e?.syncedLyrics || e?.instrumental)
  if (timed(exacts[0])) return exacts[0]
  const searches = (await Promise.all(artists.map((artist) => lrclib('search', { track_name: title, artist_name: artist })))) as (LrclibHit[] | null)[]
  const close = searches.map((hits) => (hits ?? []).filter((h) => !q.duration || altered || Math.abs(h.duration - q.duration) <= 3))
  for (let i = 0; i < artists.length; i++) {
    const hit = (timed(exacts[i]) && exacts[i]) || close[i].find((h) => h.syncedLyrics)
    if (hit) return hit
  }
  return exacts.find(Boolean) ?? close.flat().find((h) => h.plainLyrics) ?? null
}

export async function lyrics(q: LyricsQuery): Promise<Lyrics | null> {
  const altered = ALTERED.test(q.title)
  const [lrcRes, ytmRes] = await Promise.allSettled([fromLrclib(q, altered), ytmLyrics(q.videoId)])
  const lrc = lrcRes.status === 'fulfilled' ? lrcRes.value : null
  const ytm = ytmRes.status === 'fulfilled' ? ytmRes.value : null
  // Nothing found and a source couldn't be reached: report it (so the view offers a retry) rather
  // than settle on "no lyrics" for the rest of the session.
  const unreachable = lrcRes.status === 'rejected' || ytmRes.status === 'rejected'
  if (lrc?.syncedLyrics && !altered) {
    const lines = parseLrc(lrc.syncedLyrics)
    if (lines.length) return { lines, synced: true, source: 'LRCLIB' }
  }
  if (lrc?.instrumental) return { lines: [{ text: '♪ Instrumental ♪' }], synced: false, source: 'LRCLIB' }
  const plain = ytm?.text ?? lrc?.plainLyrics ?? (lrc?.syncedLyrics && parseLrc(lrc.syncedLyrics).map((l) => l.text).join('\n'))
  if (!plain && unreachable) throw new Error('Couldn’t load lyrics. Check your connection and try again.')
  if (!plain) return null
  return { lines: plain.split('\n').map((text) => ({ text: text.trim() })), synced: false, source: ytm?.source || 'LRCLIB' }
}
