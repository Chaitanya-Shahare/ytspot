import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ArtistPage, Card, LibraryFilter, PlayerState, QueueItem, Track } from '../../shared/types'
import * as I from './components/icons'
import { cachedPlaylists, Ctx, fmt, getClock, invalidate, loadPrefs, onLibraryChange, resetCache, routeFor, savePrefs, setClock, sized, useApp, useCached, useColor, useTime, type AppCtx, type Prefs, type Route, type Source, sameRoute } from './lib'
import { bindings, comboLabel, comboOf, SHORTCUTS, type Action } from '../../shared/shortcuts'
import { cardMenu, songMenu } from './components/menus'
import { Boundary } from './components/ui'
import { SettingsView } from './views/settings'
import { LyricsView } from './views/lyrics'
import { MoodView, SearchView } from './views/search'
import { ArtistView, CollectionView, ExploreView, HomeView, MoreView } from './views/views'

const LIKED: Card = { kind: 'playlist', id: 'LM', title: 'Liked Songs', subtitle: 'Playlist', thumb: '' }
type LibrarySort = 'Recents' | 'Alphabetical' | 'Creator'

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
const OVERLAY_ACTIONS = new Set<Action>(['toggle', 'next', 'prev', 'seekFwd', 'seekBack', 'seekFwdSmall', 'seekBackSmall', 'shuffle', 'repeat', 'volUp', 'volDown', 'mute', 'like', 'dislike', 'fullscreen', 'help'])

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  // History and position change together, so they live in one state (no stale-position races).
  const [nav, setNav] = useState<{ history: Route[]; pos: number }>({ history: [{ name: 'home' }], pos: 0 })
  const { history, pos } = nav
  const back = useCallback(() => setNav((n) => ({ ...n, pos: Math.max(0, n.pos - 1) })), [])
  const forward = useCallback(() => setNav((n) => ({ ...n, pos: Math.min(n.history.length - 1, n.pos + 1) })), [])
  const [player, setPlayer] = useState<PlayerState | null>(null)
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const [left, setLeft] = useState(window.innerWidth > 1100)
  const [right, setRight] = useState(true)
  // The right sidebar shows either Now Playing or the Queue, as in Spotify.
  const [panel, setPanel] = useState<'np' | 'queue'>('np')
  const [help, setHelp] = useState(false)
  const [full, setFull] = useState(false)
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
    window.ytm.setPrefs({ keepPlaying: prefs.keepPlaying, videoMode: prefs.videoMode, openAtLogin: prefs.openAtLogin })
  }, [prefs.keepPlaying, prefs.videoMode, prefs.openAtLogin])
  const searchRef = useRef<HTMLInputElement>(null)
  const route = history[pos]

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

  const go = useCallback(
    (r: Route) =>
      setNav((n) => {
        // Typing in search replaces the current search entry instead of stacking one per keystroke.
        if (r.name === 'search' && n.history[n.pos].name === 'search')
          return { ...n, history: n.history.map((x, i) => (i === n.pos ? r : x)) }
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
      setEpoch((e) => e + 1)
    }
    lastAuth.current = authed
  }, [authed])

  const toast = useCallback((msg: string) => setToastMsg(msg), [])
  useEffect(() => {
    if (!toastMsg) return
    const t = setTimeout(() => setToastMsg(null), 2500)
    return () => clearTimeout(t)
  }, [toastMsg])

  const like = useCallback(() => {
    if (!player?.videoId) return
    window.ytm.cmd({ type: 'like' })
    invalidate('playlist:LM')
    toast(player?.liked ? 'Removed from Liked Songs' : 'Added to Liked Songs')
  }, [player?.videoId, player?.liked, toast])
  const closeFull = useCallback(() => setFull(false), [])
  // The song went away (e.g. the player page reloaded): leave full screen rather than leave it
  // armed for whatever plays next.
  useEffect(() => {
    if (!player?.videoId) setFull(false)
  }, [player?.videoId])

  const shuffle = useCallback(() => {
    window.ytm.cmd({ type: 'shuffle' })
    toast('Queue shuffled')
  }, [toast])

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
      setSource(null)
      window.ytm.cmd({ type: 'play', videoId: c.id })
    },
    [go]
  )

  const playCard = useCallback(
    async (c: Card) => {
      const r = routeFor(c)
      setSource(r && { route: r, title: c.title })
      try {
        if (c.kind === 'song' || c.kind === 'video') return void (await window.ytm.cmd({ type: 'play', videoId: c.id }))
        if (c.kind === 'artist') {
          const a = await window.ytm.artist(c.id)
          if (a.songs[0]) window.ytm.cmd({ type: 'play', videoId: a.songs[0].videoId })
          return
        }
        const col = c.kind === 'album' ? await window.ytm.album(c.id) : await window.ytm.playlist(c.id)
        if (col.tracks[0]) window.ytm.cmd({ type: 'play', videoId: col.tracks[0].videoId, playlistId: col.playlistId })
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
        case 'fullscreen': return setFull((v) => !v && !!player?.videoId)
        case 'lyrics': return toggleLyrics()
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
    [player, go, back, forward, like, shuffle, openQueue, showPanel, toast, toggleLyrics]
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
      const typing = !!el?.matches('input, textarea, select')
      if (e.key === 'Escape') {
        if (help) return setHelp(false)
        if (full) return setFull(false)
        if (typing) return el?.blur()
      }
      const combo = comboOf(e)
      if (!combo) return
      if (typing && (!e.metaKey || /Left|Right|Up|Down/.test(combo))) return
      const seq = pending ? `${pending} ${combo}` : combo
      clearTimeout(timer)
      pending = ''
      const a = byCombo.get(seq) ?? (seq !== combo ? byCombo.get(combo) : undefined)
      // Over the shortcuts sheet or the full-screen player, only playback keys (and the keys that
      // close them) act; navigating the page hidden behind would be invisible.
      if (a && (help || full) && !OVERLAY_ACTIONS.has(a)) return e.preventDefault()
      if (a) {
        e.preventDefault()
        return run(a)
      }
      if ([...byCombo.keys()].some((k) => k.startsWith(`${seq} `))) {
        e.preventDefault()
        pending = seq
        timer = setTimeout(() => (pending = ''), 1200)
      }
    }
    window.addEventListener('keydown', onKey)
    const offMenu = window.ytm.onMenu(run)
    return () => (window.removeEventListener('keydown', onKey), offMenu(), clearTimeout(timer))
  }, [run, keys, help, full])

  const ctx: AppCtx = useMemo(
    () => ({ route, go, player, playTrack, source, openCard, playCard, toast, prefs, setPrefs, openQueue }),
    [route, go, player, playTrack, source, openCard, playCard, toast, prefs, setPrefs, openQueue]
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
          <div className="main-scroll">
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
                <NowPlayingPanel onClose={() => setRight(false)} onLike={like} onQueue={openQueue} covered={help || full} />
              )}
            </Boundary>
          </>
        )}
        <PlayerBar
          rightOpen={rightShown && panel === 'np'}
          queueOpen={rightShown && panel === 'queue'}
          onToggleRight={() => showPanel('np')}
          onLike={like}
          onShuffle={shuffle}
          onLyrics={toggleLyrics}
          onFull={() => setFull(true)}
        />
      </div>
      {full && player?.videoId && (
        <Boundary resetKey={player.videoId}>
          <FullScreenView onClose={closeFull} onLike={like} onShuffle={shuffle} covered={help} />
        </Boundary>
      )}
      {help && <ShortcutsModal keys={keys} onClose={() => setHelp(false)} />}
      {toastMsg && <div className="toast">{toastMsg}</div>}
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
  useEffect(() => {
    if (route.name !== 'search') return
    const t = setTimeout(() => q !== route.q && go({ name: 'search', q: (typed.current = q) }), 300)
    return () => clearTimeout(t)
  }, [q, route, go])
  return (
    <header className="topbar">
      <div className="nav-arrows">
        <button className="circle-btn" disabled={!p.canBack} onClick={p.onBack} aria-label="Go back" title="Go back">
          <I.ChevronLeft />
        </button>
        <button className="circle-btn" disabled={!p.canFwd} onClick={p.onFwd} aria-label="Go forward" title="Go forward">
          <I.ChevronRight />
        </button>
      </div>
      <div className="center">
        <button className="home-btn" onClick={() => go({ name: 'home' })} aria-label="Home" title="Home">
          {route.name === 'home' ? <I.Home size={24} /> : <I.HomeOutline size={24} />}
        </button>
        <label className="search-box">
          <I.Search size={24} />
          <input
            ref={p.searchRef}
            placeholder="What do you want to play?"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => route.name !== 'search' && go({ name: 'search', q: (typed.current = q) })}
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
  const { go, route, player, toast, source } = ctx
  // No chip picked shows everything, as in Spotify; clicking the picked chip clears it.
  const [filter, setFilter] = useState<LibraryFilter | null>(null)
  const [sort, setSortState] = useState<LibrarySort>(() => (localStorage.getItem('library-sort') as LibrarySort) || 'Recents')
  const setSort = (s: LibrarySort) => (localStorage.setItem('library-sort', s), setSortState(s))
  const [find, setFind] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => onLibraryChange(() => setVersion((v) => v + 1)), [])
  const load = (f: LibraryFilter) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useCached<Card[]>(`library:${authed}:${f}:${version}`, () => (authed ? window.ytm.library(f) : Promise.resolve([])), {
      persist: version === 0
    }).data ?? []
  const lists = { Playlists: load('Playlists'), Artists: load('Artists'), Albums: load('Albums') }
  const create = async () => {
    if (!authed) return window.ytm.login()
    const pick = await window.ytm.popup([{ id: 'playlist', label: 'Playlist' }])
    if (pick !== 'playlist') return
    const n = cachedPlaylists().filter((c) => c.title.startsWith('My Playlist #')).length + 1
    try {
      const id = await window.ytm.createPlaylist(`My Playlist #${n}`)
      toast(`Created My Playlist #${n}`)
      setVersion((v) => v + 1)
      go({ name: 'playlist', id })
    } catch {
      toast('Couldn’t create the playlist')
    }
  }
  const playlists = [LIKED, ...lists.Playlists.filter((c) => c.id !== 'VLLM')]
  let list = filter === 'Artists' ? lists.Artists : filter === 'Albums' ? lists.Albums : filter ? playlists : [...playlists, ...lists.Albums, ...lists.Artists]
  if (find) list = list.filter((c) => `${c.title} ${c.subtitle}`.toLowerCase().includes(find.toLowerCase()))
  // "Recents" keeps YouTube Music's own order (most recent first); Liked Songs stays pinned on top.
  if (sort !== 'Recents') {
    const key = (c: Card) => (sort === 'Creator' ? c.subtitle.split(' • ').slice(-1)[0] : c.title).toLowerCase()
    list = [...list.filter((c) => c.id === 'LM'), ...list.filter((c) => c.id !== 'LM').sort((a, b) => key(a).localeCompare(key(b)))]
  }
  const sortMenu = async () => {
    const pick = await window.ytm.popup(
      (['Recents', 'Alphabetical', 'Creator'] as LibrarySort[]).map((s) => ({ id: s, label: `${s === sort ? '✓ ' : '    '}${s}` }))
    )
    if (pick) setSort(pick as LibrarySort)
  }
  return (
    <nav className="library panel">
      <div className="lib-head">
        <button className="lib-title" onClick={onToggle} title="Collapse Your Library">
          <I.Library size={24} />
          {!collapsed && <span>Your Library</span>}
        </button>
        {!collapsed && (
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
          <button className="lib-sort" onClick={sortMenu} title="Sort by">
            {sort} <I.Queue size={14} />
          </button>
        </div>
      )}
      <div className="lib-list">
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
          return (
            <div
              key={c.kind + c.id}
              className={`lib-item ${active ? 'active' : ''}`}
              onClick={() => r && go(r)}
              onContextMenu={(e) => (e.preventDefault(), c.id !== 'LM' && cardMenu(c, ctx))}
              title={collapsed ? c.title : undefined}
            >
              {c.id === 'LM' ? (
                <div className="liked-art">
                  <I.HeartFill size={collapsed ? 20 : 16} />
                </div>
              ) : (
                <img src={sized(c.thumb, 48)} className={c.kind === 'artist' ? 'round' : ''} loading="lazy" />
              )}
              {!collapsed && (
                <div className="lib-text">
                  <span className={`t1 ${playing ? 'green' : ''}`}>{c.title}</span>
                  <span className="t2">
                    {c.id === 'LM' && <I.Pin size={12} className="green pin" />}
                    <span className="ellipsis">{c.subtitle}</span>
                  </span>
                </div>
              )}
              {playing && !collapsed && <I.Volume size={16} className="green lib-playing" aria-label="Playing" />}
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
      <img src={q.thumb || `https://i.ytimg.com/vi/${q.videoId}/default.jpg`} loading="lazy" />
      <div className="np-next-text">
        <div className={`t1 ${playing ? 'green' : ''}`}>{q.title}</div>
        <div className="t2">{q.artist}</div>
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

function NowPlayingPanel({ onClose, onLike, onQueue, covered }: { onClose: () => void; onLike: () => void; onQueue: () => void; covered: boolean }) {
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
          <img className="np-art" src={player.thumb} />
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
          <button
            className={`icon-btn ${player.liked ? 'green' : ''}`}
            onClick={onLike}
            aria-label={player.liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'}
            title={player.liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'}
          >
            {player.liked ? <I.CheckCircle size={24} /> : <I.PlusCircle size={24} />}
          </button>
        </div>
        <div className="np-video">
          <button className="outline-btn small" onClick={switchVideo}>
            {prefs.videoMode ? 'Switch to audio' : 'Switch to video'}
          </button>
        </div>
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
function VideoSlot({ poster }: { poster: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const el = ref.current!
    const scroller = el.closest('.np-scroll, .fs')!
    let last = ''
    const report = () => {
      const r = el.getBoundingClientRect()
      const box = scroller.getBoundingClientRect()
      const visible = r.top >= box.top && r.bottom <= box.bottom && r.width > 0
      const rect = visible ? { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } : null
      const key = JSON.stringify(rect)
      if (key === last) return
      last = key
      setShown(!!rect)
      window.ytm.videoRect(rect)
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    ro.observe(document.body)
    scroller.addEventListener('scroll', report, { passive: true })
    return () => {
      ro.disconnect()
      scroller.removeEventListener('scroll', report)
      window.ytm.videoRect(null)
    }
  }, [])
  return (
    <div ref={ref} className="np-art np-video-slot">
      {!shown && <img src={poster} />}
    </div>
  )
}

function Slider({ value, max, onChange, className = '' }: { value: number; max: number; onChange: (v: number) => void; className?: string }) {
  const [drag, setDrag] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const at = (x: number) => {
    const r = ref.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, (x - r.left) / r.width)) * max
  }
  const shown = drag ?? value
  const pct = max ? (shown / max) * 100 : 0
  return (
    <div
      ref={ref}
      className={`slider ${drag !== null ? 'dragging' : ''} ${className}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag(at(e.clientX))
      }}
      onPointerMove={(e) => drag !== null && setDrag(at(e.clientX))}
      onPointerUp={(e) => {
        if (drag === null) return
        onChange(at(e.clientX))
        setDrag(null)
      }}
      onPointerCancel={() => setDrag(null)}
    >
      <div className="track">
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="knob" style={{ left: `${pct}%` }} />
    </div>
  )
}

const REPEAT_LABEL = { NONE: 'Enable repeat', ALL: 'Enable repeat one', ONE: 'Disable repeat' } as const

// Shuffle / previous / play / next / repeat, shared by the player bar and the full-screen view.
function Controls({ onShuffle, big }: { onShuffle: () => void; big?: boolean }) {
  const { player: p } = useApp()
  const cmd = window.ytm.cmd
  // Nothing loaded yet: the controls show but can't be used, as in Spotify.
  const off = !p?.videoId
  return (
    <div className={`pb-controls ${big ? 'big' : ''}`}>
      <button className="icon-btn" disabled={off} onClick={onShuffle} aria-label="Shuffle queue" title="Shuffle queue">
        <I.Shuffle size={big ? 24 : 16} />
      </button>
      <button className="icon-btn" disabled={off} onClick={() => cmd({ type: 'prev' })} aria-label="Previous" title="Previous">
        <I.Prev size={big ? 24 : 16} />
      </button>
      <button className="play-btn" disabled={off} onClick={() => cmd({ type: 'toggle' })} aria-label={p?.playing ? 'Pause' : 'Play'} title={p?.playing ? 'Pause' : 'Play'}>
        {p?.playing ? <I.Pause size={big ? 24 : 16} /> : <I.Play size={big ? 24 : 16} />}
      </button>
      <button className="icon-btn" disabled={off} onClick={() => cmd({ type: 'next' })} aria-label="Next" title="Next">
        <I.Next size={big ? 24 : 16} />
      </button>
      <button
        disabled={off}
        className={`icon-btn repeat ${p && p.repeat !== 'NONE' ? 'green dot' : ''}`}
        onClick={() => cmd({ type: 'repeat' })}
        aria-label={REPEAT_LABEL[p?.repeat ?? 'NONE']}
        title={REPEAT_LABEL[p?.repeat ?? 'NONE']}
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
  return (
    <div className="pb-progress">
      <span className="time">{fmt(time)}</span>
      <Slider value={time} max={p?.duration ?? 0} onChange={(s) => window.ytm.cmd({ type: 'seek', seconds: s })} />
      <span className="time">{fmt(p?.duration ?? 0)}</span>
    </div>
  )
}

function VolumeControl() {
  const { player: p } = useApp()
  return (
    <>
      <button
        className="icon-btn"
        onClick={() => window.ytm.cmd({ type: 'mute' })}
        aria-label={p?.muted || p?.volume === 0 ? 'Unmute' : 'Mute'}
        title={p?.muted || p?.volume === 0 ? 'Unmute' : 'Mute'}
      >
        {p?.muted || p?.volume === 0 ? <I.VolumeMute /> : <I.Volume />}
      </button>
      <Slider
        className="volume"
        value={p?.muted ? 0 : (p?.volume ?? 0)}
        max={100}
        onChange={(v) => window.ytm.cmd({ type: 'volume', value: v })}
      />
    </>
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
// along the bottom. Puts the window itself into full screen while open.
function FullScreenView({ onClose, onLike, onShuffle, covered }: { onClose: () => void; onLike: () => void; onShuffle: () => void; covered: boolean }) {
  const { player: p, prefs, route } = useApp()
  const tint = useColor(p?.thumb)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    window.ytm.fullscreen(true)
    // Leaving full screen from the window's own controls closes this view too.
    const off = window.ytm.onFullscreen((on) => !on && close.current())
    return () => {
      off()
      window.ytm.fullscreen(false)
    }
  }, [])
  if (!p) return null
  return (
    <div className="fs" style={{ '--tint': tint } as React.CSSProperties}>
      <div className="fs-bg" style={{ backgroundImage: `url(${p.thumb})` }} />
      <div className="fs-top">
        <span>Playing from</span>
        <b>{p.album || (route.name === 'lyrics' ? 'Lyrics' : 'YouTube Music')}</b>
      </div>
      <div className="fs-now">
        {prefs.videoMode && p.isVideo && !covered ? <VideoSlot poster={p.thumb} /> : <img className="fs-art" src={p.thumb} />}
        <div className="fs-text">
          <div className="fs-title">{p.title}</div>
          <div className="fs-artist">{p.artist}</div>
        </div>
      </div>
      <div className="fs-bottom">
        <Progress />
        <div className="fs-row">
          <div className="fs-side">
            <button className={`icon-btn ${p.liked ? 'green' : ''}`} onClick={onLike} aria-label="Like">
              {p.liked ? <I.CheckCircle size={24} /> : <I.PlusCircle size={24} />}
            </button>
          </div>
          <Controls onShuffle={onShuffle} big />
          <div className="fs-side right">
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
  onLike: () => void
  onShuffle: () => void
  onLyrics: () => void
  onFull: () => void
}) {
  const { rightOpen, onToggleRight } = props
  const { player: p, openQueue, route, go } = useApp()
  return (
    <footer className="player-bar">
      <div className="pb-left">
        {p?.videoId && (
          <>
            <img src={sized(p.thumb, 56)} className="clickable" onClick={onToggleRight} title="Now playing view" />
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
            <button
              className={`icon-btn ${p.liked ? 'green' : ''}`}
              onClick={props.onLike}
              aria-label={p.liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'}
              title={p.liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'}
            >
              {p.liked ? <I.CheckCircle /> : <I.PlusCircle />}
            </button>
          </>
        )}
      </div>
      <div className="pb-center">
        <Controls onShuffle={props.onShuffle} />
        <Progress />
      </div>
      <div className="pb-right">
        <button className={`icon-btn ${rightOpen ? 'green dot' : ''}`} onClick={onToggleRight} aria-label="Now playing view" title="Now playing view">
          <I.NowPlaying />
        </button>
        <button
          className={`icon-btn ${route.name === 'lyrics' ? 'green dot' : ''}`}
          onClick={props.onLyrics}
          aria-label="Lyrics"
          title="Lyrics"
        >
          <I.Lyrics />
        </button>
        <button className={`icon-btn ${props.queueOpen ? 'green dot' : ''}`} onClick={openQueue} title="Queue" aria-label="Queue">
          <I.Queue />
        </button>
        <VolumeControl />
        <button className="icon-btn" onClick={props.onFull} aria-label="Full screen" title="Full screen" disabled={!p?.videoId}>
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
                  {keys[s.action].map((k) => (
                    <kbd key={k}>{comboLabel(k)}</kbd>
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
