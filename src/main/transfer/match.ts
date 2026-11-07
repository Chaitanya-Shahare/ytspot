// Deciding which YouTube Music song is a Spotify song. Pure functions (no I/O), so they can be
// tested on their own and reused for any other pair of services.
//
// A candidate is scored 0–1 on its title, artists, length and album. Words that only describe the
// release ("Remastered 2011", "From "Brahmastra"", "feat. X") are ignored; words that mean a
// different recording ("Live", "Remix", "Acoustic", "Sped Up") must agree on both sides.

export interface SongInfo {
  title: string
  artists: string[]
  album?: string
  ms: number
}

export interface Candidate {
  videoId: string
  title: string
  artists: string // "A, B & C" as YouTube Music writes it; for a video, the channel
  album?: string
  duration: string // "3:45"; '' when unknown
  video?: boolean // a music video or upload rather than a song
}

export interface Match {
  videoId: string
  score: number
}

// At or above this a candidate is taken; below it the song counts as not found.
export const ACCEPT = 0.62
// At or above this the first search's best is taken without trying more searches.
export const SURE = 0.82

// Lower case, accents dropped, punctuation turned into single spaces. Letters of every script are
// kept (with their vowel signs), so Hindi or Japanese titles compare too.
export function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`´]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
}

// Words that mean another recording of the song. Each is a regex over the folded title.
const FLAGS: [string, RegExp][] = [
  ['live', /\blive\b|\bunplugged\b/],
  ['remix', /\bremix(ed)?\b|\brmx\b|\brework\b|\bbootleg\b|\bvip\b/],
  ['acoustic', /\bacoustic\b/],
  ['instrumental', /\binstrumental\b|\bkaraoke\b|\bbacking track\b/],
  ['cover', /\bcover\b/],
  ['sped', /\bsped up\b|\bspeed up\b|\bnightcore\b/],
  ['slowed', /\bslowed\b|\breverb\b/],
  ['demo', /\bdemo\b/],
  ['orchestral', /\borchestral\b|\bsymphonic\b/],
  ['taylors', /\btaylors version\b/],
  ['extended', /\bextended\b/]
]

export function flags(title: string): Set<string> {
  const t = fold(title)
  return new Set(FLAGS.filter(([, re]) => re.test(t)).map(([f]) => f))
}

// Bracketed parts or " - …" tails that only describe the release, not the recording.
const NOISE =
  /\b(feat|ft|featuring|with|prod|remaster(ed)?|\d{4} remaster|mono|stereo|single|album|radio|original|explicit|clean|deluxe|bonus|edit|version|mix|from|official|music|video|audio|lyrics?|lyrical|visuali[sz]er|hd|hq|4k|mv|soundtrack|ost|theme|anniversary|expanded|edition|re ?recorded)\b/

// The title without featured artists and release notes: "Kesariya (From "Brahmastra")" → "kesariya".
export function core(title: string): string {
  let t = title
  // Bracketed parts that are only notes; a bracket that's part of the name ("(I Can't Get No)
  // Satisfaction") stays.
  t = t.replace(/[([{【「]([^)\]}】」]*)[)\]}】」]/g, (m, inner: string) => (NOISE.test(fold(inner)) && !hasFlag(inner) ? ' ' : m))
  // " - Remastered 2009", " - From "Movie"", " - Radio Edit"
  t = t.replace(/\s[-–—|]\s(.*)$/, (m, tail: string) => (NOISE.test(fold(tail)) && !hasFlag(tail) ? '' : m))
  // A bare "feat. X" at the end.
  t = t.replace(/\s(feat\.?|ft\.?|featuring)\s.*$/i, '')
  return fold(t) || fold(title)
}

const hasFlag = (s: string) => flags(s).size > 0

const words = (s: string) => s.split(' ').filter(Boolean)

// Dice coefficient over two lists.
function dice<T>(a: T[], b: T[]): number {
  if (!a.length || !b.length) return 0
  const pool = new Map<T, number>()
  for (const x of b) pool.set(x, (pool.get(x) ?? 0) + 1)
  let common = 0
  for (const x of a) {
    const n = pool.get(x) ?? 0
    if (n) (common++, pool.set(x, n - 1))
  }
  return (2 * common) / (a.length + b.length)
}

const bigrams = (s: string) => {
  const t = s.replace(/ /g, '')
  return t.length < 2 ? [t] : Array.from({ length: t.length - 1 }, (_, i) => t.slice(i, i + 2))
}

// 0–1: how alike two folded strings are, by whole words and by letter pairs (for spelling
// differences such as "Dont" and "Don't", or "Pt 2" and "Pt. II" partly).
export function similar(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const byWords = dice(words(a), words(b))
  const byLetters = dice(bigrams(a), bigrams(b))
  // One wholly inside the other ("Song" in "Song Official HD") is nearly as good as equal.
  const wa = words(a)
  const wb = words(b)
  const inside = wa.every((w) => wb.includes(w)) || wb.every((w) => wa.includes(w)) ? 0.88 : 0
  return Math.max(byWords, byLetters * 0.95, Math.min(inside, Math.max(byWords, byLetters) + 0.3))
}

// Names as written by a channel or a credits line: "Artist - Topic", "ArtistVEVO", "A, B & C".
export function people(s: string): string[] {
  return s
    .split(/\s*(?:,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bvs\.?)\s*/i)
    .map((p) => fold(p.replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, '').replace(/\bofficial\b/i, '')))
    .filter(Boolean)
}

// Two folded names for the same person or band, allowing for spacing and small spelling
// differences ("Beyonce"/"Beyoncé", "Mo Town"/"Motown"), but not "Drake" and "Drake Bell".
const sameName = (a: string, b: string) =>
  a === b || (a.length > 3 && b.length > 3 && (a.replace(/ /g, '') === b.replace(/ /g, '') || dice(bigrams(a), bigrams(b)) >= 0.86))

// 0–1: whether the song's artists are the candidate's. The first (main) artist counts most.
export function artistScore(song: string[], cand: Candidate): number {
  const mine = song.map(fold).filter(Boolean)
  if (!mine.length) return 0.5
  const theirs = people(cand.artists)
  // A duo or band named with "&" ("Daryl Hall & John Oates") is one name, not two.
  const whole = fold(cand.artists)
  // Videos, and songs with no artist listed, carry the artist in their title ("Artist - Song
  // (Official Video)", "Song (feat. Artist)").
  const title = fold(cand.title)
  const inTitle = cand.video || !theirs.length
  const credited = (a: string) =>
    theirs.some((t) => sameName(a, t)) || sameName(a, whole) || (a.length > 3 && ` ${whole} `.includes(` ${a} `)) || (inTitle && a.length > 2 && ` ${title} `.includes(` ${a} `))
  if (credited(mine[0])) return 1
  if (mine.slice(1).some(credited)) return 0.7
  return 0
}

// "3:45" or "1:02:03" → seconds; NaN when unknown.
export function seconds(d: string): number {
  if (!d) return NaN
  return d.split(':').reduce((n, p) => n * 60 + Number(p), 0)
}

export function durationScore(ms: number, duration: string): number {
  const s = seconds(duration)
  if (!ms || !isFinite(s)) return 0.5
  const off = Math.abs(ms / 1000 - s)
  if (off <= 2) return 1
  if (off <= 5) return 0.9
  if (off <= 10) return 0.7
  if (off <= 20) return 0.4
  if (off <= 40) return 0.15
  return 0
}

// The title a candidate's song has: a video's "Artist - Song (Official Video)" is just "Song".
function candidateTitle(c: Candidate, artists: string[]): string {
  if (!c.video) return c.title
  const parts = c.title.split(/\s[-–—|]\s/)
  if (parts.length < 2) return c.title
  // Drop the part that's an artist's name.
  const names = artists.map(fold)
  const rest = parts.filter((p) => !names.some((n) => sameName(fold(p), n) || people(p).some((x) => sameName(x, n))))
  return rest.length && rest.length < parts.length ? rest.join(' - ') : c.title
}

export function score(song: SongInfo, c: Candidate): number {
  const title = similar(core(song.title), core(candidateTitle(c, song.artists)))
  const artist = artistScore(song.artists, c)
  const length = durationScore(song.ms, c.duration)
  const album = song.album && c.album && core(song.album) === core(c.album) ? 1 : 0
  // A different recording (live, remix, sped up…) on either side.
  const mine = flags(song.title)
  const theirs = flags(c.title)
  let differ = 0
  for (const f of mine) if (!theirs.has(f)) differ++
  for (const f of theirs) if (!mine.has(f)) differ++
  // No artist in common is most often a cover with the same title (and length): better reported
  // as not found, where it can be fixed, than quietly added.
  const s = 0.45 * title + 0.3 * artist + 0.2 * length + 0.05 * album - 0.25 * differ - (c.video ? 0.04 : 0) - (artist ? 0 : 0.1)
  // A title that doesn't match can't be made up for by the rest.
  return Math.max(0, Math.min(1, title < 0.5 ? s * title : s))
}

// The best candidate worth taking, if any.
export function best(song: SongInfo, cands: Candidate[]): Match | null {
  let top: Match | null = null
  for (const c of cands) {
    const s = score(song, c)
    if (!top || s > top.score) top = { videoId: c.videoId, score: s }
  }
  return top && top.score >= ACCEPT ? top : null
}

// What to search for, best first: the plain title with the main artist, then with every artist.
export function queries(song: SongInfo): string[] {
  const title = core(song.title) === fold(song.title) ? song.title : stripNotes(song.title)
  const main = song.artists[0] ?? ''
  const all = song.artists.slice(0, 3).join(' ')
  return [...new Set([`${title} ${main}`.trim(), `${song.title} ${all}`.trim()])]
}

// The title as written, minus the release notes core() would drop (keeps its capitals and accents).
function stripNotes(title: string): string {
  return title
    .replace(/[([{【「]([^)\]}】」]*)[)\]}】」]/g, (m, inner: string) => (NOISE.test(fold(inner)) && !hasFlag(inner) ? ' ' : m))
    .replace(/\s[-–—|]\s(.*)$/, (m, tail: string) => (NOISE.test(fold(tail)) && !hasFlag(tail) ? '' : m))
    .replace(/\s(feat\.?|ft\.?|featuring)\s.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Albums and artists, for saving and following.
export function albumScore(album: { title: string; artists: string[] }, cand: { title: string; subtitle: string }): number {
  const title = similar(core(album.title), core(cand.title))
  // The subtitle reads "Album • Artist • 2019".
  const credited = people(cand.subtitle.split(' • ').filter((p) => !/^(album|single|ep|\d{4})$/i.test(p.trim())).join(', '))
  const artist = album.artists.length ? (album.artists.some((a) => credited.some((c) => sameName(fold(a), c))) ? 1 : 0) : 0.5
  return 0.6 * title + 0.4 * artist
}

export function artistNameScore(name: string, cand: string): number {
  const a = fold(name)
  const b = fold(cand)
  return a === b ? 1 : sameName(a, b) ? 0.9 : dice(bigrams(a), bigrams(b)) * 0.8
}
