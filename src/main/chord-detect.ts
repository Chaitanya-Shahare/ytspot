// Working out chords from chroma frames: how strongly each of the 12 notes (and each in the bass
// alone) sounds, ten times a second. ANALYZE_JS makes the frames from a song's audio in a hidden
// page; `decode` turns a song's timeline of them into chords, its key and its tempo. Nothing here
// touches Electron, so scripts/chords-eval.mjs can check it against songs whose chords are known.
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
  bpm?: number
  tuning?: number // cents off A440, once worked out whole
}

// Bumped when ANALYZE_JS's frames change, so songs worked out before are worked out again.
export const VERSION = 2

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

// Viterbi over 25 states (24 triads, 24 = no chord). Every change costs the same, so each frame
// only needs the best previous state overall and staying put: O(frames × states).
function viterbi(s: Timeline, quiet: number, inKey: Set<number>): Uint8Array {
  const n = s.have.length
  const S = 25, back = new Uint8Array(n * S)
  let prev = new Float64Array(S), cur = new Float64Array(S)
  const c = new Float64Array(12)
  for (let f = 0; f < n; f++) {
    let best = 0
    for (let k = 1; k < S; k++) if (prev[k] > prev[best]) best = k
    const em = new Float64Array(S)
    if (s.have[f]) {
      if (s.db[f] <= quiet) em[24] = BETA
      else {
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
          em[k] = BETA * (dot / norm + (0.15 * root + 0.1 * other) / 100 + (inKey.has(k) ? 0.08 : 0))
        }
        em[24] = BETA * 0.45
      }
    }
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

export function decode(id: string, s: Timeline): Chords {
  const n = s.have.length
  const heard: number[] = []
  for (let f = 0; f < n; f++) if (s.have[f]) heard.push(f)
  const result: Chords = {
    videoId: id,
    key: '',
    chords: [],
    heard: s.full ? 1 : s.duration ? Math.min(1, heard.length / (s.duration * FPS)) : 0,
    tempo: s.bpm,
    ...(s.tuning ? { tuning: s.tuning } : {})
  }
  if (heard.length < FPS) return result

  // Quiet: well below the song's typical loudness (intros, gaps, the fade-out).
  const sorted = heard.map((f) => s.db[f]).sort((a, b) => a - b)
  const quiet = sorted[Math.floor(sorted.length / 2)] - 20

  const total = new Float64Array(12)
  for (const f of heard) if (s.db[f] > quiet) for (let j = 0; j < 12; j++) total[j] += s.chroma[f * 24 + j]
  const fit = profileFit(total)
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

  // Tempo: how sharply the sound (and the bass alone) gets louder every 10 ms, and the beat period
  // that lines those onsets up best, favouring tempos near 120 as people tap along.
  const lowCtx = new OfflineAudioContext(1, n, RATE)
  const src2 = lowCtx.createBufferSource()
  src2.buffer = buf
  const lp = lowCtx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 150
  src2.connect(lp).connect(lowCtx.destination)
  src2.start()
  const lows = (await lowCtx.startRendering()).getChannelData(0)
  const m = Math.floor(n / HOP), onset = new Float64Array(m)
  let prevA = 0, prevB = 0
  for (let i = 0; i < m; i++) {
    let ea = 1e-9, eb = 1e-9
    for (let j = i * HOP; j < (i + 1) * HOP; j++) (ea += mono[j] * mono[j]), (eb += lows[j] * lows[j])
    const la = Math.log(ea), lb = Math.log(eb)
    if (i) onset[i] = Math.max(0, la - prevA) + Math.max(0, lb - prevB)
    prevA = la
    prevB = lb
  }
  let mean = 0
  for (const v of onset) mean += v / m
  for (let i = 0; i < m; i++) onset[i] -= mean
  const fps = RATE / HOP, minLag = Math.floor((fps * 60) / 200), maxLag = Math.ceil((fps * 60) / 60)
  const ac = new Float64Array(2 * maxLag + 2)
  for (let l = minLag; l < ac.length && l < m; l++) {
    let sum = 0
    for (let i = 0; i + l < m; i++) sum += onset[i] * onset[i + l]
    ac[l] = sum / (m - l)
  }
  let best = 0, bestScore = -Infinity
  const score = (l) => ac[l] + 0.5 * (ac[2 * l] || 0)
  for (let l = minLag; l <= maxLag; l++) {
    const bpm = (60 * fps) / l, prior = Math.exp(-0.5 * Math.log2(bpm / 120) ** 2)
    if (score(l) * prior > bestScore) (bestScore = score(l) * prior), (best = l)
  }
  // Between whole lags, from the curve's shape around the best one.
  const a = score(best - 1), c = score(best + 1), mid = score(best), d = a - 2 * mid + c
  const lag = best + (d < 0 ? (0.5 * (a - c)) / d : 0)
  return { frames, duration: dur, bpm: best && bestScore > 0 ? Math.round((60 * fps) / lag) : 0, tuning: Math.round(tuning * 100) }
}`
