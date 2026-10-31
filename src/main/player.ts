// Drives a hidden music.youtube.com window: YouTube's own player does the streaming
// (Premium, its queue/radio), we only send commands and read state. Ads are blocked (adblock.ts).
import { BaseWindow, BrowserWindow, session, WebContentsView, type WebContents } from 'electron'
import { AD_URLS, blockAds, isAdUrl } from './adblock'
import type { PlayerCommand, PlayerState, ShuffleMode, VideoRect, YtmSetting } from '../shared/types'

const YTM = 'https://music.youtube.com'
// Same sign-in entry point Pear uses: Google login, then YouTube's sign-in handler, then YTM.
const LOGIN = `https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&continue=${encodeURIComponent(
  `https://www.youtube.com/signin?action_handle_signin=true&next=${encodeURIComponent(`${YTM}/`)}`
)}`
export const ytmSession = () => session.fromPartition('persist:ytm')

// The YTM page lives in its own view, parked in a hidden window (a BaseWindow has no page of its
// own). When a video should be watched, the view is moved into the main window over the Now
// Playing artwork (or, in full screen, beneath the whole page), then parked again.
let host: BaseWindow | null = null
let view: WebContentsView | null = null
let page: WebContents | null = null
let login: BrowserWindow | null = null

const HIDDEN_BOUNDS = { x: 0, y: 0, width: 1000, height: 700 }

// While shown in the app, only the <video> is visible, filling the view. Nothing in YTM's page may
// move it: its player plays a "grow-into-place" animation whenever it's resized, which for half a
// second shifts the video off to one side.
const VIDEO_CSS = `
  html.ytspot-video, html.ytspot-video body { background: #000 !important; overflow: hidden !important; }
  html.ytspot-video * { visibility: hidden !important; transform: none !important; contain: none !important;
    will-change: auto !important; filter: none !important; transition: none !important; animation: none !important; }
  html.ytspot-video video { visibility: visible !important; position: fixed !important; inset: 0 !important;
    width: 100vw !important; height: 100vh !important; object-fit: cover !important; z-index: 2147483647 !important; }
  /* Full screen shows the whole picture, letterboxed, as YouTube's own full screen does. */
  html.ytspot-video.ytspot-full video { object-fit: contain !important; }
`

export function createPlayerWindow(): BaseWindow {
  host = new BaseWindow({ show: false, ...HIDDEN_BOUNDS })
  // Background throttling stays on: Chromium never throttles a page while it plays audio, and when
  // paused it lets this hidden page sleep instead of waking the CPU for YTM's timers.
  view = new WebContentsView({ webPreferences: { session: ytmSession(), spellcheck: false } })
  host.contentView.addChildView(view)
  view.setBounds(HIDDEN_BOUNDS)
  view.setVisible(false)
  const p = (page = view.webContents)
  const id = p.id
  // Nobody sees this page, so don't download or decode its artwork (our UI loads its own), and
  // don't run YTM's offline service worker, which costs a whole extra process. Ad requests never go
  // out. (A session takes one such listener, so this is the only one.)
  const urls = ['*://*.ytimg.com/*', '*://*.ggpht.com/*', '*://*.googleusercontent.com/*', '*://*.gstatic.com/*', '*://music.youtube.com/sw.js*', ...AD_URLS]
  ytmSession().webRequest.onBeforeRequest({ urls }, (d, cb) =>
    cb({ cancel: isAdUrl(d.url) || d.url.includes('/sw.js') || (d.webContentsId === id && d.resourceType === 'image') })
  )
  ytmSession().clearStorageData({ storages: ['serviceworkers'] })
  // YTM's "Leave site?" beforeunload handler would otherwise silently block quitting and reloads.
  p.on('will-prevent-unload', (e) => e.preventDefault())
  if (process.env.YTSPOT_MUTE) p.setAudioMuted(true)
  p.on('dom-ready', () => {
    p.insertCSS(VIDEO_CSS)
    run(SETUP_JS(videoMode, shuffleMode))
  })
  blockAds(p).then(() => p.loadURL(YTM))
  return host
}

// Where the video is shown: over the Now Playing artwork (on top of the page), or filling the
// window beneath the page in full screen (the page is see-through there and draws the controls over
// it). Null while parked out of sight.
let shown: { main: BaseWindow; full: boolean } | null = null
// The latest place asked for, and the move getting there (one at a time).
let target: { main: BaseWindow; ui: WebContents; rect: VideoRect } | null = null
let moving: Promise<void> | null = null
let parking: ReturnType<typeof setTimeout> | undefined

const boundsOf = ({ main, ui, rect }: NonNullable<typeof target>): Electron.Rectangle => {
  if (rect.full) return { ...main.getContentBounds(), x: 0, y: 0 }
  // The renderer measures in CSS pixels; the view is placed in window points.
  const z = ui.getZoomFactor()
  return { x: Math.round(rect.x * z), y: Math.round(rect.y * z), width: Math.round(rect.width * z), height: Math.round(rect.height * z) }
}

// Resolves once the video has been drawn at the page's new size (or gives up after a moment). The
// page reports its new size a little before the video layer catches up, so a playing video waits
// for two of its own frames to be presented; a paused one, which presents none, for two page frames.
const SIZED_JS = (w: number, h: number) => `new Promise((done) => {
  const stop = setTimeout(done, 1000), end = () => (clearTimeout(stop), done())
  const v = document.querySelector('video')
  const frames = (n) => v && !v.paused && v.requestVideoFrameCallback
    ? v.requestVideoFrameCallback(() => (n > 1 ? frames(n - 1) : end()))
    : requestAnimationFrame(() => requestAnimationFrame(end))
  const check = () => (innerWidth === ${w} && innerHeight === ${h} ? requestAnimationFrame(() => frames(2)) : requestAnimationFrame(check))
  check()
})`

// Show the playing video at `rect` inside `main`, whose page is `ui`; resolves once it's showing
// there. Like Spotify's player, the video is never hidden and reloaded on the way between places:
// a slot going away is usually another appearing (Now Playing → full screen), so null parks it only
// if no new place follows. Moving between places, the video is first resized and restyled beneath
// the page, where it's covered (by the app, or the full-screen player's curtain), and only shown
// once it has drawn itself at its new size, so a squeezed or cropped frame never shows.
export function placeVideo(main: BaseWindow | null, ui: WebContents | null, rect: VideoRect | null): Promise<void> {
  clearTimeout(parking)
  if (!view || !host) return Promise.resolve()
  if (!main || !ui || !rect) {
    parking = setTimeout(parkVideo, 150)
    return Promise.resolve()
  }
  target = { main, ui, rect }
  if (moving) return moving
  if (shown?.main === main && shown.full === !!rect.full) return Promise.resolve(view.setBounds(boundsOf(target)))
  return (moving = move().finally(() => (moving = null)))
}

async function move(): Promise<void> {
  const v = view!
  while (target && !(shown?.main === target.main && shown.full === !!target.rect.full)) {
    const { main, ui, rect } = target
    const full = !!rect.full
    if (main.isDestroyed() || ui.isDestroyed()) return
    // Beneath the page first. (Re-adding a view that's already there doesn't move it to the bottom.)
    if (shown?.main === main) main.contentView.removeChildView(v)
    main.contentView.addChildView(v, 0)
    shown = null
    // Clicking the video would move keyboard focus into the YTM page, where our shortcuts (Space
    // included) no longer reach the app; hand it straight back.
    v.webContents.removeAllListeners('focus')
    v.webContents.on('focus', () => !ui.isDestroyed() && ui.focus())
    await run(`document.documentElement.classList.add('ytspot-video'); document.documentElement.classList.toggle('ytspot-full', ${full})`)
    if (target?.main !== main || !!target.rect.full !== full) continue
    const b = boundsOf(target)
    v.setBounds(b)
    v.setBorderRadius(full ? 0 : 8)
    v.setVisible(true)
    await run(SIZED_JS(b.width, b.height))
    if (target?.main !== main || !!target.rect.full !== full || main.isDestroyed()) continue
    if (!full) main.contentView.addChildView(v)
    shown = { main, full }
  }
  if (target && shown) view!.setBounds(boundsOf(target))
}

// Put the video back out of sight (at once: the window is closing or its page reloading).
export function parkVideo(): void {
  clearTimeout(parking)
  target = null
  if (moving) return void moving.then(parkVideo)
  if (!view || !host || view.webContents.isDestroyed()) return
  shown = null
  host.contentView.addChildView(view)
  view.setVisible(false)
  view.setBounds(HIDDEN_BOUNDS)
  view.setBorderRadius(0)
  run(`document.documentElement.classList.remove('ytspot-video', 'ytspot-full')`)
}

// The window resized: a full-screen video follows it directly, without waiting on the page to
// measure and report (which would trail behind during the full-screen animation).
export function fitVideo(main: BaseWindow): void {
  if (target?.main === main && target.rect.full && view) view.setBounds(boundsOf(target))
}

// Sign-in gets its own window so the player keeps running and closing it returns to the app.
export function showLogin(): void {
  if (login) return login.focus()
  login = new BrowserWindow({ width: 520, height: 720, title: 'Log in to YouTube Music', webPreferences: { session: ytmSession() } })
  login.on('closed', () => (login = null))
  // Some Google flows ("Try another way") drop the continue URL and land on the account page,
  // leaving only google.com cookies. Re-run the YouTube handoff once to get youtube.com cookies.
  let resumed = false
  login.webContents.on('did-navigate', (_, url) => {
    if (!resumed && new URL(url).hostname === 'myaccount.google.com') {
      resumed = true
      login?.loadURL(LOGIN)
    }
  })
  login.loadURL(LOGIN)
}

export function onLoggedIn(): void {
  login?.close()
  page?.loadURL(YTM)
}

export async function signOut(): Promise<void> {
  await ytmSession().clearStorageData({ storages: ['cookies'] })
  page?.loadURL(YTM)
}

// Queue rows in the DOM, minus the hidden "video version" twins under #counterpart-renderer.
const QUEUE_DOM = 'ytmusic-player-queue :not(#counterpart-renderer) > ytmusic-player-queue-item'

const run = <T>(js: string): Promise<T | null> =>
  page
    ? page.executeJavaScript(js, true).catch((e: Error) => (console.error('[ytm page]', e.message), null))
    : Promise.resolve(null)

// Shared helpers injected into the YTM page once per load, plus the audio-only policy:
// unless video mode is on, switch to YTM's audio-only stream when offered, otherwise drop the
// video to 144p so a hidden window isn't decoding HD video for music.
const SETUP_JS = (videoMode: boolean, shuffleMode: ShuffleMode) => `(() => {
  if (window.__ytspot) return
  // A pause asked for while a track was changing: if YTM then starts the new track by itself,
  // pause it again (media events don't bubble, so listen while capturing).
  document.addEventListener('play', () => {
    if ((window.__ytspotHold || 0) > Date.now()) document.getElementById('movie_player')?.pauseVideo()
  }, true)
  // When the video was last seen playing, so a toggle can tell a song switching over (stopped for
  // a moment, YTM about to start the next) from a real pause.
  document.addEventListener('timeupdate', (e) => { if (!e.target.paused) window.__ytspotPlayedAt = Date.now() }, true)
  const t = (x) => typeof x === 'string' ? x : x?.runs ? x.runs.map((r) => r.text).join('') : (x?.simpleText || '')
  const store = () => document.querySelector('#queue')?.queue?.store?.store?.getState?.().queue
  const thumbs = (r) => r?.thumbnail?.thumbnails || []
  const primary = (it) => it?.playlistPanelVideoRenderer || it?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer
  // A queue item's id: YTM numbers items as it adds them, unique within a queue.
  const key = (it) => primary(it)?.navigationEndpoint?.watchEndpoint?.index

  // ---- Shuffle, as in Spotify: off, on, or Smart Shuffle (on, plus a recommendation after every
  // 3 songs). Done on YTM's queue store, because YTM's own shuffle button jumps to another song
  // when it's turned on or off. \`order\` is the queue's own order (item ids), \`queued\` the songs
  // the user added, \`recs\` the ones Smart Shuffle added.
  const sh = { mode: ${JSON.stringify(shuffleMode)}, order: [], queued: new Set(), recs: new Set(), fresh: true, wantRecs: false, asked: false, busy: false }
  const queueEl = () => document.querySelector('#queue')
  const items = () => store()?.items || []
  const current = () => items()[queueEl()?.queue?.getCurrentItemIndex?.() ?? -1]
  const mix = (a) => {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
    return a
  }
  // Our own dispatches, which the dispatch hook below ignores.
  const quietly = (fn) => { sh.busy = true; try { fn() } finally { sh.busy = false } }
  // Replace the queue with \`list\` (the same items, reordered or trimmed) and keep \`cur\` current.
  // YTM doesn't restart a song for this; it only plays the next item when this one ends.
  const put = (list, cur) => quietly(() => {
    queueEl().dispatch({ type: 'RESET_ITEMS', payload: list })
    queueEl().dispatch({ type: 'SET_INDEX', payload: list.indexOf(cur) })
  })
  // The current song first, then songs the user queued after it, then everything else in random
  // order. (The songs before it go too, so "previous" restarts the song, as in YTM's own shuffle.)
  const shuffleAll = () => {
    const list = items(), cur = current()
    if (!cur) return
    const queued = list.slice(list.indexOf(cur) + 1).filter((it) => sh.queued.has(key(it)))
    put([cur, ...queued, ...mix(list.filter((it) => it !== cur && !queued.includes(it)))], cur)
  }
  // Back to the queue's own order, carrying on from the current song. Songs that aren't part of it
  // (ones the user queued) stay right after the song they followed.
  const unshuffle = () => {
    const pos = new Map(sh.order.map((k, i) => [k, i])), cur = current()
    let at = -1
    const ranked = items().map((it, i) => {
      const own = pos.has(key(it))
      if (own) at = pos.get(key(it))
      return { it, at, own, i }
    })
    ranked.sort((a, b) => a.at - b.at || b.own - a.own || a.i - b.i)
    if (cur) put(ranked.map((r) => r.it), cur)
  }
  // Songs YTM loads into a shuffled queue later (the rest of a long playlist) go in at random
  // places among the songs still to come, after any the user queued. A recommendation that turns
  // out to be one of them goes, so the song doesn't play twice.
  const spread = (added) => {
    const cur = current()
    if (!cur || added.includes(cur)) return shuffleAll()
    const ids = new Set(added.map((it) => primary(it)?.videoId))
    const dup = (it) => it !== cur && sh.recs.has(key(it)) && ids.has(primary(it)?.videoId)
    const out = items().filter((it) => !added.includes(it) && !dup(it))
    let from = out.indexOf(cur) + 1
    while (from < out.length && sh.queued.has(key(out[from]))) from++
    for (const it of added) out.splice(from + Math.floor(Math.random() * (out.length - from + 1)), 0, it)
    put(out, cur)
  }
  // Smart Shuffle's recommendations are YTM's autoplay songs for this queue (its radio), moved up
  // into the queue: one after every 3 songs to come. False when there are none yet.
  const addRecs = () => {
    const list = items(), cur = current(), auto = store()?.automixItems || []
    const have = new Set(list.map((it) => primary(it)?.videoId))
    // Songs and official videos only, not covers and remixes people uploaded.
    const ugc = (it) => primary(it)?.navigationEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType === 'MUSIC_VIDEO_TYPE_UGC'
    const pool = auto.filter((it) => !have.has(primary(it)?.videoId) && !ugc(it))
    if (!cur || !pool.length) return false
    const out = list.slice(0, list.indexOf(cur) + 1), used = []
    const add = () => { const it = pool.shift(); used.push(it); out.push(it) }
    list.slice(out.length).forEach((it, i) => { out.push(it); if (i % 3 === 2 && pool.length) add() })
    if (!used.length) add()
    used.forEach((it) => sh.recs.add(key(it)))
    put(out, cur)
    quietly(() => queueEl().dispatch({ type: 'REPLACE_AUTOMIX_ITEMS', payload: { automixItems: auto.filter((it) => !used.includes(it)) } }))
    return true
  }
  // YTM fetches its autoplay songs only when a long playlist is about to run out, so without them
  // ask for the playlist's radio (or the song's), as YTM's own radio would, once per queue. They
  // arrive as autoplay songs, which \`settle\` then mixes in.
  const fetchRecs = async () => {
    const we = primary(current())?.navigationEndpoint?.watchEndpoint, order = sh.order
    if (!we || sh.asked) return
    sh.asked = true
    const lists = [we.playlistId && !we.playlistId.startsWith('RD') && 'RDAMPL' + we.playlistId, 'RDAMVM' + we.videoId]
    for (const playlistId of lists.filter(Boolean)) {
      const res = await document.querySelector('ytmusic-app').networkManager.fetch('/next', { playlistId, videoId: we.videoId, isAudioOnly: true }).catch(() => null)
      const panel = res?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer
      // A radio starts with the song it's for and can include the queue's own songs.
      const have = new Set(items().map((it) => primary(it)?.videoId))
      const found = (panel?.contents || []).filter((it) => primary(it) && !have.has(primary(it).videoId))
      // Moved on to another queue meanwhile (a new queue gets a new \`order\`): these were for the old one.
      if (sh.order !== order) return
      if (!found.length) continue
      found.forEach((it) => (primary(it).selected = false))
      return queueEl().dispatch({ type: 'ADD_AUTOMIX_ITEMS', payload: { automixItems: found, nextQueueItemId: store().nextQueueItemId, shouldAssignIds: true } })
    }
  }
  // A new queue's autoplay songs come a moment after its songs, so give YTM a few seconds first.
  const mixInRecs = () => {
    sh.wantRecs = !addRecs()
    if (sh.wantRecs) setTimeout(() => sh.wantRecs && fetchRecs(), 3000)
  }
  // Takes them out again, except the one playing.
  const dropRecs = () => {
    const cur = current()
    if (cur && sh.recs.size) put(items().filter((it) => it === cur || !sh.recs.has(key(it))), cur)
    sh.recs.clear()
    sh.wantRecs = false
  }
  // Keeps YTM's queue in the chosen mode as it changes: a new queue (another playlist) gets
  // shuffled, songs loaded later get shuffled in, and Smart Shuffle adds its songs once YTM has them.
  const settle = () => {
    if (sh.mode === 'off' || !store()) return
    const cur = current()
    if (!cur) return
    if (sh.fresh) {
      sh.fresh = false
      sh.order = items().map(key)
      shuffleAll()
      sh.wantRecs = sh.mode === 'smart'
    } else {
      const known = new Set(sh.order)
      const added = items().filter((it) => !known.has(key(it)) && !sh.queued.has(key(it)) && !sh.recs.has(key(it)))
      if (added.length) (sh.order.push(...added.map(key)), spread(added))
    }
    if (sh.wantRecs) mixInRecs()
  }
  // Watch YTM's own queue changes: a CLEAR starts a new queue; songs added with "Play next" / "Add
  // to queue" (\`adding\`) are the user's; autoplay songs YTM moves in at the end stay in its order.
  const hook = () => {
    const st = queueEl()?.queue?.store?.store
    if (!st || st.__ytspot) return
    st.__ytspot = true
    const dispatch = st.dispatch.bind(st)
    st.dispatch = (a) => {
      const r = dispatch(a)
      if (sh.busy || !a) return r
      if (a.type === 'CLEAR') {
        sh.order = []
        sh.queued.clear()
        sh.recs.clear()
        sh.fresh = true
        sh.asked = false
      } else if (a.type === 'ADD_ITEMS' && sh.adding) a.payload.items.forEach((it) => sh.queued.add(key(it)))
      else if (a.type === 'SHIFT_AUTOPLAY_ITEMS') sh.order.push(...a.payload.map(key))
      if (['CLEAR', 'ADD_ITEMS', 'ADD_AUTOMIX_ITEMS', 'UPDATE_ITEMS', 'RESET_ITEMS', 'REFRESH_ITEMS'].includes(a.type)) {
        clearTimeout(sh.t)
        sh.t = setTimeout(settle, 0)
      }
      return r
    }
    settle()
  }
  const setShuffle = (mode) => {
    const was = sh.mode
    if (mode === was) return
    sh.mode = mode
    // Before the queue exists, \`settle\` applies the mode once it does.
    if (!store() || !current()) return
    if (was === 'smart') dropRecs()
    if (was === 'off') {
      sh.fresh = false
      sh.order = items().filter((it) => !sh.queued.has(key(it))).map(key)
      shuffleAll()
    }
    if (mode === 'off') unshuffle()
    if (mode === 'smart') mixInRecs()
  }

  const rows = (list) => (list || []).map((it) => {
    // A wrapper pairs a song with its music video; whichever one is playing describes the row.
    const w = it.playlistPanelVideoWrapperRenderer
    const prim = primary(it)
    const cp = w?.counterpart?.[0]?.counterpartRenderer?.playlistPanelVideoRenderer
    const r = cp?.selected ? cp : prim
    if (!r) return null
    // Square album art (from the song version, when there is one) at Now Playing size; otherwise
    // the largest thumbnail, which for a music video is a frame of the video.
    const urls = [r, prim, cp].flatMap((x) => thumbs(x).slice(-1).map((th) => th.url))
    const album = urls.find((u) => /googleusercontent|ggpht/.test(u || ''))
    const art = album ? album.replace(/=w\d+-h\d+/, '=w544-h544') : urls[0] || ''
    let artistId, albumId
    for (const run of r.longBylineText?.runs || []) {
      const id = run.navigationEndpoint?.browseEndpoint?.browseId || ''
      if (id.startsWith('UC') && !artistId) artistId = id
      if (id.startsWith('MPRE')) albumId = id
    }
    return {
      videoId: r.videoId, title: t(r.title), artist: t(r.shortBylineText), artistId, albumId,
      duration: t(r.lengthText), thumb: thumbs(r)[0]?.url || '', art, square: !!album,
      selected: !!prim?.selected || !!cp?.selected, rec: sh.recs.has(key(it))
    }
  })
  const queue = () => rows(document.querySelector('#queue')?.queue?.getItems?.())
  // YTM's autoplay recommendations ("Dynamic queue") that play after the queue runs out.
  const autoplay = () => (store()?.autoplay ? rows(store().automixItems).filter(Boolean) : [])
  const s = window.__ytspot = {
    video: ${videoMode}, t, queue, autoplay, sh, setShuffle,
    // Queue rows are rebuilt only when YTM's queue store changes; it's immutable, so identity says
    // whether anything changed. \`rev\` tells main whether its copy is current (unique per page load).
    page: Math.random().toString(36).slice(2), n: 0,
    snap() {
      hook()
      const st = store()
      if (st === s.src && s.q) return
      s.src = st
      s.rev = s.page + ':' + ++s.n
      s.q = queue().map((q) => q || { videoId: '', title: '', artist: '', duration: '', thumb: '', selected: false })
      s.a = autoplay()
    },
    apply() {
      const p = document.getElementById('movie_player'), tg = document.querySelector('ytmusic-av-toggle')
      if (!p?.setPlaybackQualityRange) return
      // YTM re-picks quality on its own (e.g. when playback starts), so re-apply on every change.
      if (!s.hooked) (s.hooked = true), p.addEventListener('onPlaybackQualityChange', () => s.apply())
      const videoSel = tg?.getAttribute('is-video-playback-mode-selected') === 'true'
      if (s.video) {
        if (tg && !videoSel) tg.querySelector('.video-button')?.click()
        if (p.getPlaybackQuality() === 'tiny') p.setPlaybackQualityRange('auto', 'auto')
      } else if (tg?.hasAttribute('audio-only-playback-available')) {
        // Premium audio-only stream: YTM stops downloading video entirely.
        if (videoSel) tg.querySelector('.song-button')?.click()
      } else if (p.getPlaybackQuality() !== 'tiny') {
        p.setPlaybackQualityRange('tiny', 'tiny')
      }
    }
  }
  // Media events don't bubble, but a capturing listener on document sees them.
  const later = () => { s.apply(); setTimeout(s.apply, 1500) }
  document.addEventListener('loadedmetadata', later, true)
  document.addEventListener('playing', later, true)
})()`

let videoMode = false
// Kept here too, so a reloaded YTM page starts in the same mode.
let shuffleMode: ShuffleMode = 'off'
const NEXT_SHUFFLE = { off: 'on', on: 'smart', smart: 'off' } as const

export function setVideoMode(on: boolean): void {
  videoMode = on
  run(`window.__ytspot && (window.__ytspot.video = ${on}, window.__ytspot.apply())`)
}

// `rev` is the queue revision main already has; the queue is only sent when it differs.
// "Is it playing?" for the movie player \`p\`, used by the play button and the toggle alike so
// they never disagree. A video that isn't paused is playing; so is one that only
// stopped because the next song is loading (it was playing a moment ago, YTM isn't in its
// "paused" state, and the stop wasn't our own pause, which YTM reports a beat late).
const IS_PLAYING = `((v, s) => v
  ? (!v.paused && !v.ended) || (v.paused && s !== 2 && Date.now() - (window.__ytspotPlayedAt || 0) < 3000 && (window.__ytspotPausedAt || 0) < (window.__ytspotPlayedAt || 0))
  : s === 1)(p.querySelector('video'), p.getPlayerState())`

const STATE_JS = (rev: string) => `(() => {
  const p = document.getElementById('movie_player'), y = window.__ytspot
  if (!p || !p.getVideoData || !y) return null
  y.snap()
  const d = p.getVideoData(), m = navigator.mediaSession.metadata, id = d.video_id || ''
  const bar = document.querySelector('ytmusic-player-bar')
  // Newer YTM builds have no player bar element. There, a real video is showing when the track is
  // a video (not a song's still artwork) and YTM's Song/Video switch, if it has one, is on Video.
  const tg = document.querySelector('ytmusic-av-toggle'), type = p.getPlayerResponse?.()?.videoDetails?.musicVideoType
  const shows = !!type && type !== 'MUSIC_VIDEO_TYPE_ATV' && (!tg || tg.getAttribute('is-video-playback-mode-selected') === 'true')
  const cur = y.q.find((q) => q && q.selected && q.videoId === id) || y.q.find((q) => q && q.videoId === id)
  // Right after a track change YTM already reports the new video but still has the previous song's
  // media metadata (title, artwork) for a moment; only trust it once it describes this video.
  const fresh = !!m?.title && m.title === d.title
  const msArt = m?.artwork?.length ? m.artwork[m.artwork.length - 1].src : ''
  // When listening (not watching), album art beats a frame of the music video.
  const thumb = (!y.video && cur?.square && cur.art) || (fresh && msArt) || cur?.art || ''
  return {
    videoId: id,
    title: (fresh && m.title) || cur?.title || d.title || '',
    artist: (fresh && m.artist) || cur?.artist || d.author || '',
    artistId: cur?.artistId,
    album: (fresh && m.album) || '',
    albumId: cur?.albumId,
    thumb,
    // Nothing reliable to show for this song yet; main waits a moment before pushing it.
    pending: !fresh && !cur,
    time: p.getCurrentTime() || 0,
    duration: p.getDuration() || 0,
    // The same notion of "playing" the toggle uses (see command), so the button always does what it shows.
    playing: ${IS_PLAYING},
    volume: p.getVolume(),
    muted: p.isMuted(),
    repeat: bar?.getAttribute('repeat-mode') || 'NONE',
    shuffle: y.sh.mode,
    liked: bar?.querySelector('ytmusic-like-button-renderer')?.getAttribute('like-status') === 'LIKE',
    isVideo: !!bar?.hasAttribute('is-video') || shows,
    videoMode: y.video,
    rev: y.rev,
    ...(y.rev === ${JSON.stringify(rev)} ? {} : { queue: y.q, autoplay: y.a })
  }
})()`

// Unchanged queues keep the same array references, so callers can compare them by identity.
let lastQueue: Pick<PlayerState, 'queue' | 'autoplay'> & { rev: string } = { rev: '', queue: [], autoplay: [] }
export async function getState(): Promise<PlayerState | null> {
  const s = await run<Omit<PlayerState, 'queue' | 'autoplay'> & Partial<PlayerState> & { rev: string }>(STATE_JS(lastQueue.rev))
  if (!s) return null
  const { rev, queue, autoplay, ...rest } = s
  if (queue && autoplay) lastQueue = { rev, queue, autoplay }
  return { ...rest, queue: lastQueue.queue, autoplay: lastQueue.autoplay }
}

const click = (sel: string) => `document.querySelector('ytmusic-player-bar ${sel}')?.click()`
const rate = (which: 'like' | 'dislike') =>
  `(r => (r?.querySelector('#button-shape-${which} button') || r?.querySelector('.${which}'))?.click())(document.querySelector('ytmusic-player-bar ytmusic-like-button-renderer'))`

// Bumped by every command that changes what's playing, so a `play` fallback that fires after the
// user has already skipped or picked something else doesn't drag playback back.
let playSeq = 0

// Play/pause during a track change. Right after Next, a song click or a jump, the old video reads
// as paused while the new one loads, and YTM starts the new one on its own a moment later; asking
// the video which way to toggle then gets it backwards. So for a few seconds after a track
// command, a toggle flips what the user last asked for (starting a track asks to play) instead.
const SWITCH_MS = 4000
let switching = 0 // when the last track command was sent
let wantPlaying = true
const TRACK_COMMANDS = ['play', 'next', 'prev', 'jump', 'jumpAuto', 'dislike']

export async function command(c: PlayerCommand): Promise<void> {
  const P = `document.getElementById('movie_player')`
  if (['play', 'next', 'prev', 'jump', 'jumpAuto', 'toggle', 'dislike'].includes(c.type)) playSeq++
  if (TRACK_COMMANDS.includes(c.type)) {
    switching = Date.now()
    wantPlaying = true
    run(`window.__ytspotHold = 0`)
  }
  switch (c.type) {
    case 'play': {
      const mine = playSeq
      const ep = JSON.stringify({ watchEndpoint: { videoId: c.videoId, playlistId: c.playlistId } })
      await run(`document.querySelector('ytmusic-app').dispatchEvent(new CustomEvent('yt-navigate',
        { bubbles: true, composed: true, detail: { endpoint: ${ep} } }))`)
      // In-app navigation is undocumented; fall back to a full load if it didn't take.
      setTimeout(async () => {
        if (mine !== playSeq) return
        const s = await getState()
        if (s?.videoId !== c.videoId) {
          const list = c.playlistId ? `&list=${c.playlistId}` : ''
          page?.loadURL(`${YTM}/watch?v=${c.videoId}${list}`)
        } else if (!s.playing && wantPlaying) run(`${P}.playVideo()`)
      }, 2500)
      return
    }
    // Decided by the <video> element itself: YTM's player state is "buffering" (3) both while
    // starting to play and while paused mid-seek, so it can't tell which way to go. A paused
    // video always plays and a playing (or buffering-to-play) one always pauses.
    case 'toggle':
      if (Date.now() - switching < SWITCH_MS) {
        wantPlaying = !wantPlaying
        // Holding the pause (10s, or until play is asked for) covers a new track that starts late.
        return void run(`(p => { window.__ytspotHold = ${wantPlaying ? 0 : 'Date.now() + 10000'}; ${wantPlaying ? 'p.playVideo()' : 'window.__ytspotPausedAt = Date.now(); p.pauseVideo()'} })(${P})`)
      }
      // A video that isn't paused, or that only stopped because the next one is loading (it was
      // playing a moment ago and isn't in YTM's "paused" state), counts as playing: pause it, and
      // hold the pause in case the next song starts by itself.
      return void run(`(p => {
        const on = ${IS_PLAYING}, v = p.querySelector('video')
        window.__ytspotHold = on && v?.paused ? Date.now() + 10000 : 0
        if (on) window.__ytspotPausedAt = Date.now()
        on ? p.pauseVideo() : p.playVideo()
      })(${P})`)
    case 'next':
      return void run(click('.next-button'))
    case 'prev':
      return void run(click('.previous-button'))
    // Off → shuffle → Smart Shuffle → off, like Spotify's button.
    case 'shuffle':
      return setShuffle(NEXT_SHUFFLE[shuffleMode])
    case 'shuffleMode':
      return setShuffle(c.mode)
    case 'repeat':
      return void run(click('.repeat'))
    case 'like':
      return void run(rate('like'))
    case 'dislike':
      return void run(rate('dislike'))
    case 'mute':
      return void run(`(p => p.isMuted() ? p.unMute() : p.mute())(${P})`)
    case 'seek':
      return void run(`${P}.seekTo(${c.seconds}, true)`)
    case 'volume':
      return void run(`(p => { p.unMute(); p.setVolume(${Math.round(c.value)}) })(${P})`)
    case 'jump':
      // Click the matching DOM row: the n-th occurrence of that video id among real queue rows.
      return void run(`(() => {
        const items = window.__ytspot.queue(), id = items[${c.index}]?.videoId
        const nth = items.slice(0, ${c.index}).filter((q) => q?.videoId === id).length
        const rows = [...document.querySelectorAll('${QUEUE_DOM}')].filter((e) => e.data?.videoId === id)
        rows[nth]?.querySelector('ytmusic-play-button-renderer')?.click()
      })()`)
    case 'jumpAuto':
      return void run(`(() => {
        const items = window.__ytspot.autoplay(), id = items[${c.index}]?.videoId
        const nth = items.slice(0, ${c.index}).filter((q) => q.videoId === id).length
        const rows = [...document.querySelectorAll('ytmusic-player-queue #automix-contents ytmusic-player-queue-item')]
          .filter((e) => e.parentElement?.id !== 'counterpart-renderer' && e.data?.videoId === id)
        rows[nth]?.querySelector('ytmusic-play-button-renderer')?.click()
      })()`)
    case 'queueAdd':
      // Same calls YTM's own "Play next" / "Add to queue" make (approach from Pear Desktop).
      return void run(`(() => {
        const q = document.querySelector('#queue'), app = document.querySelector('ytmusic-app')
        const store = q?.queue?.store?.store
        if (!store || !app) return
        const pos = ${c.next} ? 'INSERT_AFTER_CURRENT_VIDEO' : 'INSERT_AT_END'
        app.networkManager.fetch('/music/get_queue', {
          queueContextParams: store.getState().queue.queueContextParams,
          queueInsertPosition: pos, videoIds: ${JSON.stringify(c.videoIds)}
        }).then((res) => {
          const items = store.getState().queue.items
          const sel = items.findIndex((e) => (e.playlistPanelVideoRenderer || e.playlistPanelVideoWrapperRenderer?.primaryRenderer.playlistPanelVideoRenderer)?.selected)
          // Marked as the user's, so shuffle leaves them where they were put.
          window.__ytspot.sh.adding = true
          try {
            q.dispatch({ type: 'ADD_ITEMS', payload: {
              nextQueueItemId: store.getState().queue.nextQueueItemId,
              index: pos === 'INSERT_AFTER_CURRENT_VIDEO' ? sel + 1 : items.length,
              items: (res?.queueDatas || []).map((d) => d?.content).filter(Boolean),
              shuffleEnabled: false, shouldAssignIds: true
            } })
          } finally {
            window.__ytspot.sh.adding = false
          }
        })
      })()`)
    case 'queueMove':
      return void run(`document.querySelector('#queue')?.dispatch({ type: 'MOVE_ITEM', payload: { fromIndex: ${c.from}, toIndex: ${c.to} } })`)
    case 'autoplayMove':
      // Autoplay items live in their own list; YTM replaces it wholesale, then plays it in order.
      return void run(`(() => {
        const q = document.querySelector('#queue'), items = [...(q?.queue?.store?.store?.getState().queue.automixItems || [])]
        const [moved] = items.splice(${c.from}, 1)
        if (!moved) return
        items.splice(${c.to}, 0, moved)
        q.dispatch({ type: 'REPLACE_AUTOMIX_ITEMS', payload: { automixItems: items } })
      })()`)
    case 'queueRemove':
      return void run(`document.querySelector('#queue')?.dispatch({ type: 'REMOVE_ITEM', payload: ${c.index} })`)
    case 'videoMode':
      return setVideoMode(c.on)
  }
}

async function setShuffle(mode: ShuffleMode): Promise<void> {
  shuffleMode = mode
  await run(`window.__ytspot?.setShuffle(${JSON.stringify(mode)})`)
}

// ---- YouTube Music settings, read from and applied through YTM's own settings dialog ----

const SETTINGS_OPEN = `
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (fn) => { for (let i = 0; i < 50; i++) { const v = fn(); if (v) return v; await wait(100) } }
  const dialog = () => [...document.querySelectorAll('ytmusic-dialog, tp-yt-paper-dialog')].find((d) => d.querySelector('ytmusic-settings-page') && d.opened)
  if (!dialog()) {
    // Open it the way YTM's own menu entry does; clicking that entry's link can do a full page load.
    document.querySelector('ytmusic-app').dispatchEvent(new CustomEvent('yt-navigate',
      { bubbles: true, composed: true, detail: { endpoint: { applicationSettingsEndpoint: {} } } }))
    await until(dialog)
  }
  const page = dialog()?.querySelector('ytmusic-settings-page')
  if (!page) throw new Error('YouTube Music settings did not open')
  const tab = async (name) => { [...page.querySelectorAll('tp-yt-paper-item')].find((t) => t.innerText.trim() === name)?.click(); await wait(700) }
  const t = window.__ytspot.t
  const rows = () => [...page.querySelectorAll('ytmusic-setting-boolean-renderer, ytmusic-setting-single-option-menu-renderer, ytmusic-setting-action-renderer, ytmusic-setting-read-only-item-renderer')]
  const close = () => dialog()?.close()
`

const SETTINGS_READ = `(async () => {
  ${SETTINGS_OPEN}
  const out = []
  const tabs = [...page.querySelectorAll('tp-yt-paper-item')].map((x) => x.innerText.trim()).filter((n) => !['Downloads', 'About'].includes(n))
  for (const name of tabs) {
    await tab(name)
    for (const r of rows()) {
      const d = r.data, tag = r.tagName.toLowerCase()
      const base = { tab: name, title: t(d.title), summary: t(d.summary) || undefined }
      if (tag.includes('boolean'))
        out.push({ ...base, kind: 'toggle', value: !!d.enabled, endpoints: { true: d.enableServiceEndpoint, false: d.disableServiceEndpoint } })
      else if (tag.includes('single-option')) {
        const items = (d.items || []).map((i) => i.settingMenuItemRenderer || i)
        out.push({ ...base, kind: 'choice', options: items.map((i) => t(i.name)), value: t(items.find((i) => i.selected)?.name),
          endpoints: Object.fromEntries(items.map((i) => [t(i.name), i.updateServiceEndpoint])) })
      } else if (tag.includes('action')) {
        const c = d.confirmDialog?.confirmDialogRenderer
        out.push({ ...base, kind: 'action', confirm: c ? [t(c.title), ...(c.dialogMessages || []).map(t)].filter(Boolean).join('\\n') : undefined,
          endpoints: { run: d.serviceEndpoint } })
      } else if (d.navigationEndpoint?.urlEndpoint?.url) out.push({ ...base, kind: 'link', url: d.navigationEndpoint.urlEndpoint.url })
    }
  }
  close()
  return out
})()`

// Apply a setting by sending YTM's own request through the page's network client. Clicking the
// dialog instead makes YTM reload the page, which would stop playback.
const SETTINGS_APPLY = (endpoint: unknown) => `(async (ep) => {
  const net = document.querySelector('ytmusic-app').networkManager
  if (ep?.setSettingEndpoint) {
    const { settingItemId, boolValue, intValue } = ep.setSettingEndpoint
    return void await net.fetch('/account/set_setting', { settingItemId, newValue: boolValue !== undefined ? { boolValue } : { intValue } })
  }
  if (ep?.feedbackEndpoint) return void await net.fetch('/feedback', { feedbackTokens: [ep.feedbackEndpoint.feedbackToken] })
  // Language, location and Restricted Mode are cookie settings; YTM applies them by reloading.
  if (ep?.setClientSettingEndpoint) return void document.querySelector('ytmusic-app').handleSetClientSettingEndpoint(ep)
  throw new Error('Unsupported setting')
})(${JSON.stringify(endpoint)})`

// Like / unlike any song via YTM's own client (youtubei.js's WEB-client like call returns 400).
export async function rateVideo(videoId: string, like: boolean): Promise<void> {
  await page?.executeJavaScript(
    `document.querySelector('ytmusic-app').networkManager.fetch('/like/${like ? 'like' : 'removelike'}', { target: { videoId: ${JSON.stringify(videoId)} } }).then(() => true)`,
    true
  )
}

// Save an album or someone's playlist to your library (or remove it) through YTM's own client.
export async function saveToLibrary(playlistId: string, on: boolean): Promise<void> {
  const ok = await page?.executeJavaScript(
    `document.querySelector('ytmusic-app').networkManager.fetch('/like/${on ? 'like' : 'removelike'}', { target: { playlistId: ${JSON.stringify(playlistId)} } }).then(() => true)`,
    true
  )
  if (!ok) throw new Error('YouTube Music isn’t loaded yet')
}

// Follow / unfollow an artist (a YouTube subscription) through YTM's own client.
export async function subscribe(channelId: string, on: boolean): Promise<void> {
  await page?.executeJavaScript(
    `document.querySelector('ytmusic-app').networkManager.fetch('/subscription/${on ? 'subscribe' : 'unsubscribe'}', { channelIds: [${JSON.stringify(channelId)}] }).then(() => true)`,
    true
  )
}

// Reading settings clicks through YTM's dialog with short waits, which a throttled page would
// stretch to a second each, so lift throttling while it runs.
// One read at a time: two would click through the same dialog and close it under each other.
let settingsRead: Promise<unknown> = Promise.resolve()
export function ytmSettings(): Promise<YtmSetting[]> {
  const run = settingsRead.catch(() => undefined).then(async () => {
    if (!page) throw new Error('YouTube Music isn’t loaded yet')
    page.setBackgroundThrottling(false)
    try {
      return (await page.executeJavaScript(SETTINGS_READ, true)) as YtmSetting[]
    } finally {
      page?.setBackgroundThrottling(true)
    }
  })
  settingsRead = run
  return run
}
export async function applyYtmSetting(endpoint: unknown): Promise<void> {
  if (!page) return
  const reloads = !!(endpoint as { setClientSettingEndpoint?: unknown })?.setClientSettingEndpoint
  const before = reloads ? await getState() : null
  await page.executeJavaScript(SETTINGS_APPLY(endpoint), true).catch((e: Error) => {
    if (!reloads) throw e
  })
  if (!before?.videoId) return
  // Pick the song back up where it was once the reloaded page is ready.
  for (let i = 0; i < 60 && !(await run<boolean>('!!window.__ytspot && !!document.getElementById("movie_player")')); i++)
    await new Promise((r) => setTimeout(r, 250))
  await command({ type: 'play', videoId: before.videoId })
  setTimeout(() => {
    command({ type: 'seek', seconds: before.time })
    if (!before.playing) command({ type: 'toggle' })
  }, 3000)
}

// Uploads a playlist cover the way YTM's "Edit thumbnail" dialog does: a resumable Scotty upload
// from the signed-in page itself (it authenticates with the page's cookies). Returns the blob id
// that the playlist edit then points at.
export async function uploadImage(url: string, base64: string, mime: string): Promise<string> {
  if (!page) throw new Error('YouTube Music isn’t loaded yet')
  const id = await page.executeJavaScript(
    `(async (url, b64, mime) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const start = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(bytes.length) }
      })
      const to = start.headers.get('X-Goog-Upload-URL')
      if (!start.ok || !to) throw new Error('Upload refused (' + start.status + ')')
      const done = await fetch(to, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Goog-Upload-Command': 'upload, finalize', 'X-Goog-Upload-Offset': '0', 'Content-Type': mime },
        body: bytes
      })
      if (!done.ok) throw new Error('Upload failed (' + done.status + ')')
      return (await done.json()).encryptedBlobId
    })(${JSON.stringify(url)}, ${JSON.stringify(base64)}, ${JSON.stringify(mime)})`,
    true
  )
  if (!id) throw new Error('YouTube Music didn’t accept the image')
  return id as string
}
