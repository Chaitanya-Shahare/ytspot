// Chords for the playing song (for any instrument: the UI shows them as guitar, ukulele or piano
// shapes), worked out from its audio alone, as chroma frames: how strongly each of the 12 notes
// sounds, ten times a second. As soon as a song starts, its whole audio is fetched at full speed
// (the downloaded file, or the low-quality stream) and a hidden page runs it through an
// AnalyserNode offline (ANALYZE_JS), so all its chords are there in a few seconds, along with its
// tuning and tempo. Should that fail, the YTM page listens to the song as it plays (CHROMA_JS in
// player.ts) and hands over the same frames as it goes. Here they're laid out on the song's
// timeline and decoded into chords (chord-detect.ts): each frame is scored against the 24 major and
// minor triads, then a Viterbi pass picks the likeliest sequence, where changing chord costs a
// little (so one stray frame doesn't flicker the chord). A song's frames are saved, so it's only
// worked out once.
import { app, BrowserWindow, type WebContents } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Chords } from '../shared/types'
import { addFrames, ANALYZE_JS, decode, emptyTimeline, FPS, VERSION, type Timeline } from './chord-detect'
import { audioForAnalysis, MEDIA_SCHEME } from './downloads'
import { takeChroma } from './player'

// A song's timeline (see chord-detect.ts), whether it has changes to save, and its chords once decoded.
interface Song extends Timeline {
  id: string
  dirty: boolean
  result?: Chords
}

const dir = () => join(app.getPath('userData'), 'chords')
// Ids come from the YTM page and name files, so only YouTube's own id characters are let through.
const VALID_ID = /^[\w-]{1,64}$/
const songs = new Map<string, Song>() // the last few songs, most recent last

const blank = (id: string, frames: number): Song => ({ id, dirty: false, ...emptyTimeline(frames) })

function load(id: string): Song {
  let s = songs.get(id)
  if (!s) {
    try {
      const f = JSON.parse(readFileSync(join(dir(), `${id}.json`), 'utf8'))
      const have = Buffer.from(f.have, 'base64')
      s = blank(id, have.length)
      s.duration = f.duration
      // Worked out by an older analysis: it's what's known until the song is worked out again.
      s.full = !!f.full && f.v === VERSION
      s.bpm = f.bpm || undefined
      s.tuning = f.tuning || undefined
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
      JSON.stringify({ v: VERSION, duration: s.duration, full: s.full, bpm: s.bpm, tuning: s.tuning, have: b64(s.have), chroma: b64(s.chroma), db: b64(s.db) })
    )
  } catch (e) {
    console.error('[chords] save', e)
  }
}

function ingest(s: Song, duration: number, frames: number[]): void {
  addFrames(s, duration, frames)
  s.dirty = true
  s.result = undefined
}

// `working`: the whole song is being worked out right now. Meanwhile what's been heard live isn't
// shown, so the chords appear once, complete, rather than a few that then change.
const result = (s: Song): Chords =>
  working === s.id ? { videoId: s.id, key: '', chords: [], heard: 0, working: true } : (s.result ??= decode(s.id, s))

export function chordsFor(id: string): Chords {
  if (!VALID_ID.test(id)) return { videoId: id, key: '', chords: [], heard: 0 }
  const s = songOf(id)
  if (timer) want(id)
  return result(s)
}

// The playing song's own copy, even if lookups of other songs have pushed it out of `songs`.
const songOf = (id: string) => (current?.id === id ? current : load(id))

// ---- The whole song at once ----

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
        tuning: number
      }
      // The whole song replaces what was heard of it.
      Object.assign(s, { ...blank(id, Math.ceil(r.duration * FPS) + 1), result: undefined })
      ingest(s, r.duration, r.frames)
      s.full = true
      s.bpm = r.bpm || undefined
      s.tuning = r.tuning || undefined
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
