// How well the chords come out (src/main/chord-detect.ts), on songs whose chords are known:
// synthesised ones (piano, strummed guitar, bass, drums, a sung-ish melody, 7ths and inversions),
// run through the very same hidden-page analysis and decoding the app uses. Headless.
//
//   npx electron scripts/chords-eval.mjs            # the synthesised songs, with a score each
//   npx electron scripts/chords-eval.mjs song.webm  # also print what's heard in real files
//
// Scores are the share of the song's time with the right chord (major/minor, as the app names
// them; a 7th counts as its triad), and the right root alone.
import { app, BrowserWindow, protocol } from 'electron'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const { ANALYZE_JS, addFrames, decode, emptyTimeline, NOTES } = await import(new URL('../src/main/chord-detect.ts', import.meta.url).href)

const RATE = 22050
const NAMES = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 }
// "Am7/G" → root 9, minor, intervals [0 3 7 10], bass 7.
function chord(name) {
  const m = name.match(/^([A-G][#b]?)(m(?!aj))?(maj7|7|sus4|sus2)?(?:\/([A-G][#b]?))?$/)
  if (!m) throw new Error(`chord ${name}`)
  const root = NAMES[m[1]], minor = !!m[2]
  const iv = m[3] === 'sus4' ? [0, 5, 7] : m[3] === 'sus2' ? [0, 2, 7] : [0, minor ? 3 : 4, 7]
  if (m[3] === '7') iv.push(10)
  if (m[3] === 'maj7') iv.push(11)
  return { root, minor, iv, bass: m[4] ? NAMES[m[4]] : root, label: NOTES[root] + (minor ? 'm' : '') }
}
// `cents`: the song's tuning off A440 (old records, tape run fast or slow).
let cents = 0
const hz = (midi) => 440 * 2 ** ((midi - 69 + cents / 100) / 12)
// Lowest midi note of pitch class pc at or above `from`.
const above = (pc, from) => from + ((pc - from) % 12 + 12) % 12

// A deterministic random, so every run hears the same songs.
let seed = 1
const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646

function piano(out, at, midi, len, vel) {
  const f = hz(midi), s0 = Math.floor(at * RATE), n = Math.min(out.length - s0, Math.floor((len + 0.6) * RATE))
  for (let h = 1; h <= 8; h++) {
    const fh = f * h * Math.sqrt(1 + 0.0004 * h * h), a = vel / h ** 1.3, dk = 1.2 + h * 0.6
    if (fh > RATE / 2) break
    for (let i = 0; i < n; i++) {
      const t = i / RATE, rel = t > len ? Math.exp(-(t - len) * 12) : 1
      out[s0 + i] += a * Math.sin(2 * Math.PI * fh * t) * Math.exp(-t * dk) * Math.min(1, t * 200) * rel
    }
  }
}
// Karplus–Strong plucked string.
function pluck(out, at, midi, len, vel) {
  const p = Math.round(RATE / hz(midi)), buf = new Float64Array(p), s0 = Math.floor(at * RATE)
  for (let i = 0; i < p; i++) buf[i] = rnd() * 2 - 1
  const n = Math.min(out.length - s0, Math.floor(len * RATE))
  for (let i = 0, j = 0; i < n; i++, j = (j + 1) % p) {
    const next = (j + 1) % p, v = buf[j]
    buf[j] = 0.996 * 0.5 * (v + buf[next])
    out[s0 + i] += vel * v * (i > n - 600 ? (n - i) / 600 : 1)
  }
}
function bass(out, at, midi, len, vel) {
  const f = hz(midi), s0 = Math.floor(at * RATE), n = Math.min(out.length - s0, Math.floor(len * RATE))
  for (let i = 0; i < n; i++) {
    const t = i / RATE, env = Math.min(1, t * 300) * Math.exp(-t * 2) * (i > n - 300 ? (n - i) / 300 : 1)
    out[s0 + i] += vel * env * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t) + 0.25 * Math.sin(6 * Math.PI * f * t))
  }
}
function voice(out, at, midi, len, vel) {
  const f = hz(midi), s0 = Math.floor(at * RATE), n = Math.min(out.length - s0, Math.floor(len * RATE))
  let ph = 0
  for (let i = 0; i < n; i++) {
    const t = i / RATE, env = Math.min(1, t * 20) * Math.min(1, (n - i) / (0.05 * RATE))
    ph += (2 * Math.PI * f * (1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t))) / RATE
    out[s0 + i] += vel * env * (Math.sin(ph) + 0.4 * Math.sin(2 * ph) + 0.2 * Math.sin(3 * ph))
  }
}
function drum(out, at, kind, vel) {
  const s0 = Math.floor(at * RATE), n = Math.min(out.length - s0, Math.floor(0.25 * RATE))
  let ph = 0, last = 0
  for (let i = 0; i < n; i++) {
    const t = i / RATE
    if (kind === 'kick') (ph += (2 * Math.PI * (50 + 90 * Math.exp(-t * 30))) / RATE), (out[s0 + i] += vel * Math.sin(ph) * Math.exp(-t * 12))
    else {
      const w = rnd() * 2 - 1, hi = w - last
      last = w
      out[s0 + i] += kind === 'hat' ? vel * 0.5 * hi * Math.exp(-t * 60) : vel * w * Math.exp(-t * 18)
    }
  }
}

// A song: `chart` is chord names, each a bar of 4 beats unless "name:beats".
function render({ bpm, chart, style, intro = 0, melody = true, drums = true, fade = 0, detune = 0 }) {
  cents = detune
  const beat = 60 / bpm
  const bars = chart.map((c) => {
    const [name, beats] = c.split(':')
    return { ...chord(name), name, beats: Number(beats || 4) }
  })
  const total = intro + bars.reduce((t, b) => t + b.beats * beat, 0) + 2 + fade
  const out = new Float64Array(Math.ceil(total * RATE))
  const truth = []
  let t = intro
  const scale = bars[0].minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]
  const tonic = bars[0].root
  for (const b of bars) {
    const len = b.beats * beat
    truth.push({ time: t, end: t + len, name: b.label })
    const notes = b.iv.map((i) => above((b.root + i) % 12, 55))
    if (style === 'piano') for (let k = 0; k < b.beats; k += 2) for (const m of notes) piano(out, t + k * beat, m, 2 * beat, 0.18)
    if (style === 'arp') for (let k = 0; k < b.beats * 2; k++) piano(out, t + (k * beat) / 2, notes[k % notes.length] + (k % 6 >= 3 ? 12 : 0), beat, 0.25)
    if (style === 'guitar') {
      // Down, down-up, up-down-up strums of a six-string voicing.
      const v = [above(b.bass, 40), above(b.root, 47), ...notes.map((m) => m), above(b.root, 64)]
      for (const off of [0, 1, 1.5, 2.5, 3, 3.5].filter((o) => o < b.beats))
        v.forEach((m, i) => pluck(out, t + off * beat + (off % 1 ? (v.length - i) : i) * 0.012, m, beat * 1.2, off % 1 ? 0.12 : 0.2))
    }
    if (style === 'pad') for (const m of notes) for (let k = 0; k < b.beats; k++) voice(out, t + k * beat, m, beat, 0.06)
    for (let k = 0; k < b.beats; k++) bass(out, t + k * beat, above(b.bass, 33), beat * 0.9, 0.3)
    if (drums)
      for (let k = 0; k < b.beats; k++) {
        if (k % 2 === 0) drum(out, t + k * beat, 'kick', 0.6)
        else drum(out, t + k * beat, 'snare', 0.25)
        drum(out, t + k * beat, 'hat', 0.2)
        drum(out, t + (k + 0.5) * beat, 'hat', 0.15)
      }
    if (melody)
      // Mostly chord notes on the beat, passing scale notes between.
      for (let k = 0; k < b.beats; k++) {
        const pc = rnd() < 0.6 ? b.iv[Math.floor(rnd() * b.iv.length)] + b.root : tonic + scale[Math.floor(rnd() * 7)]
        voice(out, t + k * beat, above(pc % 12, 67), beat * 0.95, 0.12)
      }
    t += len
  }
  if (fade) for (let i = Math.floor((t - fade) * RATE); i < out.length; i++) out[i] *= Math.max(0, 1 - (i / RATE - (t - fade)) / fade)
  return { wav: wav(out), truth, duration: total }
}

function wav(x) {
  let peak = 0
  for (const v of x) peak = Math.max(peak, Math.abs(v))
  const b = Buffer.alloc(44 + x.length * 2)
  b.write('RIFF', 0), b.writeUInt32LE(36 + x.length * 2, 4), b.write('WAVEfmt ', 8), b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20), b.writeUInt16LE(1, 22), b.writeUInt32LE(RATE, 24), b.writeUInt32LE(RATE * 2, 28)
  b.writeUInt16LE(2, 32), b.writeUInt16LE(16, 34), b.write('data', 36), b.writeUInt32LE(x.length * 2, 40)
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round((x[i] / peak) * 0.8 * 32767), 44 + i * 2)
  return b
}

const rep = (n, a) => Array.from({ length: n }, () => a).flat()
const SONGS = [
  { name: 'I–V–vi–IV piano, C major', key: 'C major', bpm: 100, style: 'piano', chart: rep(6, ['C', 'G', 'Am', 'F']) },
  { name: 'i–VI–III–VII guitar, A minor', key: 'A minor', bpm: 120, style: 'guitar', chart: rep(6, ['Am', 'F', 'C', 'G']) },
  { name: 'Arpeggios, E major', key: 'E major', bpm: 76, style: 'arp', chart: rep(4, ['E', 'B', 'C#m', 'A']) },
  { name: 'Two-beat changes, D minor', key: 'D minor', bpm: 132, style: 'piano', chart: rep(8, ['Dm:2', 'Bb:2', 'F:2', 'C:2']) },
  { name: 'Sevenths, G major', key: 'G major', bpm: 92, style: 'piano', chart: rep(5, ['Gmaj7', 'Em7', 'Am7', 'D7']) },
  { name: 'Inversions (C/E, G/B)', key: 'C major', bpm: 84, style: 'guitar', chart: rep(5, ['C', 'G/B', 'Am', 'C/G', 'F', 'C/E', 'Dm', 'G']) },
  { name: 'Ballad pad, Eb major', key: 'Eb major', bpm: 70, style: 'pad', chart: rep(4, ['Eb', 'Cm', 'Ab', 'Bb']), drums: false },
  { name: 'Verse/chorus, F# minor, intro + fade', key: 'F# minor', bpm: 110, style: 'guitar', intro: 4, fade: 8, chart: [...rep(3, ['F#m', 'D', 'A', 'E']), ...rep(3, ['D', 'E', 'C#m', 'F#m']), ...rep(2, ['F#m', 'D', 'A', 'E'])] },
  { name: 'Blues-ish I–IV–V, A major', key: 'A major', bpm: 118, style: 'guitar', chart: rep(2, ['A', 'A', 'A', 'A', 'D', 'D', 'A', 'A', 'E', 'D', 'A', 'E']) },
  { name: 'Suspensions resolve (Dsus4→D)', key: 'D major', bpm: 96, style: 'piano', chart: rep(4, ['D', 'Dsus4:2', 'D:2', 'G', 'A']) },
  { name: 'Tuned 40 cents sharp, Bb major', key: 'Bb major', bpm: 104, style: 'guitar', detune: 40, chart: rep(5, ['Bb', 'F', 'Gm', 'Eb']) },
  { name: 'Tuned 30 cents flat, B minor', key: 'B minor', bpm: 88, style: 'piano', detune: -30, chart: rep(5, ['Bm', 'G', 'D', 'A']) }
]

const audio = new Map()
protocol.registerSchemesAsPrivileged([{ scheme: 'evalaudio', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
app.whenReady().then(async () => {
  protocol.handle('evalaudio', (req) => {
    const id = new URL(req.url).pathname.slice(1)
    if (!id) return new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } })
    const a = audio.get(decodeURIComponent(id))
    return a ? new Response(a.data, { headers: { 'Content-Type': a.type } }) : new Response(null, { status: 404 })
  })
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  await win.loadURL('evalaudio://x/')
  await win.webContents.executeJavaScript(`${ANALYZE_JS}\nnull`)
  const analyse = async (id) => {
    const t0 = Date.now()
    const r = await win.webContents.executeJavaScript(`window.__analyze('evalaudio://x/${encodeURIComponent(id)}')`)
    const tl = { ...emptyTimeline(Math.ceil(r.duration * 10) + 1), full: true, bpm: r.bpm || undefined }
    if (process.env.VERBOSE) console.log(id, 'tuning', r.tuning)
    addFrames(tl, r.duration, r.frames)
    return { ...decode(id, tl), ms: Date.now() - t0 }
  }

  const at = (list, t) => list.find((c) => c.time <= t && c.end > t)?.name ?? ''
  const rows = []
  for (const s of SONGS) {
    const { wav: data, truth } = render(s)
    audio.set(s.name, { data, type: 'audio/wav' })
    const got = await analyse(s.name)
    let n = 0, right = 0, root = 0
    for (let t = truth[0].time; t < truth[truth.length - 1].end; t += 0.05) {
      const want = at(truth, t), have = at(got.chords, t)
      n++
      if (want === have) right++
      if (have && want.replace('m', '') === have.replace('m', '')) root++
    }
    rows.push({ song: s.name, chords: `${Math.round((100 * right) / n)}%`, roots: `${Math.round((100 * root) / n)}%`, key: `${got.key || '–'}${got.key === s.key ? ' ✓' : ` (${s.key})`}`, tempo: `${got.tempo ?? '–'}${got.tempo && [0.5, 1, 2].some((m) => Math.abs(got.tempo - s.bpm * m) <= 2) ? ' ✓' : ` (${s.bpm})`}`, ms: got.ms })
    if (process.env.VERBOSE) {
      console.log(`\n${s.name}\n  want: ${truth.slice(0, 16).map((c) => c.name).join(' ')}\n  got:  ${got.chords.slice(0, 16).map((c) => `${c.name}@${c.time.toFixed(1)}`).join(' ')}`)
    }
  }
  console.table(rows)
  const mean = (k) => Math.round(rows.reduce((a, r) => a + parseInt(r[k]), 0) / rows.length)
  console.log(`mean: chords ${mean('chords')}%, roots ${mean('roots')}%, keys ${rows.filter((r) => r.key.endsWith('✓')).length}/${rows.length}, tempos ${rows.filter((r) => r.tempo.endsWith('✓')).length}/${rows.length}`)

  for (const file of process.argv.slice(2).filter((a) => !a.startsWith('-') && !a.endsWith('chords-eval.mjs'))) {
    audio.set(basename(file), { data: readFileSync(file), type: file.endsWith('.webm') ? 'audio/webm' : file.endsWith('.wav') ? 'audio/wav' : 'audio/mp4' })
    const got = await analyse(basename(file))
    console.log(`\n${basename(file)}: key ${got.key || '–'}, ${got.tempo ?? '–'} BPM, ${got.chords.length} chords, ${got.ms} ms`)
    let line = ''
    for (const c of got.chords) {
      const cell = `${c.time.toFixed(1).padStart(6)} ${c.name.padEnd(4)}`
      if (line.length + cell.length > 110) (console.log(line), (line = ''))
      line += cell
    }
    console.log(line)
  }
  app.quit()
})
