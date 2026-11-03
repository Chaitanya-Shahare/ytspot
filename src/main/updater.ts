import { app, dialog, net, shell, type BaseWindow, type MessageBoxOptions, type WebContents } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { access, constants, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { UpdateState, UpdateStatus } from '../shared/types'

// ytspot isn't signed with a Developer ID, which Electron's own autoUpdater (Squirrel.Mac) needs.
// So it updates itself the way a user would: download the release zip from GitHub, unpack it, and
// swap the app bundle for the new one after ytspot quits.
const REPO = 'Chaitanya-Shahare/ytspot'
const ASSET = 'ytspot-mac-arm64.zip'
const DAY = 24 * 60 * 60 * 1000
const run = promisify(execFile)

interface Release {
  version: string
  notes: string
  page: string
  zip?: string
  size?: number
  sha256?: string
}

let deps: { window: () => BaseWindow | null; page: () => WebContents | null }
let state: UpdateState = { current: app.getVersion(), status: 'idle' }
let release: Release | null = null
let staged: string | null = null // the new ytspot.app, unpacked and checked
let lastCheck = 0
let inFlight: Promise<void> | null = null
let swapping = false

export const updateState = () => state

function set(s: UpdateStatus): void {
  state = { current: app.getVersion(), ...s }
  deps.page()?.send('update', state)
}

const newer = (a: string, b: string) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  return false
}

// The running bundle (/Applications/ytspot.app), from its …/Contents/MacOS/ytspot.
const bundle = () => resolve(app.getPath('exe'), '../../..')

// Only a packaged app in a folder the user can write to can replace itself. A dev run, or one
// macOS launched from a read-only copy (App Translocation, for a quarantined download), gets the
// release page instead.
async function installable(): Promise<boolean> {
  if (!app.isPackaged || !bundle().endsWith('.app') || !release?.zip) return false
  try {
    await access(dirname(bundle()), constants.W_OK)
    await access(bundle(), constants.W_OK)
    return true
  } catch {
    return false
  }
}

// GitHub's release notes are Markdown; a dialog shows plain text, without the closing "how to
// upgrade" sections that don't apply in here.
const plain = (md: string) => {
  const text = md
    .replace(/^\*\*(Upgrade|Install|Or manually)[\s\S]*/im, '')
    .replace(/^```.*$/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*[-*] /gm, '• ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.length > 1200 ? `${text.slice(0, 1200).trimEnd()}…` : text
}

async function check(): Promise<void> {
  lastCheck = Date.now()
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) throw new Error(`GitHub answered ${res.status}.`)
    const r = await res.json()
    const asset = r.assets?.find((a: { name: string }) => a.name === ASSET)
    release = {
      version: String(r.tag_name).replace(/^v/, ''),
      notes: r.body ?? '',
      page: r.html_url,
      zip: asset?.browser_download_url,
      size: asset?.size,
      sha256: asset?.digest?.replace(/^sha256:/, '')
    }
    set(newer(release.version, app.getVersion()) ? { status: 'available', version: release.version } : { status: 'latest' })
  } catch (e) {
    set({ status: 'error', message: `Couldn’t reach GitHub. Check your connection and try again. (${(e as Error).message})` })
  }
}

// `manual` (the menu, Settings) shows the outcome in a dialog; the daily check only updates the UI.
export async function checkForUpdates(manual = false): Promise<void> {
  if (state.status !== 'downloading' && state.status !== 'ready') {
    if (manual) set({ status: 'checking' })
    await (inFlight ??= check().finally(() => (inFlight = null)))
  }
  if (manual) await promptUpdate()
  else if (state.status === 'available') deps.page()?.send('update:found', state.version)
}

async function download(r: Release): Promise<void> {
  const dir = join(app.getPath('temp'), 'ytspot-update')
  const zip = join(dir, ASSET)
  set({ status: 'downloading', version: r.version, percent: 0 })
  try {
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const res = await net.fetch(r.zip!)
    if (!res.ok || !res.body) throw new Error(`GitHub answered ${res.status}.`)
    const total = Number(res.headers.get('content-length')) || r.size || 0
    const hash = createHash('sha256')
    const out = createWriteStream(zip)
    const reader = res.body.getReader()
    let got = 0
    let shown = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      if (!out.write(value)) await once(out, 'drain')
      got += value.length
      const percent = total ? Math.min(99, Math.floor((got / total) * 100)) : 0
      if (percent !== shown) set({ status: 'downloading', version: r.version, percent: (shown = percent) })
    }
    out.end()
    await once(out, 'finish')
    if (r.sha256 && hash.digest('hex') !== r.sha256) throw new Error('The download was damaged.')
    // ditto keeps the bundle's symlinks and signature intact, as Finder's unzip does.
    await run('ditto', ['-x', '-k', zip, dir])
    await rm(zip)
    const name = (await readdir(dir)).find((f) => f.endsWith('.app'))
    if (!name) throw new Error('The download has no app in it.')
    const fresh = join(dir, name)
    const { stdout } = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(fresh, 'Contents/Info.plist')])
    if (stdout.trim() !== r.version) throw new Error(`The download is version ${stdout.trim()}, not ${r.version}.`)
    await run('codesign', ['--verify', '--deep', fresh])
    // What Homebrew does on install: without it macOS would block the new copy on first launch.
    await run('xattr', ['-dr', 'com.apple.quarantine', fresh]).catch(() => {})
    staged = fresh
    set({ status: 'ready', version: r.version })
    await promptUpdate()
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    set({ status: 'error', message: `Couldn’t download ytspot ${r.version}. ${(e as Error).message}` })
    await promptUpdate()
  }
}

// Swap the bundle once this process has exited, then (for Restart) open the new one. A detached
// shell outlives ytspot. If the new copy can't be moved in, the old one goes back.
function swap(relaunch: boolean): void {
  if (!staged || swapping) return
  swapping = true
  // A test run (YTSPOT_PROFILE) starts the binary itself, so it keeps that profile: `open` would
  // launch it without the environment, on the installed app's profile.
  const launch = process.env.YTSPOT_PROFILE ? `"$2/Contents/MacOS/${basename(app.getPath('exe'))}" >/dev/null 2>&1 &` : 'open "$2"'
  const script = `
    while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
    rm -rf "$2.old"
    mv "$2" "$2.old" && { mv "$3" "$2" || mv "$2.old" "$2"; }
    rm -rf "$2.old" "$(dirname "$3")"
    [ "$4" = 1 ] && ${launch}`
  spawn('/bin/sh', ['-c', script, 'sh', String(process.pid), bundle(), staged, relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' }).unref()
}

// The dialog for where the update is: offer it, offer the restart, or report the outcome.
export async function promptUpdate(): Promise<void> {
  const win = deps.window()
  const box = (o: MessageBoxOptions) => (win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o))
  const s = state
  if (s.status === 'available' && release) {
    const r = release
    const can = await installable()
    const { response } = await box({
      message: `ytspot ${r.version} is available`,
      detail: `You have ${s.current}.${r.notes ? `\n\n${plain(r.notes)}` : ''}`,
      buttons: [can ? 'Install Update' : 'Download', 'Later', 'Release Notes'],
      defaultId: 0,
      cancelId: 1
    })
    // Downloading carries on in the background (the top bar shows how far along); this resolves now.
    if (response === 0 && state.status === 'available') can ? void download(r) : shell.openExternal(r.page)
    if (response === 2) shell.openExternal(r.page)
  } else if (s.status === 'ready') {
    const { response } = await box({
      message: `ytspot ${s.version} is ready to install`,
      detail: 'Restart ytspot to finish updating. If you choose Later, it updates the next time you quit.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1
    })
    if (response === 0 && state.status === 'ready') {
      swap(true)
      app.quit()
    }
  } else if (s.status === 'downloading') {
    await box({ message: `Downloading ytspot ${s.version}…`, detail: `${s.percent}% done. ytspot asks you to restart once it’s ready.` })
  } else if (s.status === 'latest') {
    await box({ message: 'You’re up to date', detail: `ytspot ${s.current} is the latest version.` })
  } else if (s.status === 'error') {
    await box({ type: 'warning', message: 'Couldn’t update ytspot', detail: s.message })
  }
}

export function initUpdater(d: typeof deps): void {
  deps = d
  // An update that was downloaded but not restarted for goes in when ytspot quits.
  app.on('will-quit', () => swap(false))
  // Once a day, like most Mac apps: shortly after launch, then whenever a day has passed. The
  // hourly tick also catches up after the Mac slept through a check.
  setTimeout(checkForUpdates, 10_000)
  setInterval(() => Date.now() - lastCheck >= DAY && checkForUpdates(), 60 * 60 * 1000)
}
