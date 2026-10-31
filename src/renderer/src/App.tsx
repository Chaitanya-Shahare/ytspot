import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ArtistPage, Card, LibraryFilter, PlayerState, QueueItem, ShuffleMode, Track } from '../../shared/types'
import * as I from './components/icons'
import { Ctx, fmt, getClock, libraryChanged, loadPrefs, onLibraryChange, playlistChanged, resetCache, routeFor, savePrefs, setClock, sized, useApp, useCached, useColor, useTime, type AppCtx, type Prefs, type Route, type SaveSong, type Source, type ToastAction, sameRoute } from './lib'
import { bindings, comboLabel, comboOf, SHORTCUTS, type Action } from '../../shared/shortcuts'
import { cardMenu, songMenu } from './components/menus'
import { Boundary, Img } from './components/ui'
import { SavePopover } from './components/save'
import { SettingsView } from './views/settings'
import { FullScreenLyrics, LyricsCard, LyricsView, lyricsBackground } from './views/lyrics'
import { MoodView, SearchView } from './views/search'
import { ArtistView, CollectionView, ExploreView, HomeView, MoreView, resetHome } from './views/views'

const LIKED: Card = { kind: 'playlist', id: 'LM', title: 'Liked Songs', subtitle: 'Playlist', thumb: '' }
type LibrarySort = 'Recents' | 'Alphabetical' | 'Creator'
// Spotify's "View as": rows with artwork, text-only rows, or a grid of covers.
type LibraryView = 'List' | 'Compact' | 'Grid'
const VIEW_ICON = { List: I.ViewList, Compact: I.ViewCompact, Grid: I.ViewGrid }

// Sidebar widths the user dragged to (px); null keeps the right panel's default responsive width.
interface Layout {
  left: number
  right: number | null
}
const loadLayout = (): Layout => ({ left: 280, right: null, ...JSON.parse(localStorage.getItem('layout') ?? '{}') })
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
// Like Spotify, a sidebar can't squeeze the main view below this; the library collapses to its
// icon rail when dragged narrower than COLLAPSE_AT.
const MAIN_MIN = 400
const COLLAPSE_AT = 200
// Where typing happens (keys are text there), and what can be pressed.
const TEXT_ENTRY = 'input:not([type=button], [type=checkbox], [type=radio], [type=range], [type=file]), textarea, select, [contenteditable=""], [contenteditable="true"]'
const CONTROL = 'button, a[href], summary, [role=button], [role=switch], [role=slider], [role=menuitem], [role=tab], [role=option]'
const REPEATABLE = new Set<Action>(['seekFwd', 'seekBack', 'seekFwdSmall', 'seekBackSmall', 'volUp', 'volDown', 'back', 'forward'])
const OVERLAY_ACTIONS = new Set<Action>(['toggle', 'next', 'prev', 'seekFwd', 'seekBack', 'seekFwdSmall', 'seekBackSmall', 'shuffle', 'repeat', 'volUp', 'volDown', 'mute', 'like', 'dislike', 'fullscreen', 'lyrics', 'help'])

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  // History and position change together, so they live in one state (no stale-position races).
  const [nav, setNav] = useState<{ history: Route[]; pos: number }>({ history: [{ name: 'home' }], pos: 0 })
  const { history, pos } = nav
  const back = useCallback(() => setNav((n) => ({ ...n, pos: Math.max(0, n.pos - 1) })), [])
  const forward = useCallback(() => setNav((n) => ({ ...n, pos: Math.min(n.history.length - 1, n.pos + 1) })), [])
  const [player, setPlayer] = useState<PlayerState | null>(null)
  // A repeated message restarts the timer (each toast has its own id); `out` plays the fade-out.
  const [toastMsg, setToastMsg] = useState<{ id: number; msg: string; action?: ToastAction; out?: boolean } | null>(null)
  const [save, setSave] = useState<{ song: SaveSong; anchor: DOMRect } | null>(null)
  const openSave = useCallback((song: SaveSong, from: HTMLElement) => setSave({ song, anchor: from.getBoundingClientRect() }), [])
  const closeSave = useCallback(() => setSave(null), [])
  const [left, setLeft] = useState(window.innerWidth > 1100)
  const [right, setRight] = useState(true)
  // The right sidebar shows either Now Playing or the Queue, as in Spotify.
  const [panel, setPanel] = useState<'np' | 'queue'>('np')
  const [help, setHelp] = useState(false)
  const [full, setFull] = useState(false)
  // The full-screen player shows the lyrics instead of the artwork or video.
  const [fullLyrics, setFullLyrics] = useState(false)
  const [layout, setLayout] = useState<Layout>(loadLayout)
  useEffect(() => localStorage.setItem('layout', JSON.stringify(layout)), [layout])
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs)
  const setPrefs = useCallback(
    (p: Partial<Prefs>) =>
      setPrefsState((prev) => {
        const next = { ...prev, ...p }
        savePrefs(next)
        return next
      }),
    []
  )
  const keys = useMemo(() => bindings(prefs.shortcuts), [prefs.shortcuts])
  useEffect(() => void window.ytm.setBindings(keys), [keys])
  useEffect(() => {
    window.ytm.setPrefs({ keepPlaying: prefs.keepPlaying, videoMode: prefs.videoMode, openAtLogin: prefs.openAtLogin, menuBar: prefs.menuBar })
  }, [prefs.keepPlaying, prefs.videoMode, prefs.openAtLogin, prefs.menuBar])
  const searchRef = useRef<HTMLInputElement>(null)
  const route = history[pos]

  // The page zoom (View → Zoom In/Out), for the parts of the title bar that must not scale with it.
  // Zooming resizes the viewport, so a resize is when to look again.
  useEffect(() => {
    const apply = () => document.documentElement.style.setProperty('--zoom', String(window.ytm.zoom()))
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])

  // Collapse the library when the window gets narrow (and reopen it when it widens again), but only
  // when crossing that width, so a resize doesn't undo the user's own toggle.
  const [winW, setWinW] = useState(window.innerWidth)
  useEffect(() => {
    let wide = window.innerWidth > 1100
    const fit = () => {
      setWinW(window.innerWidth)
      if (wide !== window.innerWidth > 1100) setLeft((wide = !wide))
    }
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  useEffect(() => {
    window.ytm.authStatus().then(setAuthed, () => setAuthed(false))
    const offAuth = window.ytm.onAuth(setAuthed)
    // The clock ticks separately (main sends just the time when nothing else changed), so only the
    // progress bar re-renders while a song plays.
    const onState = (s: PlayerState) => {
      setClock(s.time)
      setPlayer(s)
    }
    // Main only pushes changes, so ask for the current state once on startup.
    window.ytm.state().then((s) => s && onState(s))
    const offState = window.ytm.onState(onState)
    const offTime = window.ytm.onTime(setClock)
    return () => (offAuth(), offState(), offTime())
  }, [])

  // Where each history entry was scrolled to, so Back/Forward land where you left off.
  const scrolls = useRef(new Map<number, number>())

  const go = useCallback(
    (r: Route) =>
      setNav((n) => {
        // Typing in search replaces the current search entry instead of stacking one per keystroke.
        if (r.name === 'search' && n.history[n.pos].name === 'search')
          return { ...n, history: n.history.map((x, i) => (i === n.pos ? r : x)) }
        // Already there (Home on Home, the open playlist in the library): back to the top instead.
        if (JSON.stringify(r) === JSON.stringify(n.history[n.pos])) {
          document.querySelector('.main-scroll')?.scrollTo({ top: 0, behavior: 'smooth' })
          return n
        }
        scrolls.current.forEach((_, k) => k > n.pos && scrolls.current.delete(k))
        return { history: [...n.history.slice(0, n.pos + 1), r], pos: n.pos + 1 }
      }),
    []
  )

  // Signing in or out: drop everything cached for the old session and redraw the page.
  const [epoch, setEpoch] = useState(0)
  const lastAuth = useRef<boolean | null>(null)
  useEffect(() => {
    if (authed === null) return
    if (lastAuth.current !== null && lastAuth.current !== authed) {
      resetCache()
      resetHome()
      setSource(null)
      setEpoch((e) => e + 1)
    }
    lastAuth.current = authed
  }, [authed])

  const toast = useCallback((msg: string, action?: ToastAction) => setToastMsg({ id: Date.now(), msg, action }), [])
  useEffect(() => {
    if (!toastMsg || toastMsg.out) return
    // One with a button stays long enough to reach it.
    const t = setTimeout(() => setToastMsg((m) => m && { ...m, out: true }), toastMsg.action ? 5000 : 3000)
    return () => clearTimeout(t)
  }, [toastMsg])

  const like = useCallback(() => {
    if (!player?.videoId) return
    window.ytm.cmd({ type: 'like' })
    playlistChanged('LM')
    toast(player?.liked ? 'Removed from Liked Songs' : 'Added to Liked Songs')
  }, [player?.videoId, player?.liked, toast])
  // Spotify's + button: saves the song to Liked Songs and opens "Add to playlist" for anything else;
  // once saved (a green tick) it just opens the popover, where Liked Songs can be unticked.
  const plus = useCallback(
    (from: HTMLElement) => {
      if (!player?.videoId) return
      if (!player.liked) like()
      openSave({ videoId: player.videoId, title: player.title }, from)
    },
    [player?.videoId, player?.liked, player?.title, like, openSave]
  )
  const closeFull = useCallback(() => setFull(false), [])
  const openFull = useCallback((lyrics: boolean) => (setFullLyrics(lyrics), setFull(true)), [])
  // The song went away (e.g. the player page reloaded): leave full screen rather than leave it
  // armed for whatever plays next.
  useEffect(() => {
    if (!player?.videoId) setFull(false)
  }, [player?.videoId])

  // Off → shuffle → Smart Shuffle → off, like Spotify's button; `mode` picks one directly.
  const shuffle = useCallback(
    (mode?: ShuffleMode) => {
      const from = player?.shuffle ?? 'off'
      const to = mode ?? NEXT_SHUFFLE[from]
      if (to === from) return
      window.ytm.cmd({ type: 'shuffleMode', mode: to })
      toast(SHUFFLE_TOAST[to])
    },
    [player?.shuffle, toast]
  )

  // The Queue and Now Playing buttons each open their view, or close it when it's already showing.
  const showPanel = useCallback(
    (which: 'np' | 'queue') => {
      if (right && panel === which) return setRight(false)
      setPanel(which)
      setRight(true)
    },
    [right, panel]
  )
  const openQueue = useCallback(() => showPanel('queue'), [showPanel])

  const toggleLyrics = useCallback(
    () => (route.name === 'lyrics' && pos > 0 ? back() : route.name !== 'lyrics' && go({ name: 'lyrics' })),
    [route.name, pos, back, go]
  )

  const [source, setSource] = useState<Source | null>(null)
  const playTrack = useCallback((t: Track, playlistId?: string, from?: Source) => {
    setSource(from ?? null)
    window.ytm.cmd({ type: 'play', videoId: t.videoId, playlistId })
  }, [])

  // Albums, playlists and artists open their page; songs and videos play.
  const openCard = useCallback(
    (c: Card) => {
      const r = routeFor(c)
      if (r) return go(r)
      if (c.kind !== 'song' && c.kind !== 'video') return toast('That can’t be played here yet')
      setSource(null)
      window.ytm.cmd({ type: 'play', videoId: c.id })
    },
    [go, toast]
  )

  const playCard = useCallback(
    async (c: Card) => {
      const r = routeFor(c)
      try {
        if (c.kind === 'song' || c.kind === 'video') {
          setSource(null)
          return void (await window.ytm.cmd({ type: 'play', videoId: c.id }))
        }
        if (!r) return toast('That can’t be played here yet')
        // Artists play their top songs as a list, the same as their page's play button.
        if (c.kind === 'artist') {
          const a = await window.ytm.artist(c.id)
          if (!a.songs[0]) return
          setSource({ route: r, title: c.title, ids: a.songs.map((t: Track) => t.videoId) })
          window.ytm.cmd({ type: 'play', videoId: a.songs[0].videoId, playlistId: a.songsMore?.browseId.replace(/^VL/, '') })
          return
        }
        const col = c.kind === 'album' ? await window.ytm.album(c.id) : await window.ytm.playlist(c.id, true)
        if (!col.tracks[0]) return
        setSource({ route: r, title: c.title, ids: col.tracks.map((t: Track) => t.videoId) })
        window.ytm.cmd({ type: 'play', videoId: col.tracks[0].videoId, playlistId: col.playlistId })
      } catch {
        toast('Couldn’t play that — check your connection')
      }
    },
    [toast]
  )

  // Volume as last set here, so holding the volume key steps from the newest value rather than
  // the one the player last reported.
  const volume = useRef(50)
  useEffect(() => {
    if (player) volume.current = player.muted ? 0 : player.volume
  }, [player])
  const seekBy = (d: number) => {
    const t = Math.max(0, getClock() + d)
    setClock(t)
    window.ytm.cmd({ type: 'seek', seconds: t })
  }
  const setVolume = (v: number) => window.ytm.cmd({ type: 'volume', value: (volume.current = Math.min(100, Math.max(0, v))) })

  // One handler for both keyboard shortcuts and menu-bar clicks.
  const run = useCallback(
    (a: Action) => {
      const cmd = window.ytm.cmd
      switch (a) {
        case 'toggle': return void cmd({ type: 'toggle' })
        case 'next': return void cmd({ type: 'next' })
        case 'prev': return void cmd({ type: 'prev' })
        case 'seekFwd': return seekBy(10)
        case 'seekBack': return seekBy(-10)
        case 'seekFwdSmall': return seekBy(1)
        case 'seekBackSmall': return seekBy(-1)
        case 'mute': return void cmd({ type: 'mute' })
        case 'dislike':
          if (!player?.videoId) return
          cmd({ type: 'dislike' })
          return toast('Disliked — skipping')
        case 'explore': return go({ name: 'explore' })
        case 'library': return setLeft(true)
        case 'settings': return go({ name: 'settings' })
        // From the Lyrics page, full screen opens on the lyrics.
        case 'fullscreen': return full ? setFull(false) : player?.videoId && openFull(route.name === 'lyrics')
        case 'lyrics': return full ? setFullLyrics((v) => !v) : toggleLyrics()
        case 'volUp': return setVolume(volume.current + 10)
        case 'volDown': return setVolume(volume.current - 10)
        case 'shuffle': return shuffle()
        case 'repeat': return void cmd({ type: 'repeat' })
        case 'like': return like()
        case 'search': searchRef.current?.focus(); searchRef.current?.select(); return
        case 'home': return go({ name: 'home' })
        case 'back': return back()
        case 'forward': return forward()
        case 'queue': return openQueue()
        case 'liked': return go({ name: 'playlist', id: 'LM' })
        case 'toggleLeft': return setLeft((v) => !v)
        case 'toggleRight': return showPanel('np')
        case 'help': return setHelp((v) => !v)
      }
    },
    [player, go, back, forward, like, shuffle, openQueue, showPanel, toast, toggleLyrics, full, openFull, route.name]
  )

  // Keyboard: Esc closes overlays/leaves the search box; otherwise match combos and sequences
  // ("G H") against the user's bindings. Bare-key shortcuts never fire while typing.
  useEffect(() => {
    const byCombo = new Map<string, Action>()
    for (const s of SHORTCUTS) for (const c of keys[s.action]) if (!byCombo.has(c)) byCombo.set(c, s.action)
    let pending = ''
    let timer: ReturnType<typeof setTimeout>
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null
      const typing = !!el?.matches(TEXT_ENTRY)
      const control = !typing && !!el?.closest(CONTROL)
      // With keyboard navigation on, a control reached from the keyboard keeps the keys it uses. A
      // control merely clicked never does: Space stays play/pause wherever you last clicked.
      const ownsKeys = control && prefs.keyboardNav && el === keyboardFocus
      if (e.key === 'Tab' && !prefs.keyboardNav && !el?.closest('.modal, .save-pop')) return e.preventDefault()
      if (e.key === 'Escape') {
        if (help) return setHelp(false)
        if (full) return setFull(false)
        if (typing) return el?.blur()
      }
      const combo = comboOf(e)
      if (!combo) return
      if (typing && (!e.metaKey || /Left|Right|Up|Down/.test(combo))) return
      if (ownsKeys && (e.key === ' ' || e.key === 'Enter' || (/^Arrow/.test(e.key) && el?.closest('[role=slider]')))) return
      // A clicked button must not be pressed again by Space or Return (the browser's default).
      if (control && (e.key === ' ' || e.key === 'Enter')) e.preventDefault()
      const seq = pending ? `${pending} ${combo}` : combo
      clearTimeout(timer)
      pending = ''
      const a = byCombo.get(seq) ?? (seq !== combo ? byCombo.get(combo) : undefined)
      // Over the shortcuts sheet or the full-screen player, only playback keys (and the keys that
      // close them) act; navigating the page hidden behind would be invisible.
      if (a && (help || full) && !OVERLAY_ACTIONS.has(a)) return e.preventDefault()
      if (a) {
        e.preventDefault()
        // The shortcut wins over whatever is focused (a slider's own arrow keys, a row's Return).
        e.stopPropagation()
        // Holding a key repeats seeking and volume, not toggles like play/pause or shuffle.
        if (e.repeat && !REPEATABLE.has(a)) return
        return run(a)
      }
      if ([...byCombo.keys()].some((k) => k.startsWith(`${seq} `))) {
        e.preventDefault()
        pending = seq
        timer = setTimeout(() => (pending = ''), 1200)
      }
    }
    // Buttons are pressed by Space on key *up*; a clicked one mustn't be.
    const onKeyUp = (e: KeyboardEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null
      if (e.key !== ' ' || !el || el.matches(TEXT_ENTRY) || !el.closest(CONTROL)) return
      if (!(prefs.keyboardNav && el === keyboardFocus)) e.preventDefault()
    }
    // Which element got focus from the keyboard (Tab) rather than a click. Tracked here because
    // the browser's :focus-visible can stay on after a mouse click once a key has been pressed.
    // Focus follows whichever came last: a click, or a key (Tab).
    let keyboardFocus: Element | null = null
    let byKeyboard = false
    const onPointer = () => ((byKeyboard = false), (keyboardFocus = null))
    const onAnyKey = () => (byKeyboard = true)
    const onFocus = (e: FocusEvent) => (keyboardFocus = byKeyboard ? (e.target as Element) : null)
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onAnyKey, true)
    document.addEventListener('focusin', onFocus)
    // Capture phase: decided before any focused element or React handler sees the key.
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKeyUp, true)
    const offMenu = window.ytm.onMenu(run)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onAnyKey, true)
      document.removeEventListener('focusin', onFocus)
      offMenu()
      clearTimeout(timer)
    }
  }, [run, keys, help, full, prefs.keyboardNav])

  // "Playing from" holds only while one of its songs is playing (not after radio or autoplay).
  const liveSource = source && (!source.ids || !player?.videoId || source.ids.includes(player.videoId)) ? source : null
  const ctx: AppCtx = useMemo(
    () => ({ route, go, player, playTrack, source: liveSource, openCard, playCard, toast, openSave, prefs, setPrefs, openQueue }),
    [route, go, player, playTrack, liveSource, openCard, playCard, toast, openSave, prefs, setPrefs, openQueue]
  )

  if (authed === null) return <div className="splash" />

  const rightShown = right && (panel === 'queue' || !!player?.videoId)
  const maxSide = (other: number) => Math.max(280, winW - other - MAIN_MIN - 32)
  const rightPx = () => document.querySelector('.now-playing')?.getBoundingClientRect().width ?? 0
  const leftPx = () => document.querySelector('.library')?.getBoundingClientRect().width ?? 0
  const resizeLeft = (w: number) => {
    setLeft(w >= COLLAPSE_AT)
    if (w >= COLLAPSE_AT) setLayout((l) => ({ ...l, left: clamp(w, 280, maxSide(rightPx())) }))
  }
  const resizeRight = (w: number) => setLayout((l) => ({ ...l, right: clamp(w, 280, maxSide(leftPx())) }))
  // Widths saved on a bigger screen are fitted to this window so the main view keeps its minimum.
  const rightW = rightShown ? (layout.right ?? clamp(winW * 0.24, 280, 420)) : 0
  const leftW = left ? clamp(layout.left, 280, maxSide(rightW)) : 72
  const vars = {
    ...(left ? { '--left-w': `${leftW}px` } : {}),
    ...(layout.right ? { '--right-w': `${clamp(layout.right, 280, maxSide(leftW))}px` } : {})
  } as React.CSSProperties

  return (
    <Ctx.Provider value={ctx}>
      <div className={`app ${left ? '' : 'left-collapsed'} ${rightShown ? '' : 'right-hidden'}`} style={vars}>
        <TopBar
          authed={authed}
          onHelp={() => setHelp(true)}
          searchRef={searchRef}
          canBack={pos > 0}
          canFwd={pos < history.length - 1}
          onBack={back}
          onFwd={forward}
        />
        <LibraryPanel key={epoch} authed={authed} collapsed={!left} onToggle={() => setLeft((v) => !v)} />
        <Resizer side="left" width={leftPx} onResize={resizeLeft} label="Resize Your Library" />
        {/* Typing in search keeps the same page (and its filter chip); every other move starts fresh. */}
        <main className="main-view" key={`${epoch}:${route.name === 'search' ? 'search' : JSON.stringify(route)}`}>
          <div
            className="main-scroll"
            ref={(el) => restoreScroll(el, scrolls.current.get(pos))}
            onScroll={(e) => scrolls.current.set(pos, e.currentTarget.scrollTop)}
          >
            <Boundary resetKey={JSON.stringify(route)}>
            {route.name === 'home' && <HomeView />}
            {route.name === 'search' && <SearchView q={route.q} />}
            {route.name === 'playlist' && <CollectionView kind="playlist" id={route.id} />}
            {route.name === 'album' && <CollectionView kind="album" id={route.id} />}
            {route.name === 'artist' && <ArtistView id={route.id} />}
            {route.name === 'explore' && <ExploreView />}
            {route.name === 'mood' && <MoodView params={route.params} title={route.title} />}
            {route.name === 'settings' && <SettingsView authed={authed} />}
            {route.name === 'lyrics' && <LyricsView />}
            {route.name === 'more' && <MoreView title={route.title} browseId={route.browseId} params={route.params} />}
            </Boundary>
          </div>
        </main>
        {rightShown && (
          <>
            <Resizer side="right" width={rightPx} onResize={resizeRight} label="Resize Now Playing view" />
            <Boundary resetKey={`${panel}:${player?.videoId}`}>
              {panel === 'queue' ? (
                <QueuePanel onClose={() => setRight(false)} />
              ) : (
                <NowPlayingPanel onClose={() => setRight(false)} onPlus={plus} onQueue={openQueue} onFullLyrics={() => openFull(true)} covered={help || full} />
              )}
            </Boundary>
          </>
        )}
        <PlayerBar
          rightOpen={rightShown && panel === 'np'}
          queueOpen={rightShown && panel === 'queue'}
          onToggleRight={() => showPanel('np')}
          onPlus={plus}
          onShuffle={shuffle}
          onLyrics={toggleLyrics}
          onFull={() => openFull(route.name === 'lyrics')}
        />
      </div>
      {full && player?.videoId && (
        <Boundary resetKey={player.videoId}>
          <FullScreenView lyrics={fullLyrics} onLyrics={() => setFullLyrics((v) => !v)} onClose={closeFull} onPlus={plus} onShuffle={shuffle} />
        </Boundary>
      )}
      {help && <ShortcutsModal keys={keys} onClose={() => setHelp(false)} />}
      {toastMsg && (
        <div
          key={toastMsg.id}
          className={`toast ${toastMsg.out ? 'out' : ''}`}
          role="status"
          onAnimationEnd={() => toastMsg.out && setToastMsg(null)}
        >
          {toastMsg.msg}
          {toastMsg.action && (
            <button className="toast-action" onClick={() => (toastMsg.action!.run(), setToastMsg({ ...toastMsg, out: true }))}>
              {toastMsg.action.label}
            </button>
          )}
        </div>
      )}
      {save && <SavePopover key={save.song.videoId} song={save.song} anchor={save.anchor} onClose={closeSave} />}
      <Tooltips keys={keys} />
    </Ctx.Provider>
  )
}

function TopBar(p: {
  authed: boolean
  onHelp: () => void
  searchRef: React.RefObject<HTMLInputElement | null>
  canBack: boolean
  canFwd: boolean
  onBack: () => void
  onFwd: () => void
}) {
  const { route, go } = useApp()
  const [q, setQ] = useState(route.name === 'search' ? route.q : '')
  const [me, setMe] = useState<{ name: string; photo: string } | null>(null)
  useEffect(() => {
    if (p.authed) window.ytm.account().then(setMe).catch(() => setMe(null))
  }, [p.authed])
  const accountMenu = async () => {
    const pick = await window.ytm.popup([
      { id: 'name', label: me?.name ?? 'Signed in', enabled: false },
      { id: '-', label: '-' },
      { id: 'settings', label: 'Settings' },
      { id: 'help', label: 'Keyboard shortcuts' },
      { id: 'open', label: 'Open YouTube Music in browser' },
      { id: '-', label: '-' },
      { id: 'logout', label: 'Log out' }
    ])
    if (pick === 'help') p.onHelp()
    if (pick === 'settings') go({ name: 'settings' })
    if (pick === 'open') window.ytm.open('https://music.youtube.com')
    if (pick === 'logout') window.ytm.logout()
  }
  // The box follows navigation (Back to an earlier search shows its query; leaving search clears
  // it, as in Spotify) but not the debounced updates of what's being typed.
  const typed = useRef(q)
  useEffect(() => {
    const now = route.name === 'search' ? route.q : ''
    if (now !== typed.current) setQ((typed.current = now))
  }, [route])
  // Typing searches (from any page); just focusing the box stays put, as in Spotify.
  useEffect(() => {
    const now = route.name === 'search' ? route.q : ''
    if (q === now || (route.name !== 'search' && !q)) return
    const t = setTimeout(() => go({ name: 'search', q: (typed.current = q) }), 300)
    return () => clearTimeout(t)
  }, [q, route, go])
  return (
    <header className="topbar">
      <div className="nav-arrows">
        <button className="circle-btn" disabled={!p.canBack} onClick={p.onBack} aria-label="Go back" title="Go back" data-shortcut="back">
          <I.ChevronLeft />
        </button>
        <button className="circle-btn" disabled={!p.canFwd} onClick={p.onFwd} aria-label="Go forward" title="Go forward" data-shortcut="forward">
          <I.ChevronRight />
        </button>
      </div>
      <div className="center">
        <button className="home-btn" onClick={() => go({ name: 'home' })} aria-label="Home" title="Home" data-shortcut="home">
          {route.name === 'home' ? <I.Home size={24} /> : <I.HomeOutline size={24} />}
        </button>
        <label className="search-box">
          <I.Search size={24} />
          <input
            ref={p.searchRef}
            placeholder="What do you want to play?"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go({ name: 'search', q: (typed.current = q) })}
          />
          {q && (
            <button
              className="search-clear"
              aria-label="Clear search field"
              title="Clear search field"
              onClick={() => {
                setQ('')
                p.searchRef.current?.focus()
              }}
            >
              <I.Close size={16} />
            </button>
          )}
          <span className="search-divider" />
          <button
            className={`search-browse ${route.name === 'search' && !route.q ? 'on' : ''}`}
            aria-label="Browse"
            title="Browse"
            onClick={(e) => {
              e.preventDefault()
              setQ('')
              go({ name: 'search', q: (typed.current = '') })
            }}
          >
            {route.name === 'search' && !route.q ? <I.BrowseFill size={20} /> : <I.Browse size={20} />}
          </button>
        </label>
      </div>
      {p.authed ? (
        <button className="avatar" onClick={accountMenu} title={me?.name} aria-label="Account">
          {me?.photo && <img src={me.photo} />}
        </button>
      ) : (
        <button className="login-btn" onClick={() => window.ytm.login()}>
          Log in
        </button>
      )}
    </header>
  )
}

function LibraryPanel({ authed, collapsed, onToggle }: { authed: boolean; collapsed: boolean; onToggle: () => void }) {
  const ctx = useApp()
  const { go, route, player, toast, source, playCard } = ctx
  // No chip picked shows everything, as in Spotify; clicking the picked chip clears it.
  const [filter, setFilter] = useState<LibraryFilter | null>(null)
  const [sort, setSortState] = useState<LibrarySort>(() => (localStorage.getItem('library-sort') as LibrarySort) || 'Recents')
  const setSort = (s: LibrarySort) => (localStorage.setItem('library-sort', s), setSortState(s))
  const [pins, setPinsState] = useState<string[]>(() => JSON.parse(localStorage.getItem('library-pins') ?? '[]'))
  const togglePin = (c: Card) =>
    setPinsState((p) => {
      const key = c.kind + c.id
      const next = p.includes(key) ? p.filter((x) => x !== key) : [...p, key]
      localStorage.setItem('library-pins', JSON.stringify(next))
      toast(p.includes(key) ? `Unpinned ${c.title}` : `Pinned ${c.title}`)
      return next
    })
  const [view, setViewState] = useState<LibraryView>(() => (localStorage.getItem('library-view') as LibraryView) || 'List')
  const setView = (v: LibraryView) => (localStorage.setItem('library-view', v), setViewState(v))
  const [find, setFind] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => onLibraryChange(() => setVersion((v) => v + 1)), [])
  // While a reload (after creating a playlist) is on its way, keep showing the previous list.
  const last = useRef<Record<string, Card[]>>({})
  const load = (f: LibraryFilter) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const { data } = useCached<Card[]>(`library:${authed}:${f}:${version}`, () => (authed ? window.ytm.library(f) : Promise.resolve([])), {
      persist: version === 0
    })
    if (data) last.current[f] = data
    return data ?? (authed ? (last.current[f] ?? []) : [])
  }
  const lists = { Playlists: load('Playlists'), Artists: load('Artists'), Albums: load('Albums') }
  // Playlists made here show at the top right away; YTM's library can take a moment to list them.
  const [made, setMade] = useState<Card[]>([])
  const create = async () => {
    if (!authed) return window.ytm.login()
    const pick = await window.ytm.popup([{ id: 'playlist', label: 'Playlist' }])
    if (pick !== 'playlist') return
    // "My Playlist #N", numbered after the highest one so far, as in Spotify.
    const n = Math.max(0, ...[...made, ...lists.Playlists].map((c) => Number(c.title.match(/^My Playlist #(\d+)$/)?.[1] ?? 0))) + 1
    const title = `My Playlist #${n}`
    try {
      const id = await window.ytm.createPlaylist(title)
      setMade((m) => [{ kind: 'playlist', id, title, subtitle: 'Playlist • You', thumb: '' }, ...m])
      libraryChanged()
      go({ name: 'playlist', id })
    } catch {
      toast('Couldn’t create the playlist')
    }
  }
  const listed = new Set(lists.Playlists.map((c) => c.id))
  const playlists = [LIKED, ...made.filter((c) => !listed.has(c.id)), ...lists.Playlists.filter((c) => c.id !== 'VLLM')]
  let list = filter === 'Artists' ? lists.Artists : filter === 'Albums' ? lists.Albums : filter ? playlists : [...playlists, ...lists.Albums, ...lists.Artists]
  if (find) list = list.filter((c) => `${c.title} ${c.subtitle}`.toLowerCase().includes(find.toLowerCase()))
  // "Recents" keeps YouTube Music's own order (most recent first); Liked Songs stays pinned on top.
  if (sort !== 'Recents') {
    // The creator is the subtitle part that isn't the kind, a year or a count ("Playlist • Owner • 12 songs").
    const creator = (c: Card) =>
      c.subtitle
        .split(' • ')
        .find((p) => !/^(Playlist|Album|Single|EP|Artist|Auto playlist)$/i.test(p) && !/^\d{4}$/.test(p) && !/\d[\d.,]*\s*[KMB]?\s*(songs?|tracks?|episodes?|subscribers?|views?)/i.test(p)) ?? ''
    const key = (c: Card) => (sort === 'Creator' ? creator(c) || c.title : c.title).toLowerCase()
    list = [...list.filter((c) => c.id === 'LM'), ...list.filter((c) => c.id !== 'LM').sort((a, b) => key(a).localeCompare(key(b)))]
  }
  // Pinned items follow Liked Songs, in the order they were pinned (Spotify's pins).
  const isPinned = (c: Card) => c.id === 'LM' || pins.includes(c.kind + c.id)
  const pinRank = (c: Card) => (c.id === 'LM' ? -1 : pins.indexOf(c.kind + c.id))
  list = [...list.filter(isPinned).sort((a, b) => pinRank(a) - pinRank(b)), ...list.filter((c) => !isPinned(c))]
  const sortMenu = async () => {
    const pick = await window.ytm.popup([
      { id: 'head', label: 'Sort by', enabled: false },
      ...(['Recents', 'Alphabetical', 'Creator'] as LibrarySort[]).map((s) => ({ id: s, label: s, checked: s === sort })),
      { id: '-', label: '-' },
      { id: 'head', label: 'View as', enabled: false },
      ...(['Compact', 'List', 'Grid'] as LibraryView[]).map((v) => ({ id: `view:${v}`, label: v, checked: v === view }))
    ])
    if (pick?.startsWith('view:')) setView(pick.slice(5) as LibraryView)
    else if (pick && pick !== 'head') setSort(pick as LibrarySort)
  }
  const ViewIcon = VIEW_ICON[view]
  const shownView: LibraryView = collapsed ? 'List' : view
  return (
    <nav className="library panel">
      <div className="lib-head">
        <button className="lib-title" onClick={onToggle} title={collapsed ? 'Open Your Library' : 'Collapse Your Library'} data-shortcut="toggleLeft">
          <I.Library size={24} />
          {!collapsed && <span>Your Library</span>}
        </button>
        {collapsed ? (
          <button className="create-btn icon" onClick={create} aria-label="Create" title="Create">
            <I.Plus />
          </button>
        ) : (
          <button className="create-btn" onClick={create}>
            <I.Plus /> Create
          </button>
        )}
      </div>
      {!authed && !collapsed && (
        <div className="lib-cta">
          <b>Log in to see your library</b>
          <span className="sub">Your playlists, albums and artists from YouTube Music.</span>
          <button className="pill-btn" onClick={() => window.ytm.login()}>
            Log in
          </button>
        </div>
      )}
      {authed && !collapsed && (
        <div className="chips">
          {filter && (
            <button className="chip chip-clear" onClick={() => setFilter(null)} aria-label="Clear filters" title="Clear filters">
              <I.Close size={12} />
            </button>
          )}
          {(['Playlists', 'Artists', 'Albums'] as LibraryFilter[])
            .filter((f) => !filter || f === filter)
            .map((f) => (
              <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(filter === f ? null : f)}>
                {f}
              </button>
            ))}
        </div>
      )}
      {authed && !collapsed && (
        <div className="lib-tools">
          {find === null ? (
            <button className="icon-btn" onClick={() => setFind('')} aria-label="Search in Your Library" title="Search in Your Library">
              <I.Search />
            </button>
          ) : (
            <label className="lib-find">
              <I.Search size={14} />
              <input
                autoFocus
                placeholder="Search in Your Library"
                value={find}
                onChange={(e) => setFind(e.target.value)}
                onBlur={() => !find && setFind(null)}
                onKeyDown={(e) => e.key === 'Escape' && setFind(null)}
              />
            </label>
          )}
          <button className="lib-sort" onClick={sortMenu} title="Sort and view">
            {sort} <ViewIcon size={16} />
          </button>
        </div>
      )}
      <div className={`lib-list ${shownView.toLowerCase()}`}>
        {authed && find && !list.length && (
          <div className="lib-empty">
            <b>Couldn’t find “{find}”</b>
            <span className="sub">Try searching again using a different spelling or keyword.</span>
          </div>
        )}
        {authed && list.map((c) => {
          const r = routeFor(c)
          const active = r && JSON.stringify(r) === JSON.stringify(route)
          const playing = !!player?.playing && (sameRoute(r, source?.route) || (c.kind === 'album' && c.title === player.album))
          const current = !!player?.videoId && sameRoute(r, source?.route)
          // Play from the sidebar without opening the page (pause if it's what's playing).
          const play = (e: React.MouseEvent) => (e.stopPropagation(), current ? window.ytm.cmd({ type: 'toggle' }) : playCard(c))
          const grid = shownView === 'Grid'
          return (
            <div
              key={c.kind + c.id}
              className={`lib-item ${active ? 'active' : ''}`}
              onClick={() => r && go(r)}
              onContextMenu={(e) => (e.preventDefault(), c.id !== 'LM' && cardMenu(c, ctx, { pinned: isPinned(c), onPin: () => togglePin(c) }))}
              title={collapsed ? c.title : undefined}
            >
              {shownView !== 'Compact' && (
                <span className={`lib-art ${c.kind === 'artist' ? 'round' : ''}`}>
                  {c.id === 'LM' ? (
                    <span className="liked-art">
                      <I.HeartFill size={grid ? 40 : collapsed ? 20 : 16} />
                    </span>
                  ) : (
                    <Img src={sized(c.thumb, grid ? 160 : 48)} artist={c.kind === 'artist'} />
                  )}
                  {!collapsed && r && (
                    <button className={`lib-play ${playing ? 'on' : ''}`} onClick={play} aria-label={playing ? `Pause ${c.title}` : `Play ${c.title}`} title={playing ? 'Pause' : 'Play'}>
                      {playing ? <I.Pause size={grid ? 18 : 16} /> : <I.Play size={grid ? 18 : 16} />}
                    </button>
                  )}
                </span>
              )}
              {!collapsed && (
                <div className="lib-text">
                  <span className={`t1 ${playing ? 'green' : ''}`}>{c.title}</span>
                  <span className="t2">
                    {isPinned(c) && <I.Pin size={12} className="green pin" aria-label="Pinned" />}
                    <span className="ellipsis">{c.subtitle}</span>
                  </span>
                </div>
              )}
              {playing && !collapsed && !grid && <I.Volume size={16} className="green lib-playing" aria-label="Playing" />}
            </div>
          )
        })}
      </div>
    </nav>
  )
}

// One song in the queue panel (or the "Next in queue" card); a click jumps to it.
function QueueRow({ q, onPlay, menu, dnd, playing }: {
  q: QueueItem
  onPlay?: () => void
  menu: () => void
  dnd?: ReturnType<ReturnType<typeof useQueueDrag>>
  playing?: boolean
}) {
  return (
    <div
      {...dnd}
      className={`np-next ${playing ? 'current' : ''} ${dnd?.className ?? ''}`}
      onClick={onPlay}
      onContextMenu={(e) => (e.preventDefault(), menu())}
    >
      <Img src={q.thumb || `https://i.ytimg.com/vi/${q.videoId}/mqdefault.jpg`} />
      <div className="np-next-text">
        <div className={`t1 ${playing ? 'green' : ''}`}>{q.title}</div>
        <div className="t2">
          {q.rec && (
            <span className="rec-mark" title="Smart Shuffle recommendation">
              <I.Sparkle size={12} />
            </span>
          )}
          {q.artist}
        </div>
      </div>
      <button className="row-more" onClick={(e) => (e.stopPropagation(), menu())} aria-label={`More options for ${q.title}`} title={`More options for ${q.title}`}>
        <I.More />
      </button>
    </div>
  )
}

// Drag-and-drop reordering of either list; indexes are positions in YTM's lists and drops only
// land within the list they started in.
function useQueueDrag() {
  const [drag, setDrag] = useState<{ list: 'queue' | 'auto'; from: number; over: number } | null>(null)
  return (list: 'queue' | 'auto', i: number) => ({
    draggable: true,
    className:
      drag?.list === list && drag.over === i && drag.from !== i
        ? drag.from < i ? 'drop-below' : 'drop-above'
        : drag?.list === list && drag.from === i ? 'dragging' : '',
    onDragStart: (e: React.DragEvent) => ((e.dataTransfer.effectAllowed = 'move'), setDrag({ list, from: i, over: i })),
    onDragOver: (e: React.DragEvent) => {
      if (drag?.list !== list) return
      e.preventDefault()
      if (drag.over !== i) setDrag({ ...drag, over: i })
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      if (drag?.list === list && drag.from !== i)
        window.ytm.cmd({ type: list === 'queue' ? 'queueMove' : 'autoplayMove', from: drag.from, to: i })
      setDrag(null)
    },
    onDragEnd: () => setDrag(null)
  })
}

// Songs after the current one: their positions in YTM's queue, skipping its hidden placeholders.
function upcomingOf(player: PlayerState) {
  const idx = player.queue.findIndex((q) => q.selected)
  return player.queue.map((q, i) => ({ q, i })).slice(idx + 1).filter(({ q }) => q.videoId)
}

function NowPlayingPanel({ onClose, onPlus, onQueue, onFullLyrics, covered }: { onClose: () => void; onPlus: (from: HTMLElement) => void; onQueue: () => void; onFullLyrics: () => void; covered: boolean }) {
  const ctx = useApp()
  const { player, go, prefs, setPrefs } = ctx
  if (!player) return null
  const next = upcomingOf(player)[0] ?? (player.autoplay[0] && { q: player.autoplay[0], i: -1 })
  const current = { videoId: player.videoId, title: player.title, artistId: player.artistId, albumId: player.albumId }
  const switchVideo = () => {
    setPrefs({ videoMode: !prefs.videoMode })
    ctx.toast(prefs.videoMode ? 'We’ll only play audio from now on.' : 'We’ll play video when available, from now on.')
  }
  return (
    <aside className="now-playing panel">
      <div className="np-head">
        {/* Spotify titles the panel with where playback started (a playlist, album or artist). */}
        <span
          className={`np-head-title ${ctx.source ? 'link' : ''}`}
          onClick={() => ctx.source && go(ctx.source.route)}
        >
          {ctx.source?.title || player.album || 'Now playing'}
        </span>
        <button className="icon-btn" onClick={() => songMenu(current, ctx, { liked: player.liked })} aria-label="More options" title="More options">
          <I.More />
        </button>
        <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
          <I.Close />
        </button>
      </div>
      <div className="np-scroll">
        {prefs.videoMode && player.isVideo && !covered ? (
          <VideoSlot poster={player.thumb} />
        ) : (
          <Img className="np-art" src={player.thumb} />
        )}
        <div className="np-title-row">
          <div className="np-titles">
            <div
              className={`np-title ${player.albumId ? 'link' : ''}`}
              onClick={() => player.albumId && go({ name: 'album', id: player.albumId })}
            >
              {player.title}
            </div>
            <div
              className={`sub ${player.artistId ? 'link' : ''}`}
              onClick={() => player.artistId && go({ name: 'artist', id: player.artistId })}
            >
              {player.artist}
            </div>
          </div>
          <PlusButton liked={player.liked} onPlus={onPlus} size={24} />
        </div>
        <div className="np-video">
          <button className="outline-btn small" onClick={switchVideo}>
            {prefs.videoMode ? 'Switch to audio' : 'Switch to video'}
          </button>
        </div>
        <LyricsCard player={player} onOpen={() => go({ name: 'lyrics' })} onFull={onFullLyrics} />
        {player.artistId && <AboutArtist id={player.artistId} />}
        <div className="np-card">
          <div className="np-card-head">
            <b>Next in queue</b>
            <button className="show-all" onClick={onQueue}>
              Open queue
            </button>
          </div>
          {next ? (
            <QueueRow
              q={next.q}
              onPlay={() => window.ytm.cmd(next.i < 0 ? { type: 'jumpAuto', index: 0 } : { type: 'jump', index: next.i })}
              menu={() => songMenu(next.q, ctx, next.i < 0 ? {} : { queueIndex: next.i })}
            />
          ) : (
            <p className="sub">Nothing up next.</p>
          )}
        </div>
      </div>
    </aside>
  )
}

// Spotify's "About the artist" card: photo, name and the start of their bio; opens the artist.
function AboutArtist({ id }: { id: string }) {
  const { go } = useApp()
  const { data } = useCached<ArtistPage>(`artist:${id}`, () => window.ytm.artist(id), { revalidate: false })
  if (!data?.thumb) return null
  return (
    <div className="np-card np-about" onClick={() => go({ name: 'artist', id })}>
      <div className="np-about-art" style={{ backgroundImage: `url(${data.thumb})` }}>
        <b>About the artist</b>
      </div>
      <div className="np-about-text">
        <b className="link">{data.title}</b>
        {data.description && <p className="sub">{data.description}</p>}
      </div>
    </div>
  )
}

// The Queue: what's playing, what's queued, then YTM's autoplay ("Next from").
function QueuePanel({ onClose }: { onClose: () => void }) {
  const ctx = useApp()
  const { player } = ctx
  const dnd = useQueueDrag()
  const upcoming = player ? upcomingOf(player) : []
  return (
    <aside className="now-playing panel queue-panel">
      <div className="np-head">
        <span className="np-head-title">Queue</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
          <I.Close />
        </button>
      </div>
      <div className="np-scroll">
        {!player?.videoId ? (
          <div className="queue-empty">
            <b>Your queue is empty</b>
            <p className="sub">Play something and it’ll show up here.</p>
          </div>
        ) : (
          <>
            <h3 className="queue-h">Now playing</h3>
            <QueueRow
              q={{ videoId: player.videoId, title: player.title, artist: player.artist, artistId: player.artistId, albumId: player.albumId, duration: '', thumb: player.thumb, selected: true }}
              playing
              menu={() => songMenu({ videoId: player.videoId, title: player.title, artistId: player.artistId, albumId: player.albumId }, ctx, { liked: player.liked })}
            />
            {upcoming.length > 0 && <h3 className="queue-h">Next in queue</h3>}
            {upcoming.map(({ q, i }) => (
              <QueueRow
                key={q.videoId + i}
                q={q}
                dnd={dnd('queue', i)}
                onPlay={() => window.ytm.cmd({ type: 'jump', index: i })}
                menu={() => songMenu(q, ctx, { queueIndex: i })}
              />
            ))}
            {player.autoplay.length > 0 && <h3 className="queue-h">Next from: Autoplay</h3>}
            {player.autoplay.map((q, i) => (
              <QueueRow
                key={'auto' + q.videoId + i}
                q={q}
                dnd={dnd('auto', i)}
                onPlay={() => window.ytm.cmd({ type: 'jumpAuto', index: i })}
                menu={() => songMenu(q, ctx)}
              />
            ))}
          </>
        )}
      </div>
    </aside>
  )
}

// Where the YTM player page (the actual video) is drawn, over the artwork. Reports its position to
// main; if it's scrolled partly out of the panel the video is put away and the artwork shows.
// `full`: the full-screen player's video, filling the window beneath this page (which turns
// see-through there). A black curtain covers it until main says it's in place, then fades away.
function VideoSlot({ poster, full }: { poster: string; full?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const el = ref.current!
    const scroller = el.closest('.np-scroll, .fs')!
    let last = ''
    let live = true
    const report = () => {
      const r = el.getBoundingClientRect()
      const box = scroller.getBoundingClientRect()
      const visible = r.top >= box.top && r.bottom <= box.bottom && r.width > 0
      const rect = visible ? { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), full } : null
      const key = JSON.stringify(rect)
      if (key === last) return
      last = key
      if (!rect) setShown(false)
      window.ytm.videoRect(rect).then(() => live && rect && key === last && setShown(true))
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    ro.observe(document.body)
    scroller.addEventListener('scroll', report, { passive: true })
    return () => {
      live = false
      ro.disconnect()
      scroller.removeEventListener('scroll', report)
      window.ytm.videoRect(null)
    }
  }, [full])
  if (full) return <div ref={ref} className={`fs-video ${shown ? 'shown' : ''}`} />
  return (
    <div ref={ref} className="np-art np-video-slot">
      {!shown && <img src={poster} />}
    </div>
  )
}

// Spotify's ambient mode (cinema mode) and YouTube's full screen: after a few seconds without the
// mouse moving, the controls and the pointer fade away until it moves again. Not while the pointer
// rests on the controls.
function useIdle(enabled: boolean, ms = 3000): boolean {
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    setIdle(false)
    if (!enabled) return
    let t: ReturnType<typeof setTimeout>
    const wake = (e?: Event) => {
      clearTimeout(t)
      setIdle(false)
      if (!(e?.target instanceof Element && e.target.closest('.fs-top, .fs-bottom'))) t = setTimeout(() => setIdle(true), ms)
    }
    wake()
    const events = ['pointermove', 'pointerdown', 'keydown', 'wheel']
    events.forEach((n) => window.addEventListener(n, wake, true))
    return () => {
      clearTimeout(t)
      events.forEach((n) => window.removeEventListener(n, wake, true))
    }
  }, [enabled, ms])
  return idle
}

// Spotify's progress/volume bar: hover shows the fill up to the pointer (and, for the progress bar,
// a time tooltip), dragging previews the value, ←/→ step it from the keyboard.
function Slider({
  value,
  max,
  onChange,
  onInput,
  onPreview,
  tip,
  step,
  label,
  className = ''
}: {
  value: number
  max: number
  onChange: (v: number) => void
  onInput?: (v: number) => void // live while dragging (volume)
  onPreview?: (v: number | null) => void // the value being dragged to, or null when done
  tip?: (v: number) => string
  step: number
  label: string
  className?: string
}) {
  const [drag, setDrag] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const at = (x: number) => {
    const r = ref.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, (x - r.left) / r.width)) * max
  }
  const move = (v: number) => (setDrag(v), onPreview?.(v), onInput?.(v))
  const done = () => (setDrag(null), onPreview?.(null))
  const shown = drag ?? value
  const pct = max ? (shown / max) * 100 : 0
  const hoverPct = max && hover !== null ? (hover / max) * 100 : 0
  return (
    <div
      ref={ref}
      className={`slider ${drag !== null ? 'dragging' : ''} ${className}`}
      role="slider"
      tabIndex={max ? 0 : -1}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={tip?.(shown)}
      onPointerDown={(e) => {
        if (!max) return
        e.currentTarget.setPointerCapture(e.pointerId)
        move(at(e.clientX))
      }}
      onPointerMove={(e) => {
        if (!max) return
        setHover(at(e.clientX))
        if (drag !== null) move(at(e.clientX))
      }}
      onPointerLeave={() => setHover(null)}
      onPointerUp={(e) => {
        if (drag === null) return
        onChange(at(e.clientX))
        done()
      }}
      onPointerCancel={done}
      onKeyDown={(e) => {
        if (!max || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
        e.preventDefault()
        e.stopPropagation()
        onChange(Math.min(max, Math.max(0, value + (e.key === 'ArrowRight' ? step : -step))))
      }}
    >
      <div className="track">
        {hover !== null && drag === null && <div className="hover-fill" style={{ width: `${hoverPct}%` }} />}
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="knob" style={{ left: `${pct}%` }} />
      {tip && (drag ?? hover) !== null && (
        <div className="slider-tip" style={{ left: `${max ? ((drag ?? hover)! / max) * 100 : 0}%` }}>
          {tip((drag ?? hover)!)}
        </div>
      )}
    </div>
  )
}

// Puts a freshly mounted page back where it was scrolled; the content may still be loading, so
// keep trying for a moment while it grows (and stop if the user scrolls first).
function restoreScroll(el: HTMLDivElement | null, top: number | undefined): void {
  if (!el || !top || el.dataset.restored) return
  el.dataset.restored = '1'
  const started = performance.now()
  let ours = 0 // where our last attempt left it; anything else means the user scrolled
  const tryIt = () => {
    if (Math.abs(el.scrollTop - ours) > 1) return
    el.scrollTop = top
    ours = el.scrollTop
    if (ours < top - 1 && performance.now() - started < 3000) requestAnimationFrame(tryIt)
  }
  tryIt()
}

// Spotify-style tooltips for everything with a `title`: the title moves to `data-tip` (so the
// native one doesn't also show) and a dark label appears after a short delay.
function Tooltips({ keys }: { keys: Record<Action, string[]> }) {
  // `at` is the element's box; where the tip goes is worked out once its own size is known.
  const [tip, setTip] = useState<{ text: string; key?: string; at: DOMRect; side: 'above' | 'below' | 'right' } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  // Keep the whole tip inside the window: centred on the element when there's room, otherwise
  // pushed in from the edge.
  useLayoutEffect(() => {
    const el = box.current
    if (!el || !tip) return
    const { at, side } = tip
    const w = el.offsetWidth, h = el.offsetHeight, m = 8
    let left = side === 'right' ? at.right + m : at.left + at.width / 2 - w / 2
    let top = side === 'right' ? at.top + at.height / 2 - h / 2 : side === 'below' ? at.bottom + m : at.top - h - m
    left = Math.min(Math.max(m, left), window.innerWidth - w - m)
    top = Math.min(Math.max(m, top), window.innerHeight - h - m)
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    el.style.visibility = 'visible'
  }, [tip])
  const keysRef = useRef(keys)
  keysRef.current = keys
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    let target: HTMLElement | null = null
    const over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement)?.closest?.('[title], [data-tip]') as HTMLElement | null
      if (el === target) return
      target = el
      clearTimeout(timer)
      setTip(null)
      if (!el) return
      if (el.title) {
        el.dataset.tip = el.title
        el.removeAttribute('title')
      }
      timer = setTimeout(() => {
        if (!el.isConnected || !el.dataset.tip) return
        const r = el.getBoundingClientRect()
        // In the collapsed library rail tips open to the side, as Spotify's do.
        const side = el.closest('.left-collapsed .library') ? 'right' : r.top < 48 ? 'below' : 'above'
        // Controls with a keyboard shortcut show it beside the label (from the user's bindings).
        const combo = keysRef.current[el.dataset.shortcut as Action]?.[0]
        setTip({ text: el.dataset.tip, key: combo && comboLabel(combo), at: r, side })
      }, 500)
    }
    const hide = () => (clearTimeout(timer), setTip(null), (target = null))
    document.addEventListener('mouseover', over)
    document.addEventListener('mousedown', hide)
    window.addEventListener('blur', hide)
    document.addEventListener('scroll', hide, true)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mouseover', over)
      document.removeEventListener('mousedown', hide)
      window.removeEventListener('blur', hide)
      document.removeEventListener('scroll', hide, true)
    }
  }, [])
  if (!tip) return null
  return (
    <div ref={box} className="tooltip" style={{ visibility: 'hidden' }} role="tooltip">
      {tip.text}
      {tip.key && <span className="tip-key">{tip.key}</span>}
    </div>
  )
}

// The + / green tick next to the playing song (player bar, Now Playing, full screen).
function PlusButton({ liked, onPlus, size = 16 }: { liked: boolean; onPlus: (from: HTMLElement) => void; size?: number }) {
  return (
    <button
      className={`icon-btn plus-btn ${liked ? 'green' : ''}`}
      style={{ width: size + 16, height: size + 16 }}
      onClick={(e) => onPlus(e.currentTarget)}
      aria-label={liked ? 'Add to playlist' : 'Add to Liked Songs'}
      title={liked ? 'Add to playlist' : 'Add to Liked Songs'}
    >
      {liked ? <I.CheckCircle size={size} /> : <I.PlusCircle size={size} />}
    </button>
  )
}

const REPEAT_LABEL = { NONE: 'Enable repeat', ALL: 'Enable repeat one', ONE: 'Disable repeat' } as const
const NEXT_SHUFFLE = { off: 'on', on: 'smart', smart: 'off' } as const
// What the button does next, as Spotify labels it.
const SHUFFLE_LABEL = { off: 'Enable shuffle', on: 'Enable Smart Shuffle', smart: 'Disable shuffle' } as const
const SHUFFLE_TOAST = { off: 'Shuffle off', on: 'Shuffle on', smart: 'Added Smart Shuffle recommendations to your queue' } as const

// Shuffle / previous / play / next / repeat, shared by the player bar and the full-screen view.
function Controls({ onShuffle, big }: { onShuffle: (mode?: ShuffleMode) => void; big?: boolean }) {
  const { player: p } = useApp()
  const cmd = window.ytm.cmd
  // Nothing loaded yet: the controls show but can't be used, as in Spotify.
  const off = !p?.videoId
  const mode = p?.shuffle ?? 'off'
  // Right-click picks a mode, like the menu on Spotify's shuffle button.
  const shuffleMenu = async (e: React.MouseEvent) => {
    e.preventDefault()
    const pick = await window.ytm.popup([
      { id: 'off', label: 'Play in order', checked: mode === 'off' },
      { id: 'on', label: 'Shuffle', checked: mode === 'on' },
      { id: 'smart', label: 'Smart Shuffle', checked: mode === 'smart' }
    ])
    if (pick) onShuffle(pick as ShuffleMode)
  }
  return (
    <div className={`pb-controls ${big ? 'big' : ''}`}>
      <button
        className={`icon-btn ${mode !== 'off' ? 'green dot' : ''}`}
        disabled={off}
        onClick={() => onShuffle()}
        onContextMenu={shuffleMenu}
        aria-label={SHUFFLE_LABEL[mode]}
        title={SHUFFLE_LABEL[mode]}
        data-shortcut="shuffle"
      >
        {mode === 'smart' ? <I.ShuffleSmart size={big ? 24 : 16} /> : <I.Shuffle size={big ? 24 : 16} />}
      </button>
      <button className="icon-btn" disabled={off} onClick={() => cmd({ type: 'prev' })} aria-label="Previous" title="Previous" data-shortcut="prev">
        <I.Prev size={big ? 24 : 16} />
      </button>
      <button className="play-btn" disabled={off} onClick={() => cmd({ type: 'toggle' })} aria-label={p?.playing ? 'Pause' : 'Play'} title={p?.playing ? 'Pause' : 'Play'} data-shortcut="toggle">
        {p?.playing ? <I.Pause size={big ? 24 : 16} /> : <I.Play size={big ? 24 : 16} />}
      </button>
      <button className="icon-btn" disabled={off} onClick={() => cmd({ type: 'next' })} aria-label="Next" title="Next" data-shortcut="next">
        <I.Next size={big ? 24 : 16} />
      </button>
      <button
        disabled={off}
        className={`icon-btn repeat ${p && p.repeat !== 'NONE' ? 'green dot' : ''}`}
        onClick={() => cmd({ type: 'repeat' })}
        aria-label={REPEAT_LABEL[p?.repeat ?? 'NONE']}
        title={REPEAT_LABEL[p?.repeat ?? 'NONE']}
        data-shortcut="repeat"
      >
        <I.Repeat size={big ? 24 : 16} />
        {p?.repeat === 'ONE' && <span className="one">1</span>}
      </button>
    </div>
  )
}

function Progress() {
  const { player: p } = useApp()
  const time = useTime()
  // While dragging, the elapsed time shows where the song would jump to.
  const [preview, setPreview] = useState<number | null>(null)
  return (
    <div className="pb-progress">
      <span className="time">{fmt(preview ?? time)}</span>
      <Slider
        value={time}
        max={p?.duration ?? 0}
        step={5}
        label="Change progress"
        tip={fmt}
        onPreview={setPreview}
        onChange={(s) => (setClock(s), window.ytm.cmd({ type: 'seek', seconds: s }))}
      />
      <span className="time">{fmt(p?.duration ?? 0)}</span>
    </div>
  )
}

function VolumeControl() {
  const { player: p } = useApp()
  const level = p?.muted ? 0 : (p?.volume ?? 0)
  // The volume follows the drag (throttled), as in Spotify, rather than jumping on release.
  const last = useRef(0)
  const live = (v: number) => {
    if (performance.now() - last.current < 80) return
    last.current = performance.now()
    window.ytm.cmd({ type: 'volume', value: v })
  }
  return (
    <div className="vol">
      <button
        className="icon-btn"
        onClick={() => window.ytm.cmd({ type: 'mute' })}
        aria-label={level === 0 ? 'Unmute' : 'Mute'}
        title={level === 0 ? 'Unmute' : 'Mute'}
        data-shortcut="mute"
      >
        {level === 0 ? <I.VolumeMute /> : level < 50 ? <I.VolumeLow /> : <I.Volume />}
      </button>
      <Slider
        className="volume"
        value={level}
        max={100}
        step={10}
        label="Change volume"
        onInput={live}
        onChange={(v) => window.ytm.cmd({ type: 'volume', value: v })}
      />
    </div>
  )
}

// Drag handle in the gap beside a sidebar (Spotify's LayoutResizer): invisible until hovered.
function Resizer({ side, width, onResize, label }: { side: 'left' | 'right'; width: () => number; onResize: (w: number) => void; label: string }) {
  const [drag, setDrag] = useState<{ x: number; w: number } | null>(null)
  return (
    <div
      className={`resizer ${side} ${drag ? 'resizing' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag({ x: e.clientX, w: width() })
      }}
      onPointerMove={(e) => drag && onResize(drag.w + (side === 'left' ? 1 : -1) * (e.clientX - drag.x))}
      onPointerUp={() => setDrag(null)}
      onLostPointerCapture={() => setDrag(null)}
    />
  )
}

// Spotify's full-screen player: blurred artwork behind, big cover and title bottom-left, controls
// along the bottom. Puts the window itself into full screen while open. In video mode the music
// video fills the screen instead, letterboxed as in YouTube's full screen; with lyrics on, the
// lyrics fill it, as in Spotify's full-screen lyrics. Over either, the title and controls float
// and fade out while the mouse is still.
function FullScreenView({ lyrics, onLyrics, onClose, onPlus, onShuffle }: { lyrics: boolean; onLyrics: () => void; onClose: () => void; onPlus: (from: HTMLElement) => void; onShuffle: (mode?: ShuffleMode) => void }) {
  const { player: p, prefs, setPrefs, source } = useApp()
  const tint = useColor(p?.thumb)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    // Only undo full screen if this view turned it on (not if the window was already full screen).
    let entered = false
    let live = true
    let seenOn = false
    window.ytm.fullscreen(true).then((was) => {
      if (was) seenOn = true
      entered = live && !was
      if (!live && !was) window.ytm.fullscreen(false)
    })
    // Leaving full screen from the window's own controls closes this view too; a leave event still
    // on its way from an earlier view doesn't count until this one has seen the window go full screen.
    const off = window.ytm.onFullscreen((on) => (on ? (seenOn = true) : seenOn && close.current()))
    return () => {
      live = false
      off()
      if (entered) window.ytm.fullscreen(false)
    }
  }, [])
  const video = !!p && !lyrics && prefs.videoMode && p.isVideo
  const mode = lyrics ? 'lyrics' : video ? 'video' : 'art'
  const idle = useIdle(mode !== 'art')
  if (!p) return null
  // As on YouTube, clicking the video plays or pauses it and double-clicking leaves full screen.
  const onVideo = (e: React.MouseEvent, then: () => void) => video && !(e.target as Element).closest('.fs-top, .fs-bottom') && then()
  return (
    <div
      className={`fs mode-${mode} ${idle ? 'idle' : ''}`}
      style={{ '--tint': tint, '--lyrics-bg': lyricsBackground(tint) } as React.CSSProperties}
      onClick={(e) => onVideo(e, () => window.ytm.cmd({ type: 'toggle' }))}
      onDoubleClick={(e) => onVideo(e, onClose)}
    >
      {mode === 'art' && <div className="fs-bg" style={{ backgroundImage: `url(${p.thumb})` }} />}
      {video && <VideoSlot poster={p.thumb} full />}
      {lyrics && (
        <div className="fs-lyrics">
          <FullScreenLyrics player={p} />
        </div>
      )}
      <div className="fs-top">
        {mode === 'art' ? (
          <div className="fs-source">
            <span>Playing from</span>
            <b>{source?.title || p.album || 'YouTube Music'}</b>
          </div>
        ) : (
          <div className="fs-track">
            {lyrics && <Img className="fs-track-art" src={sized(p.thumb, 56)} />}
            <div className="fs-track-text">
              <b>{p.title}</b>
              <span>{p.artist}</span>
            </div>
          </div>
        )}
        <div className="fs-av" role="radiogroup" aria-label="Play as">
          <button role="radio" aria-checked={!prefs.videoMode} className={prefs.videoMode ? '' : 'on'} onClick={() => setPrefs({ videoMode: false })}>
            Audio
          </button>
          <button role="radio" aria-checked={prefs.videoMode} className={prefs.videoMode ? 'on' : ''} onClick={() => setPrefs({ videoMode: true })}>
            Video
          </button>
        </div>
      </div>
      {mode === 'art' && (
        <div className="fs-now">
          <Img className="fs-art" src={p.thumb} />
          <div className="fs-text">
            <div className="fs-title">{p.title}</div>
            <div className="fs-artist">{p.artist}</div>
          </div>
        </div>
      )}
      <div className="fs-bottom">
        <Progress />
        <div className="fs-row">
          <div className="fs-side">
            <PlusButton liked={p.liked} onPlus={onPlus} size={24} />
          </div>
          <Controls onShuffle={onShuffle} big />
          <div className="fs-side right">
            <button className={`icon-btn ${lyrics ? 'green dot' : ''}`} onClick={onLyrics} aria-label={lyrics ? 'Hide lyrics' : 'Lyrics'} title={lyrics ? 'Hide lyrics' : 'Lyrics'} data-shortcut="lyrics">
              <I.Lyrics size={20} />
            </button>
            <VolumeControl />
            <button className="icon-btn" onClick={onClose} aria-label="Exit full screen" title="Exit full screen">
              <I.ExitFullScreen size={24} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function PlayerBar(props: {
  rightOpen: boolean
  queueOpen: boolean
  onToggleRight: () => void
  onPlus: (from: HTMLElement) => void
  onShuffle: (mode?: ShuffleMode) => void
  onLyrics: () => void
  onFull: () => void
}) {
  const { rightOpen, onToggleRight } = props
  const ctx = useApp()
  const { player: p, openQueue, route, go } = ctx
  return (
    <footer className="player-bar">
      <div className="pb-left">
        {p?.videoId && (
          <>
            <Img src={sized(p.thumb, 56)} className="clickable" onClick={onToggleRight} title="Now playing view" />
            <div className="pb-text">
              <span
                className={`t1 ${p.albumId ? 'link' : ''}`}
                onClick={() => p.albumId && go({ name: 'album', id: p.albumId })}
              >
                {p.title}
              </span>
              <span
                className={`t2 ${p.artistId ? 'link' : ''}`}
                onClick={() => p.artistId && go({ name: 'artist', id: p.artistId })}
              >
                {p.artist}
              </span>
            </div>
            <PlusButton liked={p.liked} onPlus={props.onPlus} />
            <button
              className="icon-btn pb-more"
              onClick={() => songMenu({ videoId: p.videoId, title: p.title, artistId: p.artistId, albumId: p.albumId }, ctx, { liked: p.liked })}
              aria-label={`More options for ${p.title}`}
              title="More options"
            >
              <I.More />
            </button>
          </>
        )}
      </div>
      <div className="pb-center">
        <Controls onShuffle={props.onShuffle} />
        <Progress />
      </div>
      <div className="pb-right">
        <button className={`icon-btn ${rightOpen ? 'green dot' : ''}`} onClick={onToggleRight} aria-label="Now playing view" title="Now playing view" data-shortcut="toggleRight">
          <I.NowPlaying />
        </button>
        <button
          className={`icon-btn ${route.name === 'lyrics' ? 'green dot' : ''}`}
          onClick={props.onLyrics}
          aria-label="Lyrics"
          title="Lyrics"
          data-shortcut="lyrics"
        >
          <I.Lyrics />
        </button>
        <button className={`icon-btn ${props.queueOpen ? 'green dot' : ''}`} onClick={openQueue} title="Queue" aria-label="Queue" data-shortcut="queue">
          <I.Queue />
        </button>
        <VolumeControl />
        <button className="icon-btn" onClick={props.onFull} aria-label="Full screen" title="Full screen" disabled={!p?.videoId} data-shortcut="fullscreen">
          <I.FullScreen />
        </button>
      </div>
    </footer>
  )
}

function ShortcutsModal({ keys, onClose }: { keys: Record<Action, string[]>; onClose: () => void }) {
  const { go } = useApp()
  const sections = [...new Set(SHORTCUTS.map((s) => s.section))]
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h1>Keyboard shortcuts</h1>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <I.Close />
          </button>
        </div>
        <p className="sub">
          Press <kbd>Esc</kbd> to close.{' '}
          <button className="link-btn" onClick={() => (onClose(), go({ name: 'settings' }))}>
            Change shortcuts in Settings
          </button>
        </p>
        {sections.map((sec) => (
          <section key={sec}>
            <h2>{sec}</h2>
            {SHORTCUTS.filter((s) => s.section === sec && keys[s.action].length).map((s) => (
              <div key={s.action} className="sc-row">
                <span>{s.label}</span>
                <span>
                  {/* One key cap per key, like Spotify's sheet ("⌘" "→", "G" then "H"). */}
                  {keys[s.action].map((k) => (
                    <span key={k} className="combo">
                      {comboLabel(k)
                        .split(' then ')
                        .map((step, i) => (
                          <span key={i}>
                            {i > 0 && <span className="then">then</span>}
                            {step.split(' ').map((key, j) => (
                              <kbd key={j}>{key}</kbd>
                            ))}
                          </span>
                        ))}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}
