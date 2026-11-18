// Soak test: keeps the built app playing for days in a throwaway profile (muted, off screen, no
// media keys, signed out so nothing lands in anyone's watch history) and records how it holds up:
// songs played, playback that stalls or stops by itself, crashes and hangs, and memory over time
// (from the app's hourly [health] log lines). Finds the bugs that only show after days of use.
//
//   npm run soak                      # 48 hours
//   node scripts/soak.mjs --hours 72  # longer
//   node scripts/soak.mjs --no-build  # test what's already in out/
//
// Everything goes to ~/Library/Logs/ytspot-soak/<start time>/: report.md (rewritten every 10
// minutes, so it's readable mid-run), samples.jsonl (one line a minute) and the app's own logs.
// Stop it early with Ctrl+C or `pkill -f scripts/soak.mjs`; the report is finished either way.
// The Mac sleeping pauses the run; that's fine, and shows in the log as [power] suspend/resume.
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const hours = Number(argv[argv.indexOf('--hours') + 1]) || 48
// A long song with a long radio after it; autoplay keeps it going.
const START = 'fJ9rUzIMcZQ'

if (!argv.includes('--no-build')) execFileSync('npx', ['electron-vite', 'build'], { cwd: root, stdio: 'ignore' })

const started = new Date()
const p2 = (n) => String(n).padStart(2, '0')
const folder = `${started.getFullYear()}-${p2(started.getMonth() + 1)}-${p2(started.getDate())}-${p2(started.getHours())}${p2(started.getMinutes())}`
const out = join(homedir(), 'Library/Logs/ytspot-soak', folder)
const profile = join(out, 'profile')
mkdirSync(profile, { recursive: true })
const port = await new Promise((done) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address()
    s.close(() => done(port))
  })
})
const app = spawn(join(root, 'node_modules/.bin/electron'), ['.', `--remote-debugging-port=${port}`], {
  cwd: root,
  env: { ...process.env, YTSPOT_PROFILE: profile, YTSPOT_MUTE: '1', YTSPOT_HEADLESS: '1', ELECTRON_RENDERER_URL: '' },
  stdio: 'ignore'
})
let appExit = null
app.on('exit', (code, signal) => (appExit = `${code ?? signal}`))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toLocaleString('en-GB', { hour12: false })
let ws = null
let seq = 0
const waiting = new Map()
async function connect() {
  ws?.close()
  ws = null
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.url.startsWith(`file://${join(root, 'out/renderer')}`))
  if (!page) throw new Error('UI page not found')
  const s = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => ((s.onopen = r), (s.onerror = j)))
  s.onmessage = (m) => {
    const d = JSON.parse(m.data)
    waiting.get(d.id)?.(d)
    waiting.delete(d.id)
  }
  s.onclose = () => ws === s && (ws = null)
  ws = s
}
async function ui(expr) {
  if (!ws) await connect()
  const id = ++seq
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
  return new Promise((done, fail) => {
    const t = setTimeout(() => (waiting.delete(id), fail(new Error('UI page not answering'))), 20_000)
    waiting.set(id, (d) => (clearTimeout(t), done(d.result?.result?.value)))
  })
}
const cmd = (c) => ui(`window.ytm.cmd(${JSON.stringify(c)})`)

// What happened, for the report.
const stats = { songs: new Set(), changes: 0, stalls: [], stops: [], recoveries: 0, noAnswer: 0, samples: 0 }
const event = (list, what) => list.push(`${stamp()}: ${what}`)

// Both files, in case the log rotated during the run.
function logLines() {
  return ['main.1.log', 'main.log'].flatMap((f) => {
    try {
      return readFileSync(join(profile, 'logs', f), 'utf8').split('\n')
    } catch {
      return []
    }
  })
}
function report(final) {
  const lines = logLines()
  const count = (re) => lines.filter((l) => re.test(l)).length
  const health = lines.filter((l) => l.includes('[health]'))
  const mem = (l) => Number(l.match(/memory (\d+) MB/)?.[1])
  const first = health[0], last = health.at(-1)
  const ranH = (Date.now() - started) / 3600_000
  let growth = 'not enough [health] lines yet (hourly)'
  if (first && last && first !== last) {
    const upH = (l) => Number(l.match(/up ([\d.]+)h/)?.[1])
    const perDay = ((mem(last) - mem(first)) / Math.max(0.1, upH(last) - upH(first))) * 24
    growth = `${mem(first)} MB → ${mem(last)} MB (${perDay >= 0 ? '+' : ''}${Math.round(perDay)} MB/day)`
  }
  const list = (a) => (a.length ? a.slice(-20).map((x) => `- ${x}`).join('\n') : '- none')
  const md = `# ytspot soak run ${final ? '(finished)' : '(running)'}

Started ${started.toLocaleString('en-GB', { hour12: false })}, ran ${ranH.toFixed(1)} of ${hours} hours. Updated ${stamp()}.
${appExit ? `\n**The app exited by itself (${appExit}).**\n` : ''}
| | |
|---|---|
| Songs played | ${stats.songs.size} different, ${stats.changes} changes |
| Playback stalled (playing, clock stuck 2+ min) | ${stats.stalls.length} |
| Playback stopped by itself (2+ min) | ${stats.stops.length} (nudged back ${stats.recoveries} times) |
| UI page not answering (samples) | ${stats.noAnswer} of ${stats.samples} |
| Crashes in the log | ${count(/ \[crash\] /)} |
| Hangs in the log | ${count(/ \[hang\] .*stopped/)} |
| Error lines in the log | ${count(/ ERROR /)} |
| Sleep / wake | ${count(/\[power\] suspend/)} / ${count(/\[power\] resume/)} |
| Memory (all processes) | ${growth} |

## Stalls
${list(stats.stalls)}

## Stops
${list(stats.stops)}

## Memory, hourly
${health.length ? health.map((l) => `- ${l.slice(0, 19)} ${l.slice(l.indexOf('up '))}`).join('\n') : '- none yet'}

## Errors in the log (last 30)
${lines.filter((l) => / ERROR /.test(l)).slice(-30).map((l) => `- ${l.slice(0, 300)}`).join('\n') || '- none'}

The app's full log: ${join(final ? out : profile, 'logs')}
`
  writeFileSync(join(out, 'report.md'), md)
}

let finished = false
function finish() {
  if (finished) return
  finished = true
  report(true)
  app.kill()
  // Keep the logs; drop the profile's caches (hundreds of MB).
  setTimeout(() => {
    try {
      cpSync(join(profile, 'logs'), join(out, 'logs'), { recursive: true })
      rmSync(profile, { recursive: true, force: true })
    } catch {
      // nothing to copy
    }
    console.log(`Report: ${join(out, 'report.md')}`)
    process.exit(0)
  }, 2000)
}
process.on('SIGINT', finish)
process.on('SIGTERM', finish)

console.log(`Soak running for ${hours}h. Report: ${join(out, 'report.md')}`)
for (let i = 0; i < 60 && !ws; i++) await connect().catch(() => sleep(1000))
await sleep(3000)
await cmd({ type: 'play', videoId: START })

// Once a minute: where playback is. Stuck or stopped for 2 minutes in a row counts as an incident,
// and gets nudged back (resume, then a fresh start) so the run carries on.
let last = null
let stuckSince = 0
let stoppedSince = 0
const end = Date.now() + hours * 3600_000
let nextReport = 0
while (Date.now() < end && !finished && !appExit) {
  await sleep(60_000)
  stats.samples++
  const s = await ui('window.ytm.state()').catch(() => undefined)
  if (s === undefined) {
    stats.noAnswer++
    appendFileSync(join(out, 'samples.jsonl'), JSON.stringify({ t: Date.now(), answer: false }) + '\n')
    continue
  }
  appendFileSync(join(out, 'samples.jsonl'), JSON.stringify({ t: Date.now(), id: s?.videoId, playing: s?.playing, time: s?.time, queue: s?.queue?.length, autoplay: s?.autoplay?.length }) + '\n')
  if (s?.videoId) stats.songs.add(s.videoId)
  if (s && last && s.videoId !== last.videoId) stats.changes++
  const now = Date.now()
  if (s?.playing && last?.playing && s.videoId === last.videoId && Math.abs(s.time - last.time) < 1) {
    stuckSince ||= now - 60_000
    if (now - stuckSince >= 120_000) {
      event(stats.stalls, `stuck at ${Math.round(s.time)}s of ${s.videoId} "${s.title}"`)
      await cmd({ type: 'next' }).catch(() => undefined)
      stuckSince = 0
    }
  } else stuckSince = 0
  if (!s?.playing) {
    stoppedSince ||= now
    if (now - stoppedSince >= 120_000) {
      event(stats.stops, s ? `stopped at ${Math.round(s.time)}s of ${s.videoId} "${s.title}" (queue ${s.queue.length}, autoplay ${s.autoplay.length})` : 'no player state')
      await cmd({ type: 'toggle' }).catch(() => undefined)
      await sleep(5000)
      const again = await ui('window.ytm.state()').catch(() => null)
      if (!again?.playing) await cmd({ type: 'play', videoId: START }).catch(() => undefined)
      stats.recoveries++
      stoppedSince = 0
    }
  } else stoppedSince = 0
  last = s
  if (now >= nextReport) {
    report(false)
    nextReport = now + 10 * 60_000
  }
}
finish()
