// Songs saved for offline listening: the audio, its artwork and lyrics, kept in the profile folder
// and served to the app over ytspot-media:// (see `serve`). Downloads use their own signed-out
// YouTube session (youtubei.js), with a PO token from BotGuard for each song (see botguard.ts).
import { app } from 'electron'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Innertube, Platform } from 'youtubei.js'
import { poToken, resetBotguard } from './botguard'
import { lyrics } from './lyrics'
import type { Download, DownloadQuality, DownloadsState, Lyrics, Track } from '../shared/types'

export const MEDIA_SCHEME = 'ytspot-media'
// Looked up when first used: a test run moves the profile after this module has loaded.
let folder = ''
const dir = () => (folder ||= join(app.getPath('userData'), 'Offline'))
const indexFile = () => join(dir(), 'index.json')
// googlevideo serves at most this much per request (the same size yt-dlp asks for).
const CHUNK = 10 * 1024 * 1024
const PARALLEL = 2

// What's on disk for a song: its entry plus the file names (in `dir`).
interface Saved extends Download {
  file: string
  art?: string
  artType?: string
}

// Stream URLs carry a scrambled signature that only YouTube's player script can work out; let
// youtubei.js run that script (it's YouTube's own code, fetched from youtube.com).
Platform.shim.eval = async (data, env) => {
  const out = [env.n && `n: exportedVars.nFunction(${JSON.stringify(env.n)})`, env.sig && `sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`]
  return new Function(`${data.output}\nreturn { ${out.filter(Boolean).join(', ')} }`)()
}

let saved: Map<string, Saved> | null = null
const jobs = new Map<string, { track: Track; progress: number; done: Promise<void> }>()
const waiting: (() => void)[] = []
let running = 0
let notify: (s: DownloadsState) => void = () => undefined
let yt: Promise<Innertube> | null = null

async function load(): Promise<Map<string, Saved>> {
  if (saved) return saved
  try {
    saved = new Map((JSON.parse(await readFile(indexFile(), 'utf8')) as Saved[]).map((s) => [s.videoId, s]))
  } catch {
    saved = new Map()
  }
  return saved
}

// Written to a temporary file first, so a crash mid-write never leaves a broken index. A failed
// write fails only its own caller; the next one still goes ahead.
let writing = Promise.resolve()
function persist(): Promise<void> {
  const list = [...saved!.values()]
  return (writing = writing.catch(() => undefined).then(async () => {
    await mkdir(dir(), { recursive: true })
    await writeFile(`${indexFile()}.tmp`, JSON.stringify(list))
    await rename(`${indexFile()}.tmp`, indexFile())
  }))
}

const publicEntry = ({ file: _f, art, artType: _t, ...d }: Saved): Download => ({
  ...d,
  thumb: art ? `${MEDIA_SCHEME}://art/${d.videoId}` : d.thumb
})

export async function downloadsState(): Promise<DownloadsState> {
  const list = [...(await load()).values()].sort((a, b) => b.added - a.added)
  return {
    songs: list.map(publicEntry),
    queue: [...jobs.values()].map((j) => ({ videoId: j.track.videoId, title: j.track.title, progress: j.progress }))
  }
}

// Progress moves many times a second; the UI hears about it a few times a second at most. (Progress
// waits for the push already due rather than putting it off, or a steady stream never sends one.)
let pushTimer: ReturnType<typeof setTimeout> | undefined
function changed(now = false): void {
  if (pushTimer && !now) return
  clearTimeout(pushTimer)
  pushTimer = setTimeout(() => ((pushTimer = undefined), downloadsState().then(notify)), now ? 0 : 250)
}

export function initDownloads(onChange: (s: DownloadsState) => void): void {
  notify = onChange
}

export async function downloaded(videoId: string): Promise<Download | undefined> {
  const s = (await load()).get(videoId)
  return s && publicEntry(s)
}

export async function savedLyrics(videoId: string): Promise<Lyrics | null | undefined> {
  if (!(await load()).has(videoId)) return undefined
  try {
    return JSON.parse(await readFile(join(dir(), `${videoId}.lyrics.json`), 'utf8'))
  } catch {
    return undefined
  }
}

const client = () =>
  (yt ??= Innertube.create({ retrieve_player: true, generate_session_locally: true }).catch((e) => ((yt = null), Promise.reject(e))))

// "3:45" from seconds.
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

// Low and Normal take the Opus stream nearest their bitrate; High takes YouTube's best.
const TARGET_KBPS = { low: 50, normal: 70 }

async function fetchAudio(videoId: string, quality: DownloadQuality, onProgress: (p: number) => void) {
  const session = await client()
  const pot = await poToken(videoId)
  const info = await session.getBasicInfo(videoId, { client: 'YTMUSIC', po_token: pot })
  const opus = (info.streaming_data?.adaptive_formats ?? []).filter((f) => f.has_audio && !f.has_video && !f.is_drc && f.mime_type.startsWith('audio/webm'))
  const kbps = (f: (typeof opus)[number]) => (f.average_bitrate ?? f.bitrate) / 1000
  const target = quality === 'high' ? 0 : TARGET_KBPS[quality]
  const format = target && opus.length
    ? opus.reduce((a, b) => (Math.abs(kbps(b) - target) < Math.abs(kbps(a) - target) ? b : a))
    : info.chooseFormat({ type: 'audio', quality: 'best', format: 'any' })
  const url = new URL(await format.decipher(session.session.player))
  if (!url.searchParams.has('pot')) url.searchParams.set('pot', pot)
  const size = format.content_length
  if (!size) throw new Error('No audio for this song')
  const file = `${videoId}.${format.mime_type.startsWith('audio/webm') ? 'webm' : 'm4a'}`
  const part = join(dir(), `${file}.part`)
  await mkdir(dir(), { recursive: true })
  const out = await open(part, 'w')
  try {
    for (let at = 0; at < size; ) {
      const res = await fetch(url, { headers: { Range: `bytes=${at}-${Math.min(size, at + CHUNK) - 1}` }, signal: AbortSignal.timeout(60000) })
      if (!res.ok || !res.body) throw Object.assign(new Error(`YouTube refused the download (${res.status})`), { status: res.status })
      const from = at
      for await (const chunk of res.body) {
        await out.write(chunk)
        at += chunk.length
        onProgress(at / size)
      }
      // An empty answer would otherwise ask for the same bytes forever.
      if (at === from) throw new Error('YouTube sent no audio')
    }
  } catch (e) {
    await out.close()
    await rm(part, { force: true })
    throw e
  }
  await out.close()
  await rename(part, join(dir(), file))
  return { file, bytes: size, seconds: (format.approx_duration_ms ?? 0) / 1000 || (info.basic_info.duration ?? 0), info: info.basic_info }
}

// Square album art at Now Playing size when YouTube Music has it, else the video's thumbnail.
async function fetchArt(videoId: string, thumb: string): Promise<{ art: string; artType: string } | null> {
  const url = thumb ? thumb.replace(/=w\d+-h\d+/, '=w544-h544') : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) return null
    const art = `${videoId}.art`
    await writeFile(join(dir(), art), Buffer.from(await res.arrayBuffer()))
    return { art, artType: res.headers.get('content-type') ?? 'image/jpeg' }
  } catch {
    return null
  }
}

async function downloadOne(track: Track, quality: DownloadQuality, added: number, onProgress: (p: number) => void): Promise<void> {
  let audio: Awaited<ReturnType<typeof fetchAudio>>
  try {
    audio = await fetchAudio(track.videoId, quality, onProgress)
  } catch (e) {
    // A minter YouTube stopped accepting gets a 403; try once more with a fresh one.
    if ((e as { status?: number }).status !== 403) throw e
    resetBotguard()
    audio = await fetchAudio(track.videoId, quality, onProgress)
  }
  const { info } = audio
  const thumb = track.thumb || info.thumbnail?.[0]?.url || ''
  const art = await fetchArt(track.videoId, thumb)
  const entry: Saved = {
    ...track,
    title: track.title || info.title || '',
    artists: track.artists || (info.author ?? '').replace(/ - Topic$/, ''),
    artistId: track.artistId ?? info.channel_id,
    duration: track.duration || clock(audio.seconds),
    thumb,
    bytes: audio.bytes,
    added,
    file: audio.file,
    ...art
  }
  // Lyrics too, so they show offline; missing lyrics aren't worth failing the download over.
  const words = await lyrics({ videoId: track.videoId, title: entry.title, artist: entry.artists, album: entry.album ?? '', duration: audio.seconds }).catch(() => undefined)
  if (words !== undefined) await writeFile(join(dir(), `${track.videoId}.lyrics.json`), JSON.stringify(words))
  ;(await load()).set(track.videoId, entry)
  await persist()
}

// Downloads the songs not already saved, a couple at a time; resolves once they've all finished,
// with the titles of any that couldn't be downloaded.
export async function download(tracks: Track[], quality: DownloadQuality = 'high'): Promise<{ failed: string[] }> {
  const have = await load()
  const failed: string[] = []
  // Newest first, but an album or playlist keeps its own order: earlier songs count as added later.
  const at = Date.now()
  const waits = tracks.map((track, i) => {
    if (have.has(track.videoId)) return Promise.resolve()
    const known = jobs.get(track.videoId)
    if (known) return known.done
    const job = { track, progress: 0, done: Promise.resolve() }
    job.done = (async () => {
      // A song that has to wait is handed its slot by the one finishing, so none can slip in between.
      if (running >= PARALLEL) await new Promise<void>((go) => waiting.push(go))
      else running++
      try {
        await downloadOne(track, quality, at + tracks.length - i, (p) => ((job.progress = p), changed()))
      } catch (e) {
        console.error('[download]', track.videoId, (e as Error).message)
        failed.push(track.title || track.videoId)
      } finally {
        const next = waiting.shift()
        if (next) next()
        else running--
        jobs.delete(track.videoId)
        changed(true)
      }
    })()
    jobs.set(track.videoId, job)
    return job.done
  })
  changed(true)
  await Promise.all(waits)
  return { failed }
}

export async function removeDownloads(videoIds: string[]): Promise<void> {
  const have = await load()
  for (const id of videoIds) {
    const s = have.get(id)
    if (!s) continue
    have.delete(id)
    await Promise.all([s.file, s.art, `${id}.lyrics.json`].filter(Boolean).map((f) => rm(join(dir(), f!), { force: true })))
  }
  await persist()
  changed(true)
}

// ytspot-media://song/<id> (the audio, with byte ranges so it can seek) and ytspot-media://art/<id>;
// ytspot-media://player/ is the blank page the local player runs in (see local.ts).
export async function serve(req: Request): Promise<Response> {
  const { host, pathname } = new URL(req.url)
  if (host === 'player') return new Response('<!doctype html><title>ytspot</title>', { headers: { 'Content-Type': 'text/html' } })
  const s = (await load()).get(decodeURIComponent(pathname.slice(1)))
  const name = host === 'song' ? s?.file : host === 'art' ? s?.art : undefined
  if (!s || !name) return new Response(null, { status: 404 })
  const path = join(dir(), name)
  const type = host === 'art' ? (s.artType ?? 'image/jpeg') : name.endsWith('.webm') ? 'audio/webm' : 'audio/mp4'
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    return new Response(null, { status: 404 })
  }
  const range = req.headers.get('range')?.match(/bytes=(\d*)-(\d*)/)
  if (!range) {
    const body = Readable.toWeb(createReadStream(path)) as ReadableStream
    return new Response(body, { headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } })
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
  const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1
  if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
  return new Response(body, {
    status: 206,
    headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' }
  })
}
