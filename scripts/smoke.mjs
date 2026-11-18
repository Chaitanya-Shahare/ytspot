// Playback smoke test: starts the built app in a throwaway profile (muted, off screen, no media
// keys, never touching the installed app or its data) and checks that the parts that depend on
// YouTube Music's own page still work: play, pause, seek, volume, the queue, next/previous, plus
// search, home, lyrics and chords. YouTube changes its page without warning; this catches it.
//
//   npm run test:smoke                 # build, then test signed out
//   npm run test:smoke -- --signed-in  # with a copy of the installed app's sign-in (read-only;
//                                      # a few seconds of each test song land in your watch history)
//   node scripts/smoke.mjs --no-build  # test what's already in out/
//
// Exits 1 if any check fails. The test app's log is printed at the end when something failed.
import { spawn, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const signedIn = args.has('--signed-in')
// Songs with lyrics, chords and a music video, that have been up for years.
const SONG = { videoId: 'fJ9rUzIMcZQ', title: 'Bohemian Rhapsody', artist: 'Queen' }

if (!args.has('--no-build')) execFileSync('npx', ['electron-vite', 'build'], { cwd: root, stdio: 'ignore' })

// A free port, picked by the OS, so a test app other sessions are running is never driven by mistake.
const freePort = () =>
  new Promise((done) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => done(port))
    })
  })

const profile = mkdtempSync(join(tmpdir(), 'ytspot-smoke-'))
if (signedIn) {
  const cookies = join(homedir(), 'Library/Application Support/ytspot/Partitions/ytm/Cookies')
  if (!existsSync(cookies)) throw new Error('No signed-in installed app to copy the sign-in from.')
  mkdirSync(join(profile, 'Partitions/ytm'), { recursive: true })
  copyFileSync(cookies, join(profile, 'Partitions/ytm/Cookies'))
}
const port = await freePort()
const electron = join(root, 'node_modules/.bin/electron')
const app = spawn(electron, ['.', `--remote-debugging-port=${port}`], {
  cwd: root,
  env: { ...process.env, YTSPOT_PROFILE: profile, YTSPOT_MUTE: '1', YTSPOT_HEADLESS: '1', ELECTRON_RENDERER_URL: '' },
  stdio: 'ignore'
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws
let seq = 0
const waiting = new Map()
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      // This checkout's UI page, nothing else.
      const page = list.find((t) => t.type === 'page' && t.url.startsWith(`file://${join(root, 'out/renderer')}`))
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
        ws.onmessage = (m) => {
          const d = JSON.parse(m.data)
          waiting.get(d.id)?.(d)
          waiting.delete(d.id)
        }
        return
      }
    } catch {
      // not up yet
    }
    await sleep(500)
  }
  throw new Error('The app never came up.')
}
// Runs `expr` in the UI page, where the app's API is `window.ytm`.
function ui(expr) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
  return new Promise((done, fail) => {
    const t = setTimeout(() => fail(new Error(`timed out: ${expr.slice(0, 60)}`)), 30_000)
    waiting.set(id, (d) => {
      clearTimeout(t)
      const ex = d.result?.exceptionDetails
      ex ? fail(new Error(ex.exception?.description ?? ex.text)) : done(d.result?.result?.value)
    })
  })
}
const state = () => ui('window.ytm.state()')
const cmd = (c) => ui(`window.ytm.cmd(${JSON.stringify(c)})`)
// Polls the player until `ok(state)` holds, or fails with what it last saw.
async function until(what, ok, ms = 20_000) {
  const end = Date.now() + ms
  let s
  while (Date.now() < end) {
    s = await state().catch(() => null)
    if (s && ok(s)) return s
    await sleep(400)
  }
  const seen = s ? `${s.videoId} "${s.title}" playing=${s.playing} time=${s.time?.toFixed?.(1)} volume=${s.volume} queue=${s.queue?.length}` : 'no state'
  throw new Error(`${what}; last seen: ${seen}`)
}

const results = []
async function check(name, fn) {
  const t = Date.now()
  try {
    const note = await fn()
    results.push({ name, ok: true, note: note ?? '', ms: Date.now() - t })
  } catch (e) {
    results.push({ name, ok: false, note: e.message, ms: Date.now() - t })
  }
}

try {
  await connect()
  await check('app opens', async () => {
    await until('player page ready', () => true, 30_000)
    const auth = await ui('window.ytm.authStatus()')
    if (signedIn && !auth) throw new Error('not signed in with the copied sign-in')
    return auth ? 'signed in' : 'signed out'
  })
  await check('home loads', async () => {
    const h = await ui('window.ytm.home().then((h) => JSON.stringify(h).length)')
    if (!(h > 1000)) throw new Error(`home came back nearly empty (${h} chars)`)
  })
  await check('search finds songs', async () => {
    const n = await ui(`window.ytm.search(${JSON.stringify(`${SONG.title} ${SONG.artist}`)}).then((r) => r.songs.length + r.shelves.length)`)
    if (!n) throw new Error('no results')
    return `${n} results`
  })
  await check('play a song', async () => {
    await cmd({ type: 'play', videoId: SONG.videoId })
    const s = await until('song playing', (s) => s.videoId === SONG.videoId && s.playing && s.time > 1 && !!s.title)
    return `"${s.title}" by ${s.artist}`
  })
  await check('pause', async () => {
    await cmd({ type: 'toggle' })
    const a = await until('paused', (s) => !s.playing, 5000)
    await sleep(1500)
    const b = await state()
    if (Math.abs(b.time - a.time) > 0.5) throw new Error('time kept moving while paused')
  })
  await check('resume', async () => {
    await cmd({ type: 'toggle' })
    await until('playing again', (s) => s.playing, 5000)
  })
  await check('seek', async () => {
    await cmd({ type: 'seek', seconds: 90 })
    await until('at 1:30', (s) => s.time >= 89 && s.time < 100, 8000)
  })
  await check('volume', async () => {
    const before = (await state()).volume
    const to = before === 40 ? 60 : 40
    await cmd({ type: 'volume', value: to })
    await until(`volume ${to}`, (s) => Math.abs(s.volume - to) <= 1, 5000)
    await cmd({ type: 'volume', value: before })
  })
  await check('queue fills', async () => {
    const s = await until('queue or autoplay has songs', (s) => s.queue.length + s.autoplay.length > 1, 15_000)
    return `${s.queue.length} queued, ${s.autoplay.length} autoplay`
  })
  await check('next', async () => {
    await cmd({ type: 'next' })
    const s = await until('another song playing', (s) => s.videoId !== SONG.videoId && !s.pending && s.playing && !!s.title)
    return `"${s.title}"`
  })
  await check('previous', async () => {
    await cmd({ type: 'prev' })
    await until('back to the first song', (s) => s.videoId === SONG.videoId && s.playing)
  })
  await check('lyrics', async () => {
    const s = await state()
    const q = { videoId: s.videoId, title: s.title, artist: s.artist, album: s.album, duration: s.duration }
    const l = await ui(`window.ytm.lyrics(${JSON.stringify(q)})`)
    if (!l) throw new Error('none found')
    return l.synced ? 'synced' : 'plain'
  })
  // Experimental and off by default; switched on in this throwaway profile only.
  await check('chords', async () => {
    await ui(`window.ytm.setPrefs({ keepPlaying: true, videoMode: false, openAtLogin: false, menuBar: 'off', menuBarIcon: 'note', autoUpdate: false, chords: true })`)
    const end = Date.now() + 120_000
    while (Date.now() < end) {
      const c = await ui(`window.ytm.chords(${JSON.stringify(SONG.videoId)})`)
      if (c?.chords?.length) return `${c.chords.length} chords, key ${c.key || '?'}`
      await sleep(2000)
    }
    throw new Error('no chords after 2 minutes')
  })
  // Crashes, hangs and the UI's own errors fail the run; other error lines (a YouTube request
  // that failed, a page reloading mid-call) are listed but can be noise.
  await check('no crashes, hangs or UI errors in the log', async () => {
    const lines = readFileSync(join(profile, 'logs/main.log'), 'utf8').split('\n').filter((l) => / ERROR | WARN  \[hang\]/.test(l))
    const bad = lines.filter((l) => /\[(crash|hang|ui|ui console)\]/.test(l))
    if (bad.length) throw new Error(`${bad.length} lines, first: ${bad[0].slice(30, 200)}`)
    if (lines.length) return `${lines.length} other error line(s), first: ${lines[0].slice(30, 160)}`
  })
} catch (e) {
  results.push({ name: 'run', ok: false, note: e.message, ms: 0 })
} finally {
  ws?.close()
  app.kill()
}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(42)} ${(r.ms / 1000).toFixed(1).padStart(5)}s  ${r.note}`)
console.log(`\n${results.length - failed.length}/${results.length} passed${signedIn ? ' (signed in)' : ' (signed out)'}`)
if (failed.length) {
  try {
    console.log(`\nTest app log:\n${readFileSync(join(profile, 'logs/main.log'), 'utf8')}`)
  } catch {
    // no log written
  }
}
await sleep(1000)
rmSync(profile, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
