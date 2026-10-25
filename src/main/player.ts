// Drives a hidden music.youtube.com window: YouTube's own player does the streaming
// (Premium, no ads, its queue/radio), we only send commands and read state.
import { BaseWindow, BrowserWindow, session, WebContentsView, type WebContents } from 'electron'
import type { PlayerCommand, PlayerState, YtmSetting } from '../shared/types'

const YTM = 'https://music.youtube.com'
// Same sign-in entry point Pear uses: Google login, then YouTube's sign-in handler, then YTM.
const LOGIN = `https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&continue=${encodeURIComponent(
  `https://www.youtube.com/signin?action_handle_signin=true&next=${encodeURIComponent(`${YTM}/`)}`
)}`
export const ytmSession = () => session.fromPartition('persist:ytm')

// The YTM page lives in its own view, parked in a hidden window (a BaseWindow has no page of its
// own). When a video should be watched, the view is moved into the main window over the Now
// Playing artwork, then parked again.
let host: BaseWindow | null = null
let view: WebContentsView | null = null
let page: WebContents | null = null
let login: BrowserWindow | null = null

const HIDDEN_BOUNDS = { x: 0, y: 0, width: 1000, height: 700 }

// While shown in the app, only the <video> is visible, filling the view.
const VIDEO_CSS = `
  html.ytspot-video, html.ytspot-video body { background: #000 !important; overflow: hidden !important; }
  html.ytspot-video * { visibility: hidden !important; transform: none !important; contain: none !important;
    will-change: auto !important; filter: none !important; transition: none !important; }
  html.ytspot-video video { visibility: visible !important; position: fixed !important; inset: 0 !important;
    width: 100vw !important; height: 100vh !important; object-fit: cover !important; z-index: 2147483647 !important; }
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
  // don't run YTM's offline service worker, which costs a whole extra process.
  const urls = ['*://*.ytimg.com/*', '*://*.ggpht.com/*', '*://*.googleusercontent.com/*', '*://*.gstatic.com/*', '*://music.youtube.com/sw.js*']
  ytmSession().webRequest.onBeforeRequest({ urls }, (d, cb) =>
    cb({ cancel: d.url.includes('/sw.js') || (d.webContentsId === id && d.resourceType === 'image') })
  )
  ytmSession().clearStorageData({ storages: ['serviceworkers'] })
  // YTM's "Leave site?" beforeunload handler would otherwise silently block quitting and reloads.
  p.on('will-prevent-unload', (e) => e.preventDefault())
  p.on('dom-ready', () => {
    p.insertCSS(VIDEO_CSS)
    run(SETUP_JS(videoMode))
  })
  p.loadURL(YTM)
  return host
}

// Show the playing video at `rect` inside `main` (null puts the page back out of sight).
let shownIn: BrowserWindow | null = null
export function placeVideo(main: BrowserWindow | null, rect: Electron.Rectangle | null): void {
  if (!view || !host) return
  if (main && rect) {
    if (shownIn !== main) main.contentView.addChildView(view)
    shownIn = main
    view.setVisible(true)
    view.setBounds(rect)
    view.setBorderRadius(8)
    run(`document.documentElement.classList.add('ytspot-video')`)
  } else if (shownIn) {
    shownIn = null
    host.contentView.addChildView(view)
    view.setVisible(false)
    view.setBounds(HIDDEN_BOUNDS)
    view.setBorderRadius(0)
    run(`document.documentElement.classList.remove('ytspot-video')`)
  }
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
const SETUP_JS = (videoMode: boolean) => `(() => {
  if (window.__ytspot) return
  const t = (x) => typeof x === 'string' ? x : x?.runs ? x.runs.map((r) => r.text).join('') : (x?.simpleText || '')
  const store = () => document.querySelector('#queue')?.queue?.store?.store?.getState?.().queue
  const rows = (list) => (list || []).map((it) => {
    const w = it.playlistPanelVideoWrapperRenderer
    const r = it.playlistPanelVideoRenderer || w?.primaryRenderer?.playlistPanelVideoRenderer
    if (!r) return null
    let artistId, albumId
    for (const run of r.longBylineText?.runs || []) {
      const id = run.navigationEndpoint?.browseEndpoint?.browseId || ''
      if (id.startsWith('UC') && !artistId) artistId = id
      if (id.startsWith('MPRE')) albumId = id
    }
    return {
      videoId: r.videoId, title: t(r.title), artist: t(r.shortBylineText), artistId, albumId,
      duration: t(r.lengthText), thumb: r.thumbnail?.thumbnails?.[0]?.url || '',
      selected: !!r.selected || JSON.stringify(w?.counterpart || '').includes('"selected":true')
    }
  })
  const queue = () => rows(document.querySelector('#queue')?.queue?.getItems?.())
  // YTM's autoplay recommendations ("Dynamic queue") that play after the queue runs out.
  const autoplay = () => (store()?.autoplay ? rows(store().automixItems).filter(Boolean) : [])
  const s = window.__ytspot = {
    video: ${videoMode}, t, queue, autoplay,
    // Queue rows are rebuilt only when YTM's queue store changes; it's immutable, so identity says
    // whether anything changed. \`rev\` tells main whether its copy is current (unique per page load).
    page: Math.random().toString(36).slice(2), n: 0,
    snap() {
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
export function setVideoMode(on: boolean): void {
  videoMode = on
  run(`window.__ytspot && (window.__ytspot.video = ${on}, window.__ytspot.apply())`)
}

// `rev` is the queue revision main already has; the queue is only sent when it differs.
const STATE_JS = (rev: string) => `(() => {
  const p = document.getElementById('movie_player'), y = window.__ytspot
  if (!p || !p.getVideoData || !y) return null
  y.snap()
  const d = p.getVideoData(), m = navigator.mediaSession.metadata
  const bar = document.querySelector('ytmusic-player-bar')
  const cur = y.q.find((q) => q.selected)
  return {
    videoId: d.video_id || '',
    title: m?.title || d.title || '',
    artist: m?.artist || d.author || '',
    artistId: cur?.artistId,
    album: m?.album || '',
    albumId: cur?.albumId,
    thumb: m?.artwork?.length ? m.artwork[m.artwork.length - 1].src : '',
    time: p.getCurrentTime() || 0,
    duration: p.getDuration() || 0,
    playing: p.getPlayerState() === 1 || p.getPlayerState() === 3,
    volume: p.getVolume(),
    muted: p.isMuted(),
    repeat: bar?.getAttribute('repeat-mode') || 'NONE',
    liked: bar?.querySelector('ytmusic-like-button-renderer')?.getAttribute('like-status') === 'LIKE',
    isVideo: !!bar?.hasAttribute('is-video'),
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

export async function command(c: PlayerCommand): Promise<void> {
  const P = `document.getElementById('movie_player')`
  switch (c.type) {
    case 'play': {
      const ep = JSON.stringify({ watchEndpoint: { videoId: c.videoId, playlistId: c.playlistId } })
      await run(`document.querySelector('ytmusic-app').dispatchEvent(new CustomEvent('yt-navigate',
        { bubbles: true, composed: true, detail: { endpoint: ${ep} } }))`)
      // In-app navigation is undocumented; fall back to a full load if it didn't take.
      setTimeout(async () => {
        const s = await getState()
        if (s?.videoId !== c.videoId) {
          const list = c.playlistId ? `&list=${c.playlistId}` : ''
          page?.loadURL(`${YTM}/watch?v=${c.videoId}${list}`)
        } else if (!s.playing) run(`${P}.playVideo()`)
      }, 2500)
      return
    }
    case 'toggle':
      return void run(`(p => p.getPlayerState() === 1 ? p.pauseVideo() : p.playVideo())(${P})`)
    case 'next':
      return void run(click('.next-button'))
    case 'prev':
      return void run(click('.previous-button'))
    case 'shuffle':
      return void run(click('.shuffle'))
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
          queueInsertPosition: pos, videoIds: [${JSON.stringify(c.videoId)}]
        }).then((res) => {
          const items = store.getState().queue.items
          const sel = items.findIndex((e) => (e.playlistPanelVideoRenderer || e.playlistPanelVideoWrapperRenderer?.primaryRenderer.playlistPanelVideoRenderer)?.selected)
          q.dispatch({ type: 'ADD_ITEMS', payload: {
            nextQueueItemId: store.getState().queue.nextQueueItemId,
            index: pos === 'INSERT_AFTER_CURRENT_VIDEO' ? sel + 1 : items.length,
            items: (res?.queueDatas || []).map((d) => d?.content).filter(Boolean),
            shuffleEnabled: false, shouldAssignIds: true
          } })
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

// Reading settings clicks through YTM's dialog with short waits, which a throttled page would
// stretch to a second each, so lift throttling while it runs.
export async function ytmSettings(): Promise<YtmSetting[] | null> {
  page?.setBackgroundThrottling(false)
  try {
    return await run<YtmSetting[]>(SETTINGS_READ)
  } finally {
    page?.setBackgroundThrottling(true)
  }
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
