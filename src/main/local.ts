// Plays downloaded songs from disk, for listening offline: a hidden page with an <audio> element,
// driven the same way as the YouTube Music page (player.ts): main sends commands and reads state.
// The page keeps its own queue and moves through it by itself, and shows in Control Center
// (Media Session), so playback carries on with the app window closed.
import { BrowserWindow, type WebContents } from 'electron'
import { MEDIA_SCHEME } from './downloads'
import type { Download, PlayerCommand, PlayerState, QueueItem, ShuffleMode } from '../shared/types'

let win: BrowserWindow | null = null
let page: Promise<WebContents> | null = null

const PAGE_JS = `(() => {
  if (window.__local) return
  const a = new Audio()
  a.preload = 'auto'
  // \`tracks\` in the order they were given; \`order\` the play order (indexes into it); \`pos\` the
  // playing one's place in \`order\`. \`queued\`: songs the user added with "Play next" ('next') or
  // "Add to queue" ('end'), which shuffle leaves where they were put, as in player.ts.
  const s = { tracks: [], order: [], pos: -1, repeat: 'NONE', shuffle: 'off', liked: new Set(), queued: new Map(), rev: 0 }
  const cur = () => s.tracks[s.order[s.pos]]
  const bump = () => s.rev++
  const mix = (x) => { for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]] } return x }
  const start = (play = true) => {
    const t = cur()
    bump()
    if (!t) return a.pause()
    a.src = '${MEDIA_SCHEME}://song/' + encodeURIComponent(t.videoId)
    if (play) a.play().catch(() => {})
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album || '', artwork: t.thumb ? [{ src: t.thumb, sizes: '544x544' }] : [] })
  }
  const next = (ended) => {
    if (ended && s.repeat === 'ONE') return (a.currentTime = 0), a.play()
    if (s.pos < s.order.length - 1) s.pos++
    else if (s.repeat === 'ALL' || !ended) s.pos = 0
    else return a.pause()
    start()
  }
  const prev = () => {
    if (a.currentTime > 3 || s.pos <= 0) return void (a.currentTime = 0)
    s.pos--
    start()
  }
  // Shuffle, as on Spotify (and as player.ts does for YouTube Music): the playing song first, then
  // songs the user put next, then everything else mixed up, then songs added to the end.
  const shuffleAll = (playing) => {
    const queued = s.order.slice(s.pos + 1).filter((i) => s.queued.has(i))
    const next = queued.filter((i) => s.queued.get(i) === 'next'), last = queued.filter((i) => s.queued.get(i) === 'end')
    return [playing, ...next, ...mix(s.order.filter((i) => i !== playing && !queued.includes(i))), ...last]
  }
  // Off: back to the order the songs were given in, carrying on from the playing song. Queued songs
  // stay right after the song they followed, except ones added to the end that are still to come:
  // those go back to the end. Songs taken out of the queue stay out.
  const unshuffle = () => {
    let at = -1
    const ranked = s.order.map((i, k) => {
      const own = !s.queued.has(i)
      if (own) at = i
      return { i, at: !own && k > s.pos && s.queued.get(i) === 'end' ? Infinity : at, own, k }
    })
    ranked.sort((x, y) => x.at - y.at || y.own - x.own || x.k - y.k)
    return ranked.map((r) => r.i)
  }
  const setShuffle = (mode) => {
    const on = mode !== 'off', playing = s.order[s.pos]
    if (playing !== undefined && on !== (s.shuffle !== 'off')) {
      s.order = on ? shuffleAll(playing) : unshuffle()
      s.pos = s.order.indexOf(playing)
      bump()
    }
    s.shuffle = on ? 'on' : 'off'
  }
  a.addEventListener('ended', () => next(true))
  // A song that won't play (its file removed from Downloads since the queue was made) is skipped,
  // rather than left showing as playing at 0:00; if none of them will, playback stops.
  let failed = 0
  a.addEventListener('playing', () => (failed = 0))
  a.addEventListener('error', () => {
    if (!a.getAttribute('src')) return
    if (++failed >= s.order.length || s.pos >= s.order.length - 1) return (failed = 0), a.pause()
    s.pos++
    start()
  })
  const ms = navigator.mediaSession
  ms.setActionHandler('play', () => a.play())
  ms.setActionHandler('pause', () => a.pause())
  ms.setActionHandler('nexttrack', () => next(false))
  ms.setActionHandler('previoustrack', prev)
  ms.setActionHandler('seekto', (d) => (a.currentTime = d.seekTime))
  window.__local = {
    load(tracks, index, volume) {
      s.tracks = tracks
      s.order = tracks.map((_, i) => i)
      s.pos = index
      s.queued = new Map()
      if (s.shuffle !== 'off') ((s.order = shuffleAll(s.order[s.pos])), (s.pos = 0))
      if (volume !== undefined) a.volume = volume / 100
      start()
    },
    toggle: () => (a.paused ? a.play().catch(() => {}) : a.pause()),
    pause: () => a.pause(),
    next: () => next(false),
    prev,
    seek: (t) => (a.currentTime = t),
    volume: (v) => ((a.muted = false), (a.volume = Math.max(0, Math.min(1, v / 100)))),
    mute: () => (a.muted = !a.muted),
    repeat: () => (s.repeat = { NONE: 'ALL', ALL: 'ONE', ONE: 'NONE' }[s.repeat]),
    setShuffle,
    jump: (i) => ((s.pos = i), start()),
    remove(i) {
      if (i === s.pos) return
      s.order.splice(i, 1)
      if (i < s.pos) s.pos--
      bump()
    },
    move(from, to) {
      const playing = s.order[s.pos]
      const [x] = s.order.splice(from, 1)
      s.order.splice(to, 0, x)
      s.pos = s.order.indexOf(playing)
      bump()
    },
    add(tracks, soon) {
      const at = soon ? s.pos + 1 : s.order.length
      const ids = tracks.map((_, i) => s.tracks.length + i)
      s.order.splice(at, 0, ...ids)
      for (const i of ids) s.queued.set(i, soon ? 'next' : 'end')
      s.tracks.push(...tracks)
      bump()
    },
    like: (id, on) => (on ? s.liked.add(id) : s.liked.delete(id)),
    state(rev) {
      const t = cur()
      if (!t) return null
      return {
        videoId: t.videoId, title: t.title, artist: t.artist, artistId: t.artistId, album: t.album || '', albumId: t.albumId,
        thumb: t.thumb, time: a.currentTime || 0, duration: a.duration || 0, playing: !a.paused,
        volume: Math.round(a.volume * 100), muted: a.muted, repeat: s.repeat, shuffle: s.shuffle, liked: s.liked.has(t.videoId),
        isVideo: false, videoMode: false, local: true, rev: s.rev,
        ...(rev === s.rev ? {} : { queue: s.order.map((i, k) => ({ ...s.tracks[i], selected: k === s.pos })) })
      }
    }
  }
})()`

function open(): Promise<WebContents> {
  return (page ??= (async () => {
    win = new BrowserWindow({ show: false, webPreferences: { spellcheck: false } })
    const wc = win.webContents
    if (process.env.YTSPOT_MUTE) wc.setAudioMuted(true)
    win.on('closed', () => ((win = null), (page = null)))
    await win.loadURL(`${MEDIA_SCHEME}://player/`)
    await wc.executeJavaScript(PAGE_JS)
    return wc
  })().catch((e) => ((page = null), Promise.reject(e))))
}

const run = async <T>(js: string): Promise<T | null> => {
  if (!page) return null
  const wc = await page
  return wc.executeJavaScript(`window.__local.${js}`).catch((e: Error) => (console.error('[local]', e.message), null))
}

// Whether the downloaded songs are what's playing (rather than YouTube Music).
let active = false
export const localActive = () => active

// Queue rows, plus the album for Control Center.
const item = (d: Download): QueueItem & { album?: string } => ({
  videoId: d.videoId,
  title: d.title,
  artist: d.artists,
  artistId: d.artistId,
  albumId: d.albumId,
  album: d.album,
  duration: d.duration,
  thumb: d.thumb,
  art: d.thumb,
  square: true,
  selected: false
})

export async function playLocal(songs: Download[], index: number, volume?: number): Promise<void> {
  active = true
  await open()
  await run(`load(${JSON.stringify(songs.map(item))}, ${index}, ${volume ?? 'undefined'})`)
}

// Back to YouTube Music: the downloaded song stops.
export function leaveLocal(): void {
  active = false
  run('pause()')
}

export async function localCommand(c: PlayerCommand, songs: (ids: string[]) => Promise<Download[]>): Promise<void> {
  switch (c.type) {
    case 'toggle':
    case 'next':
    case 'prev':
    case 'mute':
    case 'repeat':
      return void (await run(`${c.type}()`))
    // Disliking a song skips it, as in YouTube Music.
    case 'dislike':
      return void (await run('next()'))
    case 'seek':
      return void (await run(`seek(${Number(c.seconds)})`))
    case 'volume':
      return void (await run(`volume(${Number(c.value)})`))
    // Smart Shuffle's recommendations come from YouTube Music; offline, shuffle is all there is.
    case 'shuffle':
    case 'shuffleMode': {
      const now = (await localState())?.shuffle ?? 'off'
      const mode: ShuffleMode = c.type === 'shuffleMode' ? c.mode : now === 'off' ? 'on' : 'off'
      return void (await run(`setShuffle(${JSON.stringify(mode)})`))
    }
    case 'jump':
      return void (await run(`jump(${Number(c.index)})`))
    case 'queueRemove':
      return void (await run(`remove(${Number(c.index)})`))
    case 'queueMove':
      return void (await run(`move(${Number(c.from)}, ${Number(c.to)})`))
    // Only downloaded songs can join this queue.
    case 'queueAdd':
      return void (await run(`add(${JSON.stringify((await songs(c.videoIds)).map(item))}, ${c.next})`))
  }
}

export function setLocalLiked(videoId: string, on: boolean): void {
  run(`like(${JSON.stringify(videoId)}, ${on})`)
}

// The queue is only re-sent when it changed (see player.ts's getState), so callers can compare it by identity.
let lastQueue: { rev: number; queue: QueueItem[] } = { rev: -1, queue: [] }
export async function localState(): Promise<PlayerState | null> {
  const s = await run<Omit<PlayerState, 'queue' | 'autoplay'> & { rev: number; queue?: QueueItem[] }>(`state(${lastQueue.rev})`)
  if (!s) return null
  const { rev, queue, ...rest } = s
  if (queue) lastQueue = { rev, queue }
  return { ...rest, queue: lastQueue.queue, autoplay: [] }
}
