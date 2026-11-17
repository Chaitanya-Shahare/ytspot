// Working out chords from chroma frames: how strongly each of the 12 notes (and each in the bass
// alone) sounds, ten times a second. ANALYZE_JS makes the frames (and an onset envelope, for the
// beats) from a song's audio in a hidden page; `decode` turns a song's timeline of them into its
// beats, bars, time signature, chords and key. Nothing here touches Electron, so
// scripts/chords-eval.mjs (synthesised songs) and scripts/chords-bench.mjs (real songs against
// reference charts) can check it.
import type { Chords } from '../shared/types'

export const FPS = 10 // timeline frames per second of song
export const W = 26 // numbers per frame from the page: time, 12 notes, 12 bass notes, loudness (dB)
export const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

// A song's timeline: per frame, the 12 notes and 12 bass notes (0..100), loudness, and whether heard.
export interface Timeline {
  duration: number
  chroma: Uint8Array
  db: Int8Array
  have: Uint8Array
  full?: boolean // worked out from the whole song at once (not just the parts heard)
  tuning?: number // cents off A440, once worked out whole
  onset?: Uint8Array // how sharply the sound gets louder, ONSET_FPS a second (worked out whole only)
  onsetLow?: Uint8Array // the same in the bass alone
}

// Bumped when ANALYZE_JS's frames change, so songs worked out before are worked out again.
export const VERSION = 3

export const emptyTimeline = (frames: number): Timeline => ({
  duration: 0,
  chroma: new Uint8Array(frames * 24),
  db: new Int8Array(frames).fill(-128),
  have: new Uint8Array(frames)
})

function grow(t: Timeline, frames: number): void {
  if (frames <= t.have.length) return
  const g = emptyTimeline(Math.max(frames, Math.ceil(t.have.length * 1.5)))
  g.chroma.set(t.chroma)
  g.db.set(t.db)
  g.have.set(t.have)
  Object.assign(t, { chroma: g.chroma, db: g.db, have: g.have })
}

// Lays frames (W numbers each, from ANALYZE_JS or the YTM page) out on the timeline.
export function addFrames(t: Timeline, duration: number, frames: number[]): void {
  if (duration) t.duration = duration
  for (let i = 0; i + W <= frames.length; i += W) {
    const f = Math.round(frames[i] * FPS)
    if (f < 0 || (t.duration && f > t.duration * FPS + 1)) continue
    grow(t, f + 1)
    for (let j = 0; j < 24; j++) t.chroma[f * 24 + j] = frames[i + 1 + j]
    t.db[f] = Math.max(-127, Math.min(127, frames[i + 25]))
    t.have[f] = 1
  }
}

// The 24 triads as unit vectors over the 12 notes: chord c < 12 is major on root c, else minor on
// c - 12. Each note brings its overtones too (an octave up, then a fifth above that, two octaves,
// a major third above that…), each 0.4 times the one before, as they sound in the chroma: a minor
// chord's root rings with a faint major third, and a bass note with its fifth.
const TEMPLATES = Array.from({ length: 24 }, (_, c) => {
  const root = c % 12, t = new Float64Array(12)
  for (const iv of [0, c < 12 ? 4 : 3, 7]) for (let h = 1; h <= 6; h++) t[(root + iv + Math.round(12 * Math.log2(h))) % 12] += 0.4 ** (h - 1)
  let n = 0
  for (const v of t) n += v * v
  for (let i = 0; i < 12; i++) t[i] /= Math.sqrt(n)
  return t
})
const NAME = (c: number) => (c === 24 ? '' : NOTES[c % 12] + (c < 12 ? '' : 'm'))

// Krumhansl's key profiles: how much each scale degree sounds in music in a major or minor key.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

function correlate(a: ArrayLike<number>, b: number[], shift: number): number {
  let ma = 0, mb = 0
  for (let i = 0; i < 12; i++) (ma += a[i] / 12), (mb += b[i] / 12)
  let num = 0, da = 0, db = 0
  for (let i = 0; i < 12; i++) {
    const x = a[(i + shift) % 12] - ma, y = b[i] - mb
    num += x * y
    da += x * x
    db += y * y
  }
  return num / Math.sqrt(da * db || 1)
}

// How well the song's overall note balance fits each key: 0..11 major on that tonic, 12..23 minor.
const profileFit = (total: Float64Array) => Array.from({ length: 24 }, (_, k) => correlate(total, k < 12 ? MAJOR : MINOR, k % 12))

// How much each chord says about a key, by its role there: the tonic most, then the chords around
// it (IV and V; in minor VI, III, VII and the major V too), then the rest of the key's chords. One
// from outside the key counts against it. Indexed by chord - tonic (major 0..11, minor 12..23).
const ROLE_MAJOR = [1, -0.3, -0.3, -0.3, -0.3, 0.6, -0.3, 0.6, -0.3, -0.3, -0.3, -0.3, ...[-0.3, -0.3, 0.4, -0.3, 0.3, -0.3, -0.3, -0.3, -0.3, 0.4, -0.3, -0.3]]
const ROLE_MINOR = [-0.3, -0.3, -0.3, 0.5, -0.3, -0.3, -0.3, 0.5, 0.5, -0.3, 0.5, -0.3, ...[1, -0.3, -0.3, -0.3, -0.3, 0.6, -0.3, 0.5, -0.3, -0.3, -0.3, -0.3]]
const role = (chord: number, key: number) => {
  const t = key % 12, c = ((chord % 12) - t + 12) % 12 + (chord < 12 ? 0 : 12)
  return (key < 12 ? ROLE_MAJOR : ROLE_MINOR)[c]
}

// The key, from the chords as decoded (how long each sounds, and the ones the song starts and ends
// on, usually its tonic) and the note balance. The note balance alone mixes up a key with its
// relative minor or major (C major and A minor share their notes) and with the key a fifth away;
// the chords tell them apart. -1 when there's nothing to go on.
function findKey(path: Uint8Array, fit: number[]): number {
  const time = new Float64Array(24)
  let all = 0, first = -1, last = -1, run = 0
  for (let f = 0; f < path.length; f++) {
    const c = path[f]
    run = f && path[f - 1] === c ? run + 1 : 1
    if (c === 24) continue
    time[c]++
    all++
    // A chord held for half a second or more, not a passing one.
    if (run === FPS / 2) (last = c), first < 0 && (first = c)
  }
  if (!all) return -1
  let best = -1, score = -Infinity
  for (let k = 0; k < 24; k++) {
    let sum = 0
    for (let c = 0; c < 24; c++) if (time[c]) sum += (time[c] / all) * role(c, k)
    // (Key k's tonic chord is chord k: both count majors 0..11 and minors 12..23.)
    const sc = sum + (first === k ? 0.15 : 0) + (last === k ? 0.1 : 0) + 0.5 * fit[k]
    if (sc > score) (score = sc), (best = k)
  }
  return score > 0.3 ? best : -1
}

// The triads that belong to a key (I ii iii IV V vi, or i III iv v VI VII in minor), as chord indexes.
function diatonic(key: number): Set<number> {
  if (key < 0) return new Set()
  const t = key % 12, at = (iv: number, minor: boolean) => ((t + iv) % 12) + (minor ? 12 : 0)
  return new Set(
    key < 12
      ? [at(0, false), at(2, true), at(4, true), at(5, false), at(7, false), at(9, true)]
      : [at(0, true), at(3, false), at(5, true), at(7, true), at(8, false), at(10, false), at(7, false)]
  )
}

const BETA = 12 // how sharply a frame's evidence counts
const CHANGE = 4 // the cost of changing chord, against BETA × the per-frame score difference
const MIN_LEN = 0.7 // seconds; shorter chords merge into the one before

// How well each of the 25 states (24 triads, 24 = no chord) fits frame f, into `em`.
// How much the bass playing the chord's root (or its third or fifth) counts, a chord being in the
// song's key, and how well silence must fit to win.
const BASS_ROOT = 0.3, BASS_OTHER = 0.1, IN_KEY = 0.08, NONE = 0.45
function frameScores(s: Timeline, f: number, quiet: number, inKey: Set<number>, em: Float64Array, c = new Float64Array(12)): void {
  em.fill(0)
  if (!s.have[f]) return
  if (s.db[f] <= quiet) return void (em[24] = BETA)
  let norm = 0
  for (let j = 0; j < 12; j++) (c[j] = s.chroma[f * 24 + j]), (norm += c[j] * c[j])
  norm = Math.sqrt(norm) || 1
  for (let k = 0; k < 24; k++) {
    const t = TEMPLATES[k]
    let dot = 0
    for (let j = 0; j < 12; j++) dot += t[j] * c[j]
    // The bass usually plays the root, and otherwise often the third or fifth (C/E, D/F#):
    // without credit for those, a chord over its third reads as the chord on the bass note.
    const B = f * 24 + 12, r = k % 12
    const root = s.chroma[B + r], other = Math.max(s.chroma[B + ((r + (k < 12 ? 4 : 3)) % 12)], s.chroma[B + ((r + 7) % 12)])
    em[k] = BETA * (dot / norm + (BASS_ROOT * root + BASS_OTHER * other) / 100 + (inKey.has(k) ? IN_KEY : 0))
  }
  em[24] = BETA * NONE
}

// Viterbi over 25 states, frame by frame: for what's been heard live, which has no beats to go by.
// Every change costs the same, so each frame only needs the best previous state overall and
// staying put: O(frames × states).
function viterbi(s: Timeline, quiet: number, inKey: Set<number>): Uint8Array {
  const n = s.have.length
  const S = 25, back = new Uint8Array(n * S)
  let prev = new Float64Array(S), cur = new Float64Array(S)
  const em = new Float64Array(S)
  for (let f = 0; f < n; f++) {
    let best = 0
    for (let k = 1; k < S; k++) if (prev[k] > prev[best]) best = k
    frameScores(s, f, quiet, inKey, em)
    for (let k = 0; k < S; k++) {
      const stay = prev[k], jump = prev[best] - CHANGE
      if (stay >= jump) (cur[k] = stay + em[k]), (back[f * S + k] = k)
      else (cur[k] = jump + em[k]), (back[f * S + k] = best)
    }
    ;[prev, cur] = [cur, prev]
  }
  const path = new Uint8Array(n)
  let k = 0
  for (let j = 1; j < S; j++) if (prev[j] > prev[k]) k = j
  for (let f = n - 1; f >= 0; f--) (path[f] = k), (k = back[f * S + k])
  return path
}

// ---- Beats and bars ----
//
// Played along to, chords have to land where a player expects them: on the beat, and nearly always
// on the first beat of a bar (or halfway through one). So, as Chordify does, the beats are found
// first, the chords are worked out a beat at a time, and the bar lines with them: one Viterbi pass
// over (chord, place in the bar), where changing chord on the bar's first beat costs little, halfway
// through a 4/4 bar a bit more, and anywhere else a lot. Done for 3 and 4 beats to the bar, the
// better fit is the time signature.

// The onset envelope's rate (ANALYZE_JS's hop of 220 samples at 22050 Hz).
export const ONSET_FPS = 22050 / 220

// (These and the costs below were tuned with scripts/chords-bench.mjs.)
const TEMPO_MID = 100 // beats per minute that tempos lean towards (people tap along near it)
const TEMPO_WIDTH = 1 // in octaves
const TIGHT = 100 // how firmly the beat keeps time (as in Ellis's beat tracker)
const LOW = 1 // how much the bass's onsets count, against the whole range's

const prior = (period: number) => Math.exp(-0.5 * (Math.log2((60 * ONSET_FPS) / period / TEMPO_MID) / TEMPO_WIDTH) ** 2)

// The beat period (in onset frames) that lines the onsets up best: the highest peak of their
// autocorrelation, weighed by how usual the tempo is. (Empty if there's no beat to find.)
function tempoCandidates(env: Float64Array): number[] {
  const n = env.length
  let mean = 0
  for (const v of env) mean += v / n
  const x = env.map((v) => v - mean)
  const minLag = Math.floor((ONSET_FPS * 60) / 220), maxLag = Math.ceil((ONSET_FPS * 60) / 45)
  const ac = new Float64Array(2 * maxLag + 2)
  for (let l = minLag; l < ac.length && l < n; l++) {
    let sum = 0
    for (let i = 0; i + l < n; i++) sum += x[i] * x[i + l]
    ac[l] = sum / (n - l)
  }
  const score = (l: number) => (ac[l] + 0.5 * (ac[2 * l] || 0)) * prior(l)
  const peaks: { lag: number; v: number }[] = []
  for (let l = minLag + 1; l < maxLag; l++) if (score(l) > 0 && score(l) >= score(l - 1) && score(l) > score(l + 1)) peaks.push({ lag: l, v: score(l) })
  peaks.sort((a, b) => b.v - a.v)
  // Between whole lags, from the curve's shape around each peak.
  const fine = (l: number) => {
    const a = score(l - 1), c = score(l + 1), mid = score(l), d = a - 2 * mid + c
    return l + (d < 0 ? (0.5 * (a - c)) / d : 0)
  }
  return peaks.slice(0, 1).map((p) => fine(p.lag))
}

// The train of beats about `P` frames apart that lands on the most onsets (dynamic programming, as
// in Ellis 2007), as onset frames.
function track(local: Float64Array, P: number): number[] {
  const n = local.length
  const cum = new Float64Array(n), back = new Int32Array(n).fill(-1)
  const lo = Math.round(P / 2), hi = Math.round(2 * P)
  for (let i = 0; i < n; i++) {
    let best = 0, from = -1
    for (let t = Math.max(0, i - hi); t <= i - lo; t++) {
      const v = cum[t] - TIGHT * Math.log((i - t) / P) ** 2
      if (from < 0 || v > best) (best = v), (from = t)
    }
    cum[i] = local[i] + (from >= 0 ? best : 0)
    back[i] = from
  }
  // The last beat: the best-scoring frame in the last beat period or so.
  let last = n - 1
  for (let i = Math.max(0, n - Math.round(1.5 * P)); i < n; i++) if (cum[i] > cum[last]) last = i
  const frames: number[] = []
  for (let i = last; i >= 0; i = back[i]) frames.push(i)
  return frames.reverse()
}

// The beats (seconds), from how sharply the sound gets louder (ANALYZE_JS's onset envelope): the
// tempo first, then the train of beats at about that tempo that lands on the most onsets (dynamic
// programming, as in Ellis 2007). Carried on at the same pace through the song's quiet start and
// end, so every chord has a beat to sit on.
export function findBeats(onset: ArrayLike<number>, onsetLow: ArrayLike<number> | undefined, duration: number): number[] {
  const n = onset.length
  if (n < ONSET_FPS * 4) return []
  // Each envelope in its own standard deviations, then together.
  const norm = (x: ArrayLike<number>) => {
    let sd = 0, mean = 0
    for (let i = 0; i < n; i++) mean += x[i] / n
    for (let i = 0; i < n; i++) sd += (x[i] - mean) ** 2 / n
    sd = Math.sqrt(sd) || 1
    return (i: number) => x[i] / sd
  }
  const a = norm(onset), b = onsetLow?.length === n ? norm(onsetLow) : () => 0
  const env = Float64Array.from({ length: n }, (_, i) => a(i) + LOW * b(i))
  const candidates = tempoCandidates(env)
  if (!candidates.length) return []
  // Each frame's onset, smoothed over a little of a beat.
  const smooth = (P: number) => {
    const local = new Float64Array(n), w = Math.max(1, Math.round(P / 32))
    for (let i = 0; i < n; i++) {
      let sum = 0, norm = 0
      for (let j = -4 * w; j <= 4 * w; j++) {
        if (i + j < 0 || i + j >= n) continue
        const g = Math.exp(-0.5 * (j / w) ** 2)
        sum += g * env[i + j]
        norm += g
      }
      local[i] = sum / norm
    }
    return local
  }
  const P = candidates[0], frames = track(smooth(P), P)
  if (!frames.length) return []
  const beats = frames.map((f) => f / ONSET_FPS)
  const step = P / ONSET_FPS
  while (beats[0] - step > -step / 2) beats.unshift(beats[0] - step)
  while (beats[beats.length - 1] + step < duration - step / 4) beats.push(beats[beats.length - 1] + step)
  return beats.map((t) => Math.max(0, Math.round(t * 1000) / 1000))
}

// Changing chord: cheap on a bar's first beat, dearer halfway through a 4/4 bar, dear anywhere
// else (indexed by the beat's place in the bar). In or out of silence costs the least, wherever.
const CHG = { 3: [3, 25, 25], 4: [3, 25, 10, 25] } as Record<number, number[]>
const CHG_SILENCE = 2.5
// Starting a new bar before this one's out (a bar of 2 in a 4/4 song, or a beat the tracker missed).
const BAR_BREAK = 30
// Tempos below SLOW are also tried doubled, which has to fit better by DOUBLE a beat.
const SLOW = 90
const DOUBLE = 2
// 4/4 is far more common; 3/4 has to fit better by this much a beat.
const TRIPLE = 0.25

interface BarPath {
  score: number
  chord: Uint8Array
  pos: Uint8Array // each beat's place in its bar, from 0
}

// The likeliest chords and bar lines, `meter` beats to the bar, given each beat's score for each
// state (em[k * 25 + c]). (A bar's first beat being louder was tried as evidence too; it didn't help.)
function bars(em: Float64Array, meter: number): BarPath {
  const C = 25, K = em.length / C, S = C * meter
  const chg = CHG[meter]
  let prev = new Float64Array(S), cur = new Float64Array(S)
  const back = new Uint16Array(K * S)
  for (let p = 0; p < meter; p++) for (let c = 0; c < C; c++) prev[p * C + c] = em[c]
  for (let k = 1; k < K; k++) {
    for (let p = 0; p < meter; p++) {
      for (let c = 0; c < C; c++) {
        let best = -Infinity, from = 0
        for (let q = 0; q < meter; q++) {
          // Bars run 0, 1, … meter-1; a new bar can also start early.
          const cost = q === (p + meter - 1) % meter ? 0 : p === 0 ? BAR_BREAK : -1
          if (cost < 0) continue
          for (let x = 0; x < C; x++) {
            const v = prev[q * C + x] - cost - (x === c ? 0 : x === 24 || c === 24 ? CHG_SILENCE : chg[p])
            if (v > best) (best = v), (from = q * C + x)
          }
        }
        cur[p * C + c] = best + em[k * C + c]
        back[k * S + p * C + c] = from
      }
    }
    ;[prev, cur] = [cur, prev]
  }
  let s = 0
  for (let j = 1; j < S; j++) if (prev[j] > prev[s]) s = j
  const score = prev[s]
  const chord = new Uint8Array(K), pos = new Uint8Array(K)
  for (let k = K - 1; k >= 0; k--) {
    chord[k] = s % C
    pos[k] = Math.floor(s / C)
    s = back[k * S + s]
  }
  return { score, chord, pos }
}

// Each beat's score for each state: the frames within the beat, summed.
function beatScores(s: Timeline, beats: number[], end: number, quiet: number, inKey: Set<number>): Float64Array {
  const K = beats.length, em = new Float64Array(K * 25), f1 = new Float64Array(25), c = new Float64Array(12)
  for (let k = 0; k < K; k++) {
    const t0 = beats[k], t1 = k + 1 < K ? beats[k + 1] : end
    let a = Math.ceil(t0 * FPS), b = Math.ceil(t1 * FPS) - 1
    // A beat shorter than a frame's spacing takes the frame nearest its middle.
    if (b < a) a = b = Math.round(((t0 + t1) / 2) * FPS)
    for (let f = a; f <= b && f < s.have.length; f++) {
      frameScores(s, f, quiet, inKey, f1, c)
      for (let x = 0; x < 25; x++) em[k * 25 + x] += f1[x]
    }
  }
  return em
}

// The time signature, chords and bar lines from the beats; the key is found as before (findKey).
function decodeBeats(s: Timeline, beats: number[], quiet: number, fit: number[]) {
  const end = s.duration || beats[beats.length - 1] + 0.5
  const run = (key: number) => {
    const em = beatScores(s, beats, end, quiet, diatonic(key))
    const four = bars(em, 4), three = bars(em, 3)
    const tripleWins = three.score > four.score + TRIPLE * beats.length
    return { ...(tripleWins ? three : four), meter: tripleWins ? 3 : 4 }
  }
  let key = fit.indexOf(Math.max(...fit))
  // The key from the chords as found, through a frame-length path (what findKey reads).
  const asFrames = (chord: Uint8Array) => {
    const path = new Uint8Array(s.have.length).fill(24)
    for (let k = 0; k < beats.length; k++) {
      const a = Math.ceil(beats[k] * FPS), b = k + 1 < beats.length ? Math.ceil(beats[k + 1] * FPS) : path.length
      path.fill(chord[k], Math.max(0, a), Math.min(path.length, b))
    }
    return path
  }
  let r = run(key)
  const found = findKey(asFrames(r.chord), fit)
  if (found !== key && found >= 0) r = run(found)
  key = found
  return { ...r, key, end }
}

export function decode(id: string, s: Timeline): Chords {
  const n = s.have.length
  const heard: number[] = []
  for (let f = 0; f < n; f++) if (s.have[f]) heard.push(f)
  const result: Chords = {
    videoId: id,
    key: '',
    chords: [],
    heard: s.full ? 1 : s.duration ? Math.min(1, heard.length / (s.duration * FPS)) : 0,
    ...(s.tuning ? { tuning: s.tuning } : {})
  }
  if (heard.length < FPS) return result

  // Quiet: well below the song's typical loudness (intros, gaps, the fade-out).
  const sorted = heard.map((f) => s.db[f]).sort((a, b) => a - b)
  const quiet = sorted[Math.floor(sorted.length / 2)] - 20

  const total = new Float64Array(12)
  for (const f of heard) if (s.db[f] > quiet) for (let j = 0; j < 12; j++) total[j] += s.chroma[f * 24 + j]
  const fit = profileFit(total)

  // Worked out whole: by the beat, in bars.
  let beats = s.full && s.onset?.length ? findBeats(s.onset, s.onsetLow, s.duration) : []
  if (beats.length >= 8) {
    let r = decodeBeats(s, beats, quiet, fit)
    // A slow beat may really be every other one: then chords changing halfway through a bar fall
    // on its "beat 2", where they're kept from changing. So a slow song is also tried at twice the
    // tempo, which wins when it lets the chords change where they clearly do.
    const gap = (beats[beats.length - 1] - beats[0]) / (beats.length - 1)
    if (gap > 60 / SLOW) {
      const doubled = beats.flatMap((t, k) => (k + 1 < beats.length ? [t, (t + beats[k + 1]) / 2] : [t]))
      const r2 = decodeBeats(s, doubled, quiet, fit)
      if (r2.score - r.score > DOUBLE * beats.length) (beats = doubled), (r = r2)
    }
    if (r.key >= 0) result.key = `${NOTES[r.key % 12]} ${r.key < 12 ? 'major' : 'minor'}`
    const out: Chords['chords'] = []
    for (let k = 0; k < beats.length; k++) {
      const name = NAME(r.chord[k]), t1 = k + 1 < beats.length ? beats[k + 1] : r.end
      const last = out[out.length - 1]
      if (last && last.name === name) last.end = t1
      else out.push({ time: beats[k], end: t1, name })
    }
    result.chords = out.filter((c) => c.name)
    result.beats = beats
    result.downbeats = [...r.pos.keys()].filter((k) => r.pos[k] === 0)
    result.meter = r.meter
    const gaps = beats.slice(1).map((t, k) => t - beats[k]).sort((a, b) => a - b)
    result.tempo = Math.round(60 / gaps[Math.floor(gaps.length / 2)])
    return result
  }

  // Only parts heard live: frame by frame.
  // A first pass leaning towards the key the note balance suggests; then the key the chords found
  // point to, and again leaning towards that one if it's another.
  let key = fit.indexOf(Math.max(...fit))
  let path = viterbi(s, quiet, diatonic(key))
  const found = findKey(path, fit)
  if (found !== key) path = viterbi(s, quiet, diatonic(found))
  key = found
  if (key >= 0 && heard.length > 30 * FPS) result.key = `${NOTES[key % 12]} ${key < 12 ? 'major' : 'minor'}`

  // Runs of one chord over heard frames; an unheard stretch of over a second ends a run.
  const out: Chords['chords'] = []
  let gap = 0
  for (let f = 0; f < n; f++) {
    if (!s.have[f]) {
      if (++gap === FPS) out.push({ time: 0, end: 0, name: '' })
      continue
    }
    gap = 0
    const name = NAME(path[f]), last = out[out.length - 1]
    if (last && last.name === name && last.end >= f / FPS - 1) last.end = (f + 1) / FPS
    else out.push({ time: f / FPS, end: (f + 1) / FPS, name })
  }
  // Merge blips into the chord before, then join neighbours that became the same chord.
  const merged: Chords['chords'] = []
  for (const r of out) {
    const last = merged[merged.length - 1]
    if (!r.name && r.end === 0) continue
    if (last && (r.end - r.time < MIN_LEN || last.name === r.name) && r.time - last.end < 1) last.end = r.end
    else merged.push({ ...r })
  }
  result.chords = merged.filter((r) => r.name)
  return result
}

// Runs in a hidden page (blank, on ytspot-media:// so it can fetch the song): decodes the song,
// plays it through an AnalyserNode offline, reading it every 0.1 s just as the YTM page does while
// a song plays (CHROMA_JS), and works out its tuning and tempo. Returns the frames (26 numbers
// each, as from CHROMA_JS), the duration, the beats per minute and the tuning (cents off A440).
export const ANALYZE_JS = `window.__analyze = async (url) => {
  const RATE = 22050, FFT = 8192, STEP = 0.1, HOP = 220
  const data = await (await fetch(url)).arrayBuffer()
  const buf = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(data)
  const n = buf.length, dur = buf.duration

  // Chroma, read every 0.1 s as the song renders (much faster than it plays).
  const ctx = new OfflineAudioContext(1, n, RATE)
  const src = ctx.createBufferSource()
  src.buffer = buf
  const an = ctx.createAnalyser()
  an.fftSize = FFT
  an.smoothingTimeConstant = 0
  src.connect(an).connect(ctx.destination)
  const hz = RATE / FFT, lo = Math.ceil(40 / hz), hi = Math.floor(2000 / hz), bass = Math.floor(200 / hz)
  // Each read keeps the spectrum's peaks (the slopes around a note would smear it into its
  // neighbours): their pitch in semitones (MIDI numbers, between bins from the peak's shape), how
  // loud, and whether in the bass. They're only folded into notes once the song's tuning is known.
  const b = new Float32Array(an.frequencyBinCount), reads = []
  const read = (t) => {
    an.getFloatFrequencyData(b)
    const p = []
    let e = 0
    for (let k = lo; k <= hi; k++) {
      if (b[k] < -90 || b[k] < b[k - 1] || b[k] < b[k + 1]) continue
      const m = 10 ** (b[k] / 20), d = b[k - 1] - 2 * b[k] + b[k + 1]
      p.push(69 + 12 * Math.log2(((k + (d < 0 ? (0.5 * (b[k - 1] - b[k + 1])) / d : 0)) * hz) / 440), m, k <= bass ? 1 : 0)
      e += m * m
    }
    // The window ends at t; stamp its middle.
    reads.push({ t: Math.round((t - FFT / RATE / 2) * 100) / 100, p, e })
  }
  for (let i = 0, t = FFT / RATE; t < dur; t = FFT / RATE + ++i * STEP) {
    const at = t
    ctx.suspend(at).then(() => (read(at), ctx.resume()))
  }
  src.start()
  const mono = (await ctx.startRendering()).getChannelData(0)

  // Tuning: recordings aren't all at A = 440 Hz (old tape ran fast or slow, bands tune by ear).
  // How far the notes sit off the semitones, on average round the circle (above 150 Hz, where the
  // bins are fine enough to tell), so a song 40 cents flat has its notes named as played, rather
  // than split between two.
  let sx = 0, sy = 0
  for (const r of reads)
    for (let i = 0; i < r.p.length; i += 3)
      if (r.p[i] > 50.4) (sx += r.p[i + 1] * Math.cos(2 * Math.PI * r.p[i])), (sy += r.p[i + 1] * Math.sin(2 * Math.PI * r.p[i]))
  const tuning = Math.atan2(sy, sx) / (2 * Math.PI)
  // The frames, 26 numbers each: time, the 12 notes and the 12 in the bass (each 0..100 of the
  // loudest), and the loudness in dB.
  const frames = []
  for (const r of reads) {
    const x = new Float64Array(24)
    for (let i = 0; i < r.p.length; i += 3) {
      const pc = ((Math.round(r.p[i] - tuning) % 12) + 12) % 12
      x[pc] += r.p[i + 1]
      if (r.p[i + 2]) x[12 + pc] += r.p[i + 1]
    }
    const top = Math.max(...x.subarray(0, 12)) || 1, low = Math.max(...x.subarray(12, 24)) || 1
    frames.push(r.t)
    for (let i = 0; i < 12; i++) frames.push(Math.round((x[i] / top) * 100))
    for (let i = 12; i < 24; i++) frames.push(Math.round((x[i] / low) * 100))
    frames.push(Math.round(10 * Math.log10(r.e + 1e-12)))
  }

  // Onsets, for the beats: how sharply the spectrum gets louder every 10 ms (spectral flux, from a
  // 1024-point FFT of log-compressed magnitudes), over the whole range and in the bass alone (below
  // ~200 Hz, which usually keeps the beat).
  const N = 1024, half = N / 2, win = new Float32Array(N), re = new Float64Array(N), im = new Float64Array(N)
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)
  const bits = Math.log2(N), rev = new Uint32Array(N)
  for (let i = 0; i < N; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
    rev[i] = r
  }
  const cos = new Float64Array(half), sin = new Float64Array(half)
  for (let i = 0; i < half; i++) (cos[i] = Math.cos((2 * Math.PI * i) / N)), (sin[i] = -Math.sin((2 * Math.PI * i) / N))
  const fft = () => {
    for (let i = 0; i < N; i++) if (rev[i] > i) ([re[i], re[rev[i]]] = [re[rev[i]], re[i]]), ([im[i], im[rev[i]]] = [im[rev[i]], im[i]])
    for (let size = 2; size <= N; size *= 2) {
      const h = size / 2, step = N / size
      for (let i = 0; i < N; i += size)
        for (let j = 0; j < h; j++) {
          const c = cos[j * step], s = sin[j * step], a = i + j, b = a + h
          const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c
          re[b] = re[a] - tr, im[b] = im[a] - ti, re[a] += tr, im[a] += ti
        }
    }
  }
  const m = Math.floor(n / HOP), flux = new Float64Array(m), fluxLow = new Float64Array(m)
  const bassBin = Math.round((200 * N) / RATE), topBin = Math.round((8000 * N) / RATE)
  let last = new Float64Array(topBin), next = new Float64Array(topBin)
  for (let i = 0; i < m; i++) {
    const at = i * HOP - half
    for (let j = 0; j < N; j++) (re[j] = (mono[at + j] || 0) * win[j]), (im[j] = 0)
    fft()
    let a = 0, b = 0
    for (let k = 1; k < topBin; k++) {
      next[k] = Math.log(1 + 100 * Math.hypot(re[k], im[k]))
      const d = next[k] - last[k]
      if (d > 0) (a += d), k <= bassBin && (b += d)
    }
    if (i) (flux[i] = a), (fluxLow[i] = b)
    ;[last, next] = [next, last]
  }
  // The beats are found from these (chord-detect.ts's findBeats), so they go back as they are: 0..255
  // of their loudest, ONSET_FPS a second.
  const q = (x) => {
    let peak = 1e-9
    for (const v of x) peak = Math.max(peak, v)
    return Array.from(x, (v) => Math.round((255 * v) / peak))
  }
  return { frames, duration: dur, onset: q(flux), onsetLow: q(fluxLow), tuning: Math.round(tuning * 100) }
}`
