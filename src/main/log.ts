// The app's log, kept on disk so a bug can be looked into after the fact, including ones that only
// show up after days of running: ~/Library/Logs/ytspot/main.log (Help → Reveal Logs in Finder;
// Help → Report a Problem copies the recent part).
// Everything written with console.* in the main process goes in, along with crashes, hangs, sleep
// and wake, the UI page's errors, and an hourly health line (memory, uptime) for slow leaks.
//
// Imported first (see index.ts), so the console is captured before any other module runs.
// Cookies and auth headers are blanked out; song ids and titles are kept.
import { app, crashReporter, net, powerMonitor, webContents, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { inspect } from 'node:util'

// A test run (YTSPOT_PROFILE, see index.ts) logs into its own profile, away from the installed app's log.
const testProfile = process.env.YTSPOT_PROFILE
if (testProfile) {
  app.setAppLogsPath(join(testProfile, 'logs'))
  app.setPath('crashDumps', join(testProfile, 'Crashpad'))
}
export const logDir = app.getPath('logs')
export const logFile = join(logDir, 'main.log')

// 5 files of 5 MB: weeks of history at the usual rate of a few hundred lines a day.
const MAX_BYTES = 5 * 1024 * 1024
const KEEP = 4 // main.1.log … main.4.log
const MAX_LINE = 4000

let size = 0
try {
  mkdirSync(logDir, { recursive: true })
  size = statSync(logFile).size
} catch {
  // no log yet
}

function rotate(): void {
  try {
    rmSync(join(logDir, `main.${KEEP}.log`), { force: true })
    for (let i = KEEP - 1; i >= 1; i--) {
      try {
        renameSync(join(logDir, `main.${i}.log`), join(logDir, `main.${i + 1}.log`))
      } catch {
        // that one doesn't exist yet
      }
    }
    renameSync(logFile, join(logDir, 'main.1.log'))
  } catch {
    // another copy of the app rotated it first
  }
  size = 0
}

// Local time with its offset, so a line lines up with "it happened around 9 last night".
const pad = (n: number, w = 2) => String(n).padStart(w, '0')
function stamp(d = new Date()): string {
  const off = -d.getTimezoneOffset()
  const tz = `${off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${tz}`
}

const SECRETS: [RegExp, string][] = [
  [/\b(SAPISID|APISID|SSID|HSID|SID|__Secure-[\w-]+|LOGIN_INFO)=[^;\s"']+/g, '$1=…'],
  [/\b(authorization|cookie|x-goog-authuser)(["']?\s*[:=]\s*["']?)[^"'\n]+/gi, '$1$2…']
]
const scrub = (s: string) => SECRETS.reduce((t, [re, to]) => t.replace(re, to), s)

const text = (args: unknown[]) =>
  args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : inspect(a, { depth: 3, breakLength: Infinity })))
    .join(' ')

function write(line: string): void {
  try {
    if (size > MAX_BYTES) rotate()
    appendFileSync(logFile, line)
    size += Buffer.byteLength(line)
  } catch {
    // a full or read-only disk mustn't break the app
  }
}

// The same message again (a page that keeps failing every second) is counted, not written again,
// so one stuck loop can't push weeks of history out of the log.
let last = ''
let repeats = 0
let repeatTimer: NodeJS.Timeout | undefined
function flushRepeats(): void {
  clearTimeout(repeatTimer)
  if (repeats) write(`${stamp()}       … repeated ${repeats} more time${repeats > 1 ? 's' : ''}\n`)
  repeats = 0
}

export type Level = 'debug' | 'info' | 'warn' | 'error'
export function log(level: Level, ...args: unknown[]): void {
  let msg: string
  try {
    msg = scrub(text(args))
  } catch {
    msg = '(a message that couldn’t be turned into text)'
  }
  if (msg.length > MAX_LINE) msg = `${msg.slice(0, MAX_LINE)}… (${msg.length} chars)`
  const key = `${level} ${msg}`
  if (key === last) {
    repeats++
    clearTimeout(repeatTimer)
    repeatTimer = setTimeout(flushRepeats, 60_000)
    return
  }
  flushRepeats()
  last = key
  write(`${stamp()} ${level.toUpperCase().padEnd(5)} ${msg.replace(/\n/g, '\n    ')}\n`)
}

// console.* still prints (for `npm run dev`), and goes to the file too.
for (const [method, level] of [['log', 'info'], ['info', 'info'], ['debug', 'debug'], ['warn', 'warn'], ['error', 'error']] as const) {
  const original = console[method].bind(console)
  console[method] = (...args: unknown[]) => {
    original(...args)
    log(level, ...args)
  }
}

// Observed without changing what happens next: Electron's own error dialog still shows for an
// uncaught exception, and an unhandled rejection, which Electron only prints a warning for, is
// written here instead.
process.on('uncaughtExceptionMonitor', (e, origin) => log('error', `[crash] ${origin}:`, e))
process.on('unhandledRejection', (e) => log('error', '[crash] unhandled rejection:', e))

// Native crashes leave a minidump here (nothing is uploaded anywhere).
crashReporter.start({ uploadToServer: false })

// Which page a line is about: the app's own UI, the hidden YouTube Music player, or sign-in.
export function pageName(wc: WebContents): string {
  const url = wc.isDestroyed() ? '' : wc.getURL()
  if (url.includes('music.youtube.com')) return 'ytm'
  if (url.includes('accounts.google.com') || url.includes('youtube.com/signin')) return 'login'
  if (url.startsWith('file:') || url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) return 'ui'
  return `page#${wc.id}${url ? ` ${url.split('?')[0]}` : ''}`
}

const mb = (kb: number) => Math.round(kb / 1024)

// Memory per process as Activity Monitor counts it (the "footprint"), in KB. Electron's own figure,
// the working set, only counts what is in RAM right now: macOS compresses memory a page hasn't
// touched lately, so a 650 MB leak in the YouTube Music page once showed up as 83 MB here.
// Falls back to the working set if the system tool can't be run.
const FOOTPRINT_UNITS: Record<string, number> = { B: 1 / 1024, KB: 1, MB: 1024, GB: 1024 * 1024 }
function footprints(pids: number[]): Promise<Map<number, number>> {
  return new Promise((done) => {
    execFile('/usr/bin/footprint', pids.flatMap((p) => ['-p', String(p)]), { timeout: 10_000 }, (_e, out) => {
      const kb = new Map<number, number>()
      for (const m of String(out ?? '').matchAll(/\[(\d+)\]: .*?Footprint: ([\d.]+) (B|KB|MB|GB)/g)) {
        kb.set(Number(m[1]), Number(m[2]) * FOOTPRINT_UNITS[m[3]])
      }
      done(kb)
    })
  })
}

// How much JavaScript a page is holding on to, in MB: the number that grows when a page leaks.
// A page that doesn't answer within a couple of seconds is left out rather than holding up the line.
function jsHeap(wc: WebContents): Promise<number | undefined> {
  const asked = wc.executeJavaScript('performance.memory?.usedJSHeapSize').then(
    (b) => (typeof b === 'number' ? Math.round(b / 1024 / 1024) : undefined),
    () => undefined
  )
  return Promise.race([asked, new Promise<undefined>((r) => setTimeout(r, 2000))])
}

export async function health(): Promise<string> {
  const metrics = app.getAppMetrics()
  const fp = await footprints(metrics.map((m) => m.pid))
  const byType: Record<string, number> = {}
  for (const m of metrics) byType[m.type] = (byType[m.type] ?? 0) + (fp.get(m.pid) ?? m.memory.workingSetSize)
  const total = Object.values(byType).reduce((a, b) => a + b, 0)
  const parts = Object.entries(byType).map(([t, kb]) => `${t}=${mb(kb)}`)
  const heap = Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
  const hours = (process.uptime() / 3600).toFixed(1)
  const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
  const heaps = await Promise.all(all.map(async (wc) => [pageName(wc), await jsHeap(wc)] as const))
  const js = heaps.filter(([, h]) => h !== undefined).map(([name, h]) => `${name}=${h}`)
  const pages = all.map(pageName).join(',')
  return (
    `[health] up ${hours}h, memory ${mb(total)} MB (${parts.join(' ')}; main heap ${heap}; js heap ${js.join(' ') || '?'}), ` +
    `online=${net.isOnline()}, pages=${pages}`
  )
}
const logHealth = () => health().then((h) => log('info', h), (e) => log('warn', '[health] failed:', e))

// Called once the app is ready (some of these need it).
export function startLogging(): void {
  log(
    'info',
    `[app] ytspot ${app.getVersion()} started (${app.isPackaged ? 'packaged' : 'dev'}${testProfile ? ', test profile' : ''}), ` +
      `Electron ${process.versions.electron}, macOS ${process.getSystemVersion()} ${process.arch}, pid ${process.pid}, ` +
      `crash dumps in ${app.getPath('crashDumps')}`
  )
  app.on('before-quit', () => log('info', `[app] quitting after ${(process.uptime() / 3600).toFixed(1)}h`))
  app.on('render-process-gone', (_e, wc, d) => log('error', `[crash] ${pageName(wc)} page process gone: ${d.reason} (exit ${d.exitCode})`))
  app.on('child-process-gone', (_e, d) => log('error', `[crash] ${d.type}${d.name ? ` (${d.name})` : ''} process gone: ${d.reason} (exit ${d.exitCode})`))
  app.on('web-contents-created', (_e, wc) => {
    wc.on('unresponsive', () => log('warn', `[hang] ${pageName(wc)} page stopped responding`))
    wc.on('responsive', () => log('info', `[hang] ${pageName(wc)} page responding again`))
    wc.on('preload-error', (_ev, path, e) => log('error', `[ui] preload ${path} failed:`, e))
    wc.on('did-fail-load', (_ev, code, desc, url, mainFrame) => {
      if (mainFrame && code !== -3) log('warn', `[load] ${pageName(wc)} failed to load ${url.split('?')[0]}: ${desc} (${code})`)
    })
    // The app's own page only: YouTube's pages print a steady stream of their own warnings.
    // (Uncaught errors come with their stack from the page itself; see renderer main.tsx.)
    wc.on('console-message', (ev) => {
      if ((ev.level === 'warning' || ev.level === 'error') && pageName(wc) === 'ui' && !ev.message.startsWith('Uncaught')) {
        log(ev.level === 'error' ? 'error' : 'warn', `[ui console] ${ev.message}${ev.sourceId ? ` (${ev.sourceId.split('/').pop()}:${ev.lineNumber})` : ''}`)
      }
    })
  })
  for (const ev of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'shutdown'] as const) {
    powerMonitor.on(ev as 'suspend', () => log('info', `[power] ${ev}`))
  }
  // A baseline shortly after launch, then hourly.
  setTimeout(logHealth, 5 * 60_000)
  setInterval(logHealth, 60 * 60_000)
}

// Help → Report a Problem: marks the moment in the log, and returns the last `hours` of it (from
// the older file too, if the log rotated meanwhile) with a header, ready to paste into a report.
const MAX_REPORT = 300_000
export async function problemReport(hours = 2): Promise<string> {
  log('warn', '[user] reported a problem here')
  flushRepeats()
  const since = Date.now() - hours * 3600_000
  const lines: string[] = []
  let keep = false
  for (const file of [join(logDir, 'main.1.log'), logFile]) {
    let body = ''
    try {
      body = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of body.split('\n')) {
      // "2026-11-18 15:24:20.004+0530 …"; a line without a time continues the one before.
      const m = line.match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d{3})([+-]\d\d)(\d\d) /)
      if (m) keep = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) >= since
      if (keep && line) lines.push(line)
    }
  }
  let body = lines.join('\n')
  if (body.length > MAX_REPORT) body = `… (older lines cut)\n${body.slice(-MAX_REPORT)}`
  const head = `ytspot ${app.getVersion()} on macOS ${process.getSystemVersion()} ${process.arch}, reported ${stamp()}\n${await health()}\nLast ${hours} hours of ${logFile}:`
  return `${head}\n\n${body}\n`
}
