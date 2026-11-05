// Guitar chords for the playing song, worked out from its audio alone, as chroma frames: how
// strongly each of the 12 notes sounds, ten times a second. As soon as a song starts, its whole
// audio is fetched at full speed (the downloaded file, or the low-quality stream) and a hidden page
// runs it through an AnalyserNode offline (ANALYZE_JS), so all its chords are there in a few
// seconds, along with its tempo. Should that fail, the YTM page listens to the song as it plays
// (CHROMA_JS in player.ts) and hands over the same frames as it goes. Here they're laid out on the
// song's timeline and decoded into chords: each frame is scored against the 24 major and minor
// triads, then a Viterbi pass picks the likeliest sequence, where changing chord costs a little (so
// one stray frame doesn't flicker the chord). A song's frames are saved, so it's only worked out once.
import { app, BrowserWindow, type WebContents } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Chords } from '../shared/types'
import { audioForAnalysis, MEDIA_SCHEME } from './downloads'
import { takeChroma } from './player'

const FPS = 10 // timeline frames per second of song
const W = 26 // numbers per frame from the page: time, 12 notes, 12 bass notes, loudness (dB)
const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

// A song's timeline: per frame, the 12 notes and 12 bass notes (0..100), loudness, and whether heard.
interface Song {
  id: string
  duration: number
  chroma: Uint8Array
  db: Int8Array
  have: Uint8Array
  dirty: boolean
  full?: boolean // worked out from the whole song at once (not just the parts heard)
  bpm?: number
  result?: Chords
}

const dir = () => join(app.getPath('userData'), 'chords')
// Ids come from the YTM page and name files, so only YouTube's own id characters are let through.
const VALID_ID = /^[\w-]{1,64}$/
const songs = new Map<string, Song>() // the last few songs, most recent last

function blank(id: string, frames: number): Song {
  return { id, duration: 0, chroma: new Uint8Array(frames * 24), db: new Int8Array(frames).fill(-128), have: new Uint8Array(frames), dirty: false }
}

function grow(s: Song, frames: number): void {
  if (frames <= s.have.length) return
  const n = Math.max(frames, Math.ceil(s.have.length * 1.5))
  const g = blank(s.id, n)
  g.chroma.set(s.chroma)
  g.db.set(s.db)
  g.have.set(s.have)
  Object.assign(s, { chroma: g.chroma, db: g.db, have: g.have })
}

function load(id: string): Song {
  let s = songs.get(id)
  if (!s) {
    try {
      const f = JSON.parse(readFileSync(join(dir(), `${id}.json`), 'utf8'))
      const have = Buffer.from(f.have, 'base64')
      s = blank(id, have.length)
      s.duration = f.duration
      s.full = !!f.full
      s.bpm = f.bpm || undefined
      s.have.set(have)
      s.chroma.set(Buffer.from(f.chroma, 'base64'))
      const db = Buffer.from(f.db, 'base64')
      s.db.set(new Int8Array(db.buffer, db.byteOffset, db.byteLength))
    } catch {
      s = blank(id, 0)
    }
  }
  songs.delete(id)
  songs.set(id, s)
  for (const [k, old] of songs) if (songs.size > 4) save(old), songs.delete(k)
  return s
}

function save(s: Song): void {
  if (!s.dirty) return
  s.dirty = false
  try {
    mkdirSync(dir(), { recursive: true })
    const b64 = (a: Uint8Array | Int8Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64')
    writeFileSync(
      join(dir(), `${s.id}.json`),
      JSON.stringify({ duration: s.duration, full: s.full, bpm: s.bpm, have: b64(s.have), chroma: b64(s.chroma), db: b64(s.db) })
    )
  } catch (e) {
    console.error('[chords] save', e)
  }
}

function ingest(s: Song, duration: number, frames: number[]): void {
  if (duration) s.duration = duration
  for (let i = 0; i + W <= frames.length; i += W) {
    const f = Math.round(frames[i] * FPS)
    if (f < 0 || (s.duration && f > s.duration * FPS + 1)) continue
    grow(s, f + 1)
    for (let j = 0; j < 24; j++) s.chroma[f * 24 + j] = frames[i + 1 + j]
    s.db[f] = Math.max(-127, Math.min(127, frames[i + 25]))
    s.have[f] = 1
  }
  s.dirty = true
  s.result = undefined
}

// The 24 triads as unit vectors over the 12 notes: chord c < 12 is major on root c, else minor on c - 12.
const TEMPLATES = Array.from({ length: 24 }, (_, c) => {
  const root = c % 12, t = new Float64Array(12)
  for (const iv of [0, c < 12 ? 4 : 3, 7]) t[(root + iv) % 12] = 1 / Math.sqrt(3)
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

// The key, from the song's overall note balance: 0..11 major on that tonic, 12..23 minor, -1 unknown.
function findKey(total: Float64Array): number {
  let best = -1, score = 0.3
  for (let k = 0; k < 24; k++) {
    const r = correlate(total, k < 12 ? MAJOR : MINOR, k % 12)
    if (r > score) (score = r), (best = k)
  }
  return best
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

function analyze(s: Song): Chords {
  const n = s.have.length
  const heard: number[] = []
  for (let f = 0; f < n; f++) if (s.have[f]) heard.push(f)
  const result: Chords = {
    videoId: s.id,
    key: '',
    chords: [],
    heard: s.full ? 1 : s.duration ? Math.min(1, heard.length / (s.duration * FPS)) : 0,
    tempo: s.bpm
  }
  if (heard.length < FPS) return result

  // Quiet: well below the song's typical loudness (intros, gaps, the fade-out).
  const sorted = heard.map((f) => s.db[f]).sort((a, b) => a - b)
  const quiet = sorted[Math.floor(sorted.length / 2)] - 20

  const total = new Float64Array(12)
  for (const f of heard) if (s.db[f] > quiet) for (let j = 0; j < 12; j++) total[j] += s.chroma[f * 24 + j]
  const key = findKey(total)
  if (key >= 0 && heard.length > 30 * FPS) result.key = `${NOTES[key % 12]} ${key < 12 ? 'major' : 'minor'}`
  const inKey = diatonic(key)

  // Viterbi over 25 states (24 triads, 24 = no chord). Every change costs the same, so each frame
  // only needs the best previous state overall and staying put: O(frames × states).
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
          // The bass usually plays the root.
          const bass = s.chroma[f * 24 + 12 + (k % 12)] / 100
          em[k] = BETA * (dot / norm + 0.15 * bass + (inKey.has(k) ? 0.08 : 0))
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

// `working`: the whole song is being worked out right now. Meanwhile what's been heard live isn't
// shown, so the chords appear once, complete, rather than a few that then change.
const result = (s: Song): Chords =>
  working === s.id ? { videoId: s.id, key: '', chords: [], heard: 0, working: true } : (s.result ??= analyze(s))

export function chordsFor(id: string): Chords {
  if (!VALID_ID.test(id)) return { videoId: id, key: '', chords: [], heard: 0 }
  const s = songOf(id)
  if (timer) want(id)
  return result(s)
}

// The playing song's own copy, even if lookups of other songs have pushed it out of `songs`.
const songOf = (id: string) => (current?.id === id ? current : load(id))

// ---- The whole song at once ----

// Runs in a hidden page (blank, on ytspot-media:// so it can fetch the song): decodes the song,
// plays it through an AnalyserNode offline, reading it every 0.1 s just as the YTM page does while
// a song plays (CHROMA_JS), and works out its tempo. Returns the frames (26 numbers each, as from
// CHROMA_JS), the duration and the beats per minute.
const ANALYZE_JS = `window.__analyze = async (url) => {
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
  const pc = new Int8Array(hi + 1)
  for (let k = lo; k <= hi; k++) pc[k] = ((Math.round(69 + 12 * Math.log2((k * hz) / 440)) % 12) + 12) % 12
  const b = new Float32Array(an.frequencyBinCount), frames = []
  const read = (t) => {
    an.getFloatFrequencyData(b)
    const x = new Float64Array(25)
    for (let k = lo; k <= hi; k++) {
      if (b[k] < -90 || b[k] < b[k - 1] || b[k] < b[k + 1]) continue
      const m = 10 ** (b[k] / 20)
      x[pc[k]] += m
      if (k <= bass) x[12 + pc[k]] += m
      x[24] += m * m
    }
    const top = Math.max(...x.subarray(0, 12)) || 1, low = Math.max(...x.subarray(12, 24)) || 1
    // The window ends at t; stamp its middle.
    frames.push(Math.round((t - FFT / RATE / 2) * 100) / 100)
    for (let i = 0; i < 12; i++) frames.push(Math.round((x[i] / top) * 100))
    for (let i = 12; i < 24; i++) frames.push(Math.round((x[i] / low) * 100))
    frames.push(Math.round(10 * Math.log10(x[24] + 1e-12)))
  }
  for (let i = 0, t = FFT / RATE; t < dur; t = FFT / RATE + ++i * STEP) {
    const at = t
    ctx.suspend(at).then(() => (read(at), ctx.resume()))
  }
  src.start()
  const mono = (await ctx.startRendering()).getChannelData(0)

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
  return { frames, duration: dur, bpm: best && bestScore > 0 ? Math.round((60 * fps) / lag) : 0 }
}`

let analyzer: Promise<WebContents> | null = null
let analyzerWin: BrowserWindow | null = null
function analysisPage(): Promise<WebContents> {
  return (analyzer ??= (async () => {
    const win = (analyzerWin = new BrowserWindow({ show: false, webPreferences: { spellcheck: false, backgroundThrottling: false } }))
    win.on('closed', () => ((analyzer = null), (analyzerWin = null)))
    await win.loadURL(`${MEDIA_SCHEME}://player/`)
    // (Ends with null: the assignment's value, a function, can't be sent back.)
    await win.webContents.executeJavaScript(`${ANALYZE_JS}\nnull`)
    return win.webContents
  })().catch((e) => ((analyzer = null), Promise.reject(e))))
}

// One song at a time, the latest asked for first; one that couldn't be worked out isn't tried
// again for a while (live listening covers it meanwhile).
let wanted: string | null = null
let working: string | null = null
const failed = new Map<string, number>()
const RETRY_MS = 10 * 60 * 1000
function want(id: string): void {
  wanted = id
  if (!working) void work()
}
async function work(): Promise<void> {
  while (wanted) {
    const id = wanted
    wanted = null
    const s = songOf(id)
    if (s.full || Date.now() - (failed.get(id) ?? 0) < RETRY_MS) continue
    working = id
    push()
    let done: (() => void) | undefined
    try {
      const audio = await audioForAnalysis(id)
      done = audio.done
      const r = (await (await analysisPage()).executeJavaScript(`window.__analyze(${JSON.stringify(audio.url)})`)) as {
        frames: number[]
        duration: number
        bpm: number
      }
      // The whole song replaces what was heard of it.
      Object.assign(s, { ...blank(id, Math.ceil(r.duration * FPS) + 1), result: undefined })
      ingest(s, r.duration, r.frames)
      s.full = true
      s.bpm = r.bpm || undefined
      save(s)
    } catch (e) {
      console.error('[chords]', id, (e as Error).message)
      failed.set(id, Date.now())
    } finally {
      done?.()
      working = null
    }
    push()
  }
}

// While on, follow the playing song: work it out whole, take any frames heard live (until it's
// whole), and send its chords whenever they change.
let timer: NodeJS.Timeout | null = null
let current: Song | null = null
let lastSent = ''
let lastSave = 0
let send: (c: Chords) => void = () => undefined
let playing: () => string = () => ''
function push(): void {
  if (!current) return
  const r = result(current)
  const json = JSON.stringify(r)
  if (json !== lastSent) (lastSent = json), send(r)
}
export function setChords(on: boolean, onChords: (c: Chords) => void, nowPlaying: () => string): void {
  send = onChords
  playing = nowPlaying
  if (!on) {
    if (timer) clearInterval(timer)
    timer = null
    for (const s of songs.values()) save(s)
    analyzerWin?.destroy()
    return
  }
  if (timer) return
  const tick = async () => {
    const id = playing()
    if (!id || !VALID_ID.test(id)) return
    if (current?.id !== id) {
      if (current) save(current)
      current = load(id)
      want(id)
    }
    // Live frames are tagged with the YTM page's song, which isn't this one while a downloaded song plays.
    const t = await takeChroma()
    if (t?.id === id && t.frames.length && !current.full) ingest(current, t.duration, t.frames)
    if (Date.now() - lastSave > 30000) (lastSave = Date.now()), save(current)
    push()
  }
  timer = setInterval(tick, 1000)
  void tick()
}

export const saveChords = () => songs.forEach(save)
