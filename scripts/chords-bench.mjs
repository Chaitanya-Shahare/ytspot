// Checks the chords against reference charts of real songs, beat by beat (src/main/chord-detect.ts).
// Two steps, so the decoding can be tuned without analysing the audio again:
//
//   npx electron scripts/chords-bench.mjs analyse <audio dir> <cache dir>
//     runs each song (<videoId>.webm / .m4a / .wav) through the app's own hidden-page analysis
//     (ANALYZE_JS) and saves what it heard to <cache dir>/<videoId>.json
//   node scripts/chords-bench.mjs score <cache dir> <refs.json> [--verbose]
//     decodes each song as the app does and scores it against its reference
//
// refs.json: { [videoId]: { chords: "beat;chord;start;end\n…", bpm, bar } }, where each line is one
// beat (its place in the bar from 1, the chord as "C:maj" / "A:min" / "N", and its start and end in
// seconds). Scores: the share of the song's time with the right chord (major/minor, as the app names
// them), beats found (F-measure within 70 ms), the right time signature and bar lines, and how much
// the chords are cut up compared with the reference (chord changes per minute, and changes that fall
// between the reference's beats).
// (Under plain Node, 'electron' is only the path to its binary; the analysis needs the real thing.)
import * as electron from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

const [mode, a, b] = process.argv.slice(2).filter((x) => !x.startsWith('--'))
const verbose = process.argv.includes('--verbose')
const det = await import(new URL('../src/main/chord-detect.ts', import.meta.url).href)

if (mode === 'analyse') {
  const { app, BrowserWindow, protocol } = electron
  const files = readdirSync(a).filter((f) => ['.webm', '.m4a', '.wav', '.mp4'].includes(extname(f)))
  mkdirSync(b, { recursive: true })
  protocol.registerSchemesAsPrivileged([{ scheme: 'benchaudio', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
  // (Not awaited: Electron is only ready once this module has finished loading.)
  app.whenReady().then(async () => {
  protocol.handle('benchaudio', (req) => {
    const f = decodeURIComponent(new URL(req.url).pathname.slice(1))
    if (!f) return new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } })
    const type = f.endsWith('.webm') ? 'audio/webm' : f.endsWith('.wav') ? 'audio/wav' : 'audio/mp4'
    return new Response(readFileSync(join(a, f)), { headers: { 'Content-Type': type } })
  })
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  await win.loadURL('benchaudio://x/')
  await win.webContents.executeJavaScript(`${det.ANALYZE_JS}\nnull`)
  for (const f of files) {
    const out = join(b, basename(f, extname(f)) + '.json')
    if (existsSync(out)) continue
    const t0 = Date.now()
    try {
      const r = await win.webContents.executeJavaScript(`window.__analyze('benchaudio://x/${encodeURIComponent(f)}')`)
      writeFileSync(out, JSON.stringify(r))
      console.log(f, `${((Date.now() - t0) / 1000).toFixed(1)} s`)
    } catch (e) {
      console.log(f, 'failed', e.message)
    }
  }
  app.quit()
  })
} else if (mode === 'score') {
  const refs = JSON.parse(readFileSync(b, 'utf8'))
  const NOTE = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, F: 5, 'E#': 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11 }
  // "A:min7" → "Am" (root and major/minor, as the app names chords); "N" → "".
  const triad = (c) => {
    const [root, q = 'maj'] = c.split(':')
    if (root === 'N' || NOTE[root] === undefined) return ''
    return det.NOTES[NOTE[root]] + (/^(min|dim|hdim)/.test(q) ? 'm' : '')
  }
  const rows = []
  for (const id of Object.keys(refs)) {
    const file = join(a, id + '.json')
    if (!existsSync(file)) continue
    const r = JSON.parse(readFileSync(file, 'utf8'))
    const beats = refs[id].chords.trim().split('\n').map((l) => {
      const [pos, chord, start, end] = l.split(';')
      return { pos: Number(pos), name: triad(chord), time: Number(start), end: Number(end) }
    })
    const tl = { ...det.emptyTimeline(Math.ceil(r.duration * det.FPS) + 1), full: true }
    det.addFrames(tl, r.duration, r.frames)
    tl.onset = Uint8Array.from(r.onset)
    if (r.onsetLow) tl.onsetLow = Uint8Array.from(r.onsetLow)
    const t0 = performance.now()
    const got = det.decode(id, tl)
    const ms = performance.now() - t0
    const at = (list, t) => list.find((c) => c.time <= t && c.end > t)?.name ?? ''
    // Chords: over the reference's beats that have a chord.
    let n = 0, right = 0
    for (const bt of beats) {
      if (!bt.name) continue
      for (let t = bt.time; t < bt.end; t += 0.05) (n++, at(got.chords, t) === bt.name && right++)
    }
    // Beats within 70 ms.
    const refBeats = beats.filter((x) => x.name).map((x) => x.time)
    const ours = (got.beats ?? []).filter((t) => t >= refBeats[0] - 0.5 && t <= refBeats[refBeats.length - 1] + 0.5)
    const hit = (list, t) => list.some((x) => Math.abs(x - t) <= 0.07)
    const p = ours.length ? ours.filter((t) => hit(refBeats, t)).length / ours.length : 0
    const rc = refBeats.length ? refBeats.filter((t) => hit(ours, t)).length / refBeats.length : 0
    const f = p + rc ? (2 * p * rc) / (p + rc) : 0
    // Bar lines: reference downbeats matched by ours (within 70 ms).
    const refDown = beats.filter((x) => x.name && x.pos === 1).map((x) => x.time)
    const ourDown = (got.beats ?? []).filter((_, i) => got.downbeats?.includes(i))
    const down = refDown.length ? refDown.filter((t) => hit(ourDown, t)).length / refDown.length : 0
    // How cut up: changes per minute, ours and the reference's.
    const changes = (list) => list.filter((c, i) => i && c.name && c.name !== list[i - 1].name).length
    const refRuns = []
    for (const bt of beats) refRuns.length && refRuns[refRuns.length - 1].name === bt.name ? (refRuns[refRuns.length - 1].end = bt.end) : refRuns.push({ ...bt })
    const mins = (refBeats[refBeats.length - 1] - refBeats[0]) / 60
    rows.push({
      id,
      chords: Math.round((100 * right) / Math.max(1, n)),
      beatF: Math.round(100 * f),
      meter: `${got.meter ?? '-'}/${refs[id].bar}`,
      bars: Math.round(100 * down),
      bpm: `${got.tempo ?? '-'}/${refs[id].bpm}`,
      chg: `${Math.round(changes(got.chords) / mins)}/${Math.round(changes(refRuns) / mins)}`,
      ms: Math.round(ms)
    })
    if (verbose) {
      console.log(`\n${id}  ref: ${refRuns.slice(0, 24).map((c) => `${c.name || '-'}@${c.time.toFixed(1)}`).join(' ')}`)
      console.log(`${' '.repeat(id.length)}  got: ${got.chords.slice(0, 24).map((c) => `${c.name}@${c.time.toFixed(1)}`).join(' ')}`)
    }
  }
  console.table(rows)
  const mean = (k) => (rows.reduce((s, r) => s + r[k], 0) / rows.length).toFixed(1)
  const meterOk = rows.filter((r) => r.meter.split('/')[0] === r.meter.split('/')[1]).length
  const ratio = rows.reduce((s, r) => s + Number(r.chg.split('/')[0]) / Math.max(1, Number(r.chg.split('/')[1])), 0) / rows.length
  console.log(`${rows.length} songs — chords ${mean('chords')}%, beats F ${mean('beatF')}%, bar lines ${mean('bars')}%, meter ${meterOk}/${rows.length}, changes ×${ratio.toFixed(2)} the reference's, decode ${mean('ms')} ms`)
} else {
  console.log('usage: see the top of this file')
}
