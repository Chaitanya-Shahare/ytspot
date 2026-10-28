import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Card, LibraryFilter, PlayerState, Track } from '../../shared/types'
import * as I from './components/icons'
import { Ctx, fmt, getClock, invalidate, loadPrefs, routeFor, savePrefs, setClock, sized, useApp, useCached, useColor, useTime, type AppCtx, type Prefs, type Route } from './lib'
import { bindings, comboLabel, comboOf, SHORTCUTS, type Action } from '../../shared/shortcuts'
import { songMenu } from './components/menus'
import { Boundary } from './components/ui'
import { SettingsView } from './views/settings'
import { LyricsView } from './views/lyrics'
import { MoodView, SearchView } from './views/search'
import { ArtistView, CollectionView, ExploreView, HomeView } from './views/views'

const LIKED: Card = { kind: 'playlist', id: 'LM', title: 'Liked Songs', subtitle: 'Playlist', thumb: '' }

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
  useEffect(() => {
    let wide = window.innerWidth > 1100
    const fit = () => {
      if (wide !== window.innerWidth > 1100) setLeft((wide = !wide))
    }
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  useEffect(() => {
    window.ytm.authStatus().then(setAuthed)
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

  const toast = useCallback((msg: string) => setToastMsg(msg), [])
  useEffect(() => {
    if (!toastMsg) return
    const t = setTimeout(() => setToastMsg(null), 2500)
    return () => clearTimeout(t)
  }, [toastMsg])

  const like = useCallback(() => {
    window.ytm.cmd({ type: 'like' })
    invalidate('playlist:LM')
    toast(player?.liked ? 'Removed from Liked Songs' : 'Added to Liked Songs')
  }, [player?.liked, toast])

  const shuffle = useCallback(() => {
    window.ytm.cmd({ type: 'shuffle' })
    toast('Queue shuffled')
  }, [toast])

  const openQueue = useCallback(() => {
    setRight(true)
    setTimeout(() => document.getElementById('np-queue')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }, [])

  const toggleLyrics = useCallback(
    () => (route.name === 'lyrics' && pos > 0 ? back() : route.name !== 'lyrics' && go({ name: 'lyrics' })),
    [route.name, pos, back, go]
  )

  const playTrack = useCallback((t: Track, playlistId?: string) => {
    window.ytm.cmd({ type: 'play', videoId: t.videoId, playlistId })
  }, [])

  // Albums, playlists and artists open their page; songs and videos play.
  const openCard = useCallback(
    (c: Card) => {
      const r = routeFor(c)
      if (r) go(r)
      else window.ytm.cmd({ type: 'play', videoId: c.id })
    },
    [go]
  )

  const playCard = useCallback(async (c: Card) => {
    if (c.kind === 'song' || c.kind === 'video') return window.ytm.cmd({ type: 'play', videoId: c.id })
    if (c.kind === 'artist') {
      const a = await window.ytm.artist(c.id)
      if (a.songs[0]) window.ytm.cmd({ type: 'play', videoId: a.songs[0].videoId })
      return
    }
    const col = c.kind === 'album' ? await window.ytm.album(c.id) : await window.ytm.playlist(c.id)
    if (col.tracks[0]) window.ytm.cmd({ type: 'play', videoId: col.tracks[0].videoId, playlistId: col.playlistId })
  }, [])

  // One handler for both keyboard shortcuts and menu-bar clicks.
  const run = useCallback(
    (a: Action) => {
      const cmd = window.ytm.cmd
      const vol = player?.volume ?? 50
      switch (a) {
        case 'toggle': return void cmd({ type: 'toggle' })
        case 'next': return void cmd({ type: 'next' })
        case 'prev': return void cmd({ type: 'prev' })
        case 'seekFwd': return void cmd({ type: 'seek', seconds: getClock() + 10 })
        case 'seekBack': return void cmd({ type: 'seek', seconds: Math.max(0, getClock() - 10) })
        case 'seekFwdSmall': return void cmd({ type: 'seek', seconds: getClock() + 1 })
        case 'seekBackSmall': return void cmd({ type: 'seek', seconds: Math.max(0, getClock() - 1) })
        case 'mute': return void cmd({ type: 'mute' })
        case 'dislike': cmd({ type: 'dislike' }); return toast('Disliked — skipping')
        case 'explore': return go({ name: 'explore' })
        case 'library': return setLeft(true)
        case 'settings': return go({ name: 'settings' })
        case 'fullscreen': return setFull((v) => !v)
        case 'lyrics': return toggleLyrics()
        case 'volUp': return void cmd({ type: 'volume', value: Math.min(100, vol + 10) })
        case 'volDown': return void cmd({ type: 'volume', value: Math.max(0, vol - 10) })
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
        case 'toggleRight': return setRight((v) => !v)
        case 'help': return setHelp((v) => !v)
      }
    },
    [player, go, back, forward, like, shuffle, openQueue, toast, toggleLyrics]
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
    () => ({ route, go, player, playTrack, openCard, playCard, toast, prefs, setPrefs, openQueue }),
    [route, go, player, playTrack, openCard, playCard, toast, prefs, setPrefs, openQueue]
  )

  if (authed === null) return <div className="splash" />

  const rightShown = right && !!player?.videoId
  const maxSide = (other: number) => Math.max(280, window.innerWidth - other - MAIN_MIN - 32)
  const rightPx = () => document.querySelector('.now-playing')?.getBoundingClientRect().width ?? 0
  const leftPx = () => document.querySelector('.library')?.getBoundingClientRect().width ?? 0
  const resizeLeft = (w: number) => {
    setLeft(w >= COLLAPSE_AT)
    if (w >= COLLAPSE_AT) setLayout((l) => ({ ...l, left: clamp(w, 280, maxSide(rightPx())) }))
  }
  const resizeRight = (w: number) => setLayout((l) => ({ ...l, right: clamp(w, 280, maxSide(leftPx())) }))
  const vars = {
    ...(left ? { '--left-w': `${layout.left}px` } : {}),
    ...(layout.right ? { '--right-w': `${layout.right}px` } : {})
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
        <LibraryPanel authed={authed} collapsed={!left} onToggle={() => setLeft((v) => !v)} />
        <Resizer side="left" width={leftPx} onResize={resizeLeft} label="Resize Your Library" />
        <main className="main-view" key={JSON.stringify(route)}>
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
            </Boundary>
          </div>
        </main>
        {rightShown && (
          <>
            <Resizer side="right" width={rightPx} onResize={resizeRight} label="Resize Now Playing view" />
            <Boundary resetKey={player?.videoId}>
              <NowPlayingPanel onClose={() => setRight(false)} onLike={like} covered={help || full} />
            </Boundary>
          </>
        )}
        <PlayerBar
          rightOpen={rightShown}
          onToggleRight={() => setRight((v) => !v)}
          onLike={like}
          onShuffle={shuffle}
          onLyrics={toggleLyrics}
          onFull={() => setFull(true)}
        />
      </div>
      {full && player?.videoId && (
        <Boundary resetKey={player.videoId}>
          <FullScreenView onClose={() => setFull(false)} onLike={like} onShuffle={shuffle} covered={help} />
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
  useEffect(() => {
    if (route.name !== 'search') return
    const t = setTimeout(() => q !== route.q && go({ name: 'search', q }), 300)
    return () => clearTimeout(t)
  }, [q, route, go])
  return (
    <header className="topbar">
      <div className="nav-arrows">
        <button className="circle-btn" disabled={!p.canBack} onClick={p.onBack} aria-label="Go back">
          <I.ChevronLeft />
        </button>
        <button className="circle-btn" disabled={!p.canFwd} onClick={p.onFwd} aria-label="Go forward">
          <I.ChevronRight />
        </button>
      </div>
      <div className="center">
        <button className="home-btn" onClick={() => go({ name: 'home' })} aria-label="Home">
          {route.name === 'home' ? <I.Home size={24} /> : <I.HomeOutline size={24} />}
        </button>
        <label className="search-box">
          <I.Search size={24} />
          <input
            ref={p.searchRef}
            placeholder="What do you want to play?"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => route.name !== 'search' && go({ name: 'search', q })}
            onKeyDown={(e) => e.key === 'Enter' && go({ name: 'search', q })}
          />
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
  const { go, route, player, toast } = useApp()
  const [filter, setFilter] = useState<LibraryFilter>('Playlists')
  const [version, setVersion] = useState(0)
  const { data: items = [] } = useCached<Card[]>(
    `library:${authed}:${filter}:${version}`,
    () => (authed ? window.ytm.library(filter) : Promise.resolve([])),
    { persist: version === 0 }
  )
  const create = async () => {
    if (!authed) return window.ytm.login()
    const pick = await window.ytm.popup([{ id: 'playlist', label: 'Playlist' }])
    if (pick !== 'playlist') return
    const n = items.filter((c) => c.title.startsWith('My Playlist #')).length + 1
    try {
      const id = await window.ytm.createPlaylist(`My Playlist #${n}`)
      toast(`Created My Playlist #${n}`)
      setFilter('Playlists')
      setVersion((v) => v + 1)
      go({ name: 'playlist', id })
    } catch {
      toast('Couldn’t create the playlist')
    }
  }
  const list = filter === 'Playlists' ? [LIKED, ...items.filter((c) => c.id !== 'VLLM')] : items
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
          {(['Playlists', 'Artists', 'Albums'] as LibraryFilter[]).map((f) => (
            <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
      )}
      <div className="lib-list">
        {authed && list.map((c) => {
          const r = routeFor(c)
          const active = r && JSON.stringify(r) === JSON.stringify(route)
          const playing = player?.playing && c.title === player.album
          return (
            <div key={c.kind + c.id} className={`lib-item ${active ? 'active' : ''}`} onClick={() => r && go(r)}>
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
                    {c.id === 'LM' && <I.CheckCircle size={12} className="green pin" />}
                    {c.subtitle}
                  </span>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </nav>
  )
}

function NowPlayingPanel({ onClose, onLike, covered }: { onClose: () => void; onLike: () => void; covered: boolean }) {
  const ctx = useApp()
  const { player, go, prefs, setPrefs } = ctx
  // Drag-and-drop reordering: indexes are positions in YTM's queue.
  const [drag, setDrag] = useState<{ list: 'queue' | 'auto'; from: number; over: number } | null>(null)
  // Drag-and-drop props for a row of either list; drops only land within the same list.
  const dnd = (list: 'queue' | 'auto', i: number) => ({
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
  if (!player) return null
  const idx = player.queue.findIndex((q) => q.selected)
  const upcoming = player.queue.map((q, i) => ({ q, i })).slice(idx + 1).filter(({ q }) => q.videoId)
  const current = { videoId: player.videoId, title: player.title, artistId: player.artistId, albumId: player.albumId }
  const switchVideo = () => {
    setPrefs({ videoMode: !prefs.videoMode })
    ctx.toast(prefs.videoMode ? 'We’ll only play audio from now on.' : 'We’ll play video when available, from now on.')
  }
  return (
    <aside className="now-playing panel">
      <div className="np-head">
        <span className="np-head-title">{player.album || 'Now playing'}</span>
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
          <button className={`icon-btn ${player.liked ? 'green' : ''}`} onClick={onLike} aria-label="Like" title="Save to Liked Songs">
            {player.liked ? <I.CheckCircle size={24} /> : <I.PlusCircle size={24} />}
          </button>
        </div>
        <div className="np-video">
          <button className="outline-btn small" onClick={switchVideo}>
            {prefs.videoMode ? 'Switch to audio' : 'Switch to video'}
          </button>
        </div>
        <div className="np-card" id="np-queue">
          <div className="np-card-head">
            <b>Next in queue</b>
            <span className="sub">{upcoming.length ? `${upcoming.length} songs` : 'Empty'}</span>
          </div>
          {upcoming.map(({ q, i }) => (
            <div
              key={q.videoId + i}
              {...dnd('queue', i)}
              className={`np-next ${dnd('queue', i).className}`}
              onClick={() => window.ytm.cmd({ type: 'jump', index: i })}
              onContextMenu={(e) => (e.preventDefault(), songMenu(q, ctx, { queueIndex: i }))}
            >
              <img src={q.thumb || `https://i.ytimg.com/vi/${q.videoId}/default.jpg`} loading="lazy" />
              <div className="np-next-text">
                <div className="t1">{q.title}</div>
                <div className="t2">{q.artist}</div>
              </div>
              <button
                className="row-more"
                onClick={(e) => (e.stopPropagation(), songMenu(q, ctx, { queueIndex: i }))}
                aria-label={`More options for ${q.title}`}
              >
                <I.More />
              </button>
            </div>
          ))}
          {player.autoplay.length > 0 && (
            <>
              <div className="np-card-head np-sub-head">
                <b>Next from: Autoplay</b>
                <span className="sub">{player.autoplay.length} songs</span>
              </div>
              {player.autoplay.map((q, i) => (
                <div
                  key={'auto' + q.videoId + i}
                  {...dnd('auto', i)}
                  className={`np-next ${dnd('auto', i).className}`}
                  onClick={() => window.ytm.cmd({ type: 'jumpAuto', index: i })}
                  onContextMenu={(e) => (e.preventDefault(), songMenu(q, ctx))}
                >
                  <img src={q.thumb || `https://i.ytimg.com/vi/${q.videoId}/default.jpg`} loading="lazy" />
                  <div className="np-next-text">
                    <div className="t1">{q.title}</div>
                    <div className="t2">{q.artist}</div>
                  </div>
                  <button className="row-more" onClick={(e) => (e.stopPropagation(), songMenu(q, ctx))} aria-label={`More options for ${q.title}`}>
                    <I.More />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
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
        onChange(at(e.clientX))
        setDrag(null)
      }}
    >
      <div className="track">
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="knob" style={{ left: `${pct}%` }} />
    </div>
  )
}

// Shuffle / previous / play / next / repeat, shared by the player bar and the full-screen view.
function Controls({ onShuffle, big }: { onShuffle: () => void; big?: boolean }) {
  const { player: p } = useApp()
  const cmd = window.ytm.cmd
  return (
    <div className={`pb-controls ${big ? 'big' : ''}`}>
      <button className="icon-btn" onClick={onShuffle} aria-label="Shuffle">
        <I.Shuffle size={big ? 24 : 16} />
      </button>
      <button className="icon-btn" onClick={() => cmd({ type: 'prev' })} aria-label="Previous">
        <I.Prev size={big ? 24 : 16} />
      </button>
      <button className="play-btn" onClick={() => cmd({ type: 'toggle' })} aria-label={p?.playing ? 'Pause' : 'Play'}>
        {p?.playing ? <I.Pause size={big ? 24 : 16} /> : <I.Play size={big ? 24 : 16} />}
      </button>
      <button className="icon-btn" onClick={() => cmd({ type: 'next' })} aria-label="Next">
        <I.Next size={big ? 24 : 16} />
      </button>
      <button
        className={`icon-btn repeat ${p && p.repeat !== 'NONE' ? 'green dot' : ''}`}
        onClick={() => cmd({ type: 'repeat' })}
        aria-label="Repeat"
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
      <button className="icon-btn" onClick={() => window.ytm.cmd({ type: 'mute' })} aria-label="Mute">
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
  useEffect(() => {
    window.ytm.fullscreen(true)
    // Leaving full screen from the window's own controls closes this view too.
    const off = window.ytm.onFullscreen((on) => !on && onClose())
    return () => {
      off()
      window.ytm.fullscreen(false)
    }
  }, [onClose])
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
  onToggleRight: () => void
  onLike: () => void
  onShuffle: () => void
  onLyrics: () => void
  onFull: () => void
}) {
  const { rightOpen, onToggleRight } = props
  const { player: p, openQueue, route } = useApp()
  return (
    <footer className="player-bar">
      <div className="pb-left">
        {p?.videoId && (
          <>
            <img src={sized(p.thumb, 56)} className="clickable" onClick={onToggleRight} title="Now playing view" />
            <div className="pb-text">
              <span className="t1">{p.title}</span>
              <span className="t2">{p.artist}</span>
            </div>
            <button className={`icon-btn ${p.liked ? 'green' : ''}`} onClick={props.onLike} aria-label="Like">
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
        <button className="icon-btn" onClick={openQueue} title="Queue" aria-label="Queue">
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
