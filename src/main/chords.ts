// Guitar chords for the playing song, worked out from its audio alone. The YTM page listens to the
// song as it plays (CHROMA_JS in player.ts) and hands over chroma frames: how strongly each of the
// 12 notes sounds, ten times a second. Here they're laid out on the song's timeline and decoded
// into chords: each frame is scored against the 24 major and minor triads, then a Viterbi pass
// picks the likeliest sequence, where changing chord costs a little (so one stray frame doesn't
// flicker the chord). A song's frames are saved, so a song heard before has its chords from the start.
import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Chords } from '../shared/types'
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
    writeFileSync(join(dir(), `${s.id}.json`), JSON.stringify({ duration: s.duration, have: b64(s.have), chroma: b64(s.chroma), db: b64(s.db) }))
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
  const result: Chords = { videoId: s.id, key: '', chords: [], heard: s.duration ? Math.min(1, heard.length / (s.duration * FPS)) : 0 }
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

const result = (s: Song) => (s.result ??= analyze(s))

export function chordsFor(id: string): Chords {
  if (!VALID_ID.test(id)) return { videoId: id, key: '', chords: [], heard: 0 }
  return result(load(id))
}

// While on, take the page's new frames every second and send the playing song's chords when they change.
let timer: NodeJS.Timeout | null = null
let current: Song | null = null
let lastSent = ''
let lastSave = 0
export function setChords(on: boolean, send: (c: Chords) => void): void {
  if (!on) {
    if (timer) clearInterval(timer)
    timer = null
    for (const s of songs.values()) save(s)
    return
  }
  if (timer) return
  timer = setInterval(async () => {
    const t = await takeChroma()
    if (!t?.id || !VALID_ID.test(t.id)) return
    if (current?.id !== t.id) {
      if (current) save(current)
      current = load(t.id)
    }
    if (t.frames.length) ingest(current, t.duration, t.frames)
    if (Date.now() - lastSave > 30000) (lastSave = Date.now()), save(current)
    // The song being heard, even if lookups of other songs have pushed it out of `songs`.
    const r = result(current)
    const json = JSON.stringify(r)
    if (json !== lastSent) (lastSent = json), send(r)
  }, 1000)
}

export const saveChords = () => songs.forEach(save)
