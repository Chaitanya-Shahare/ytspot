import type { Card, Shelf, Track } from '../../../shared/types'
import { Component, memo, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { moreRoute, routeFor, sameRoute, sized, useApp, type AppCtx, type Source } from '../lib'
import { ChevronLeft, ChevronRight, Clock, More, Note, Pause, Play } from './icons'
import { cardMenu, songMenu } from './menus'

// Artwork that fades in once loaded (Spotify) and shows a placeholder when there's none or it fails.
export function Img({ src, className = '', artist, onClick, title }: { src?: string; className?: string; artist?: boolean; onClick?: () => void; title?: string }) {
  // Remember which source loaded or failed, so a new `src` starts over without an effect (a cached
  // image can finish loading before an effect would run, and must not be hidden again).
  const [loaded, setLoaded] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  // Once anything has loaded, a new `src` stays visible: the browser keeps drawing the old picture
  // until the new one is ready, so artwork swaps without a blank flash.
  const state = !src || failed === src ? 'failed' : loaded !== null ? 'ok' : 'loading'
  if (state === 'failed')
    return (
      <span className={`img-fallback ${artist ? 'round' : ''} ${className}`} onClick={onClick} title={title}>
        <Note />
      </span>
    )
  return (
    <img
      src={src}
      className={`fade ${state === 'ok' ? 'loaded' : ''} ${artist ? 'round' : ''} ${className}`}
      loading="lazy"
      ref={(el) => void (el?.complete && el.naturalWidth && loaded !== src && setLoaded(src ?? null))}
      onLoad={() => setLoaded(src ?? null)}
      onError={() => setFailed(src ?? null)}
      onClick={onClick}
      title={title}
      alt=""
    />
  )
}

export function GreenPlay({ size = 48, playing, onClick }: { size?: number; playing?: boolean; onClick: () => void }) {
  return (
    <button
      className="green-play"
      style={{ width: size, height: size }}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      aria-label={playing ? 'Pause' : 'Play'}
    >
      {playing ? <Pause size={size * 0.4} /> : <Play size={size * 0.4} />}
    </button>
  )
}

// Spotify's bar that fades in at the top of a playlist, album or artist page once the page's own
// play button scrolls away: a play button and the title over the page's colour.
export function StickyHead({ title, playing, onPlay, anchor }: { title: string; playing?: boolean; onPlay: () => void; anchor: RefObject<HTMLElement | null> }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const el = anchor.current
    const scroller = el?.closest('.main-scroll')
    if (!el || !scroller) return
    const check = () => setShown(scroller.scrollTop > el.offsetTop + el.offsetHeight - 64)
    check()
    scroller.addEventListener('scroll', check, { passive: true })
    return () => scroller.removeEventListener('scroll', check)
  }, [anchor])
  return (
    <div className={`sticky-head ${shown ? 'shown' : ''}`} aria-hidden={!shown}>
      <GreenPlay size={48} playing={playing} onClick={onPlay} />
      <span className="sticky-title">{title}</span>
    </div>
  )
}

export function CardTile({ card }: { card: Card }) {
  const ctx = useApp()
  const { openCard, playCard, player, source } = ctx
  // The card for what's playing keeps its button showing, as a pause button.
  const current = !!player?.videoId && (card.id === player.videoId || sameRoute(routeFor(card), source?.route))
  const playing = current && !!player?.playing
  return (
    <div className="card" onClick={() => openCard(card)} onContextMenu={(e) => (e.preventDefault(), cardMenu(card, ctx))}>
      <div className={`card-img ${playing ? 'playing' : ''}`}>
        <Img src={sized(card.thumb, 180)} artist={card.kind === 'artist'} />
        <GreenPlay playing={playing} onClick={() => (current ? window.ytm.cmd({ type: 'toggle' }) : playCard(card))} />
      </div>
      <div className="card-title">{card.title}</div>
      <div className="card-sub">{card.subtitle}</div>
    </div>
  )
}

export function ShelfRow({ shelf }: { shelf: Shelf }) {
  const { go } = useApp()
  const more = shelf.more && moreRoute(shelf.more, shelf.title)
  // A row shows whole cards only; hover arrows page through the rest, as on Spotify's Home.
  const row = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ start: true, end: true })
  const measure = useCallback(() => {
    const el = row.current
    if (el) setEdges({ start: el.scrollLeft <= 1, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 })
  }, [])
  useEffect(() => {
    const el = row.current
    if (!el) return
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure, shelf.cards.length])
  const page = (dir: 1 | -1) => row.current?.scrollBy({ left: dir * row.current.clientWidth, behavior: 'smooth' })
  return (
    <section className="shelf">
      <div className="shelf-head">
        <h2 className={more ? 'link' : ''} onClick={() => more && go(more)}>
          {shelf.title}
        </h2>
        {more && (
          <button className="show-all" onClick={() => go(more)}>
            Show all
          </button>
        )}
      </div>
      <div className="shelf-body">
        <div className="shelf-row" ref={row} onScroll={measure}>
          {shelf.cards.map((c) => (
            <CardTile key={c.kind + c.id} card={c} />
          ))}
        </div>
        {!edges.start && (
          <button className="shelf-arrow prev" onClick={() => page(-1)} aria-label="Go back" title="Go back">
            <ChevronLeft />
          </button>
        )}
        {!edges.end && (
          <button className="shelf-arrow next" onClick={() => page(1)} aria-label="Go forward" title="Go forward">
            <ChevronRight />
          </button>
        )}
      </div>
    </section>
  )
}

export function TrackTable({
  tracks,
  playlistId,
  editable,
  from,
  showAlbum = true,
  showPlays = false,
  showHeader = true,
  nums
}: {
  tracks: Track[]
  // Each row's number when the list is filtered or re-sorted (its place in the playlist).
  nums?: number[]
  playlistId?: string
  // The user's own playlist page: its route id, and how to drop a removed row from the page.
  editable?: { id: string; onRemoved: (videoId: string) => void }
  // The page these rows belong to, shown as "Playing from" while they play.
  from?: Source
  showAlbum?: boolean
  showPlays?: boolean
  showHeader?: boolean
}) {
  const ctx = useApp()
  const { player, playTrack, go } = ctx
  // Rows are memoised; read the latest props and context through refs so their callbacks stay stable.
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const editRef = useRef(editable)
  editRef.current = editable
  const fromRef = useRef(from)
  fromRef.current = from
  const menu = useCallback(
    (t: Track) =>
      songMenu(t, ctxRef.current, {
        playlistId: editRef.current?.id,
        onRemoved: editRef.current?.onRemoved,
        liked: playlistId === 'LM' || (t.videoId === ctxRef.current.player?.videoId ? ctxRef.current.player.liked : undefined)
      }),
    [playlistId]
  )
  // The current song's own row pauses/resumes instead of restarting it.
  const play = useCallback(
    (t: Track) =>
      t.videoId === ctxRef.current.player?.videoId
        ? window.ytm.cmd({ type: 'toggle' })
        : playTrack(t, playlistId, fromRef.current),
    [playTrack, playlistId]
  )
  // Spotify-style selection: click selects a row, ↑/↓ move, Enter plays, double-click plays.
  const [sel, setSel] = useState(-1)
  // A different list (new search, another page) starts with nothing selected.
  useEffect(() => setSel(-1), [tracks[0]?.videoId])
  const box = useRef<HTMLDivElement>(null)
  const select = useCallback((i: number) => {
    setSel(i)
    ;(box.current?.querySelectorAll<HTMLElement>('.track-row:not(.head)')[i])?.focus()
  }, [])
  const onKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.altKey || e.ctrlKey) return
    // A focused row button (play, "…") handles its own keys.
    if ((e.target as HTMLElement).closest('button')) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      select(Math.max(0, Math.min(tracks.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'Enter' && tracks[sel]) {
      e.preventDefault()
      play(tracks[sel])
    }
  }
  // The column header gets a background once it sticks to the top (Spotify), and is see-through
  // over the page's colour before that.
  const head = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    const el = head.current
    const scroller = el?.closest('.main-scroll')
    if (!el || !scroller) return
    const check = () => setStuck(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top <= parseFloat(getComputedStyle(el).top) + 0.5 && scroller.scrollTop > 0)
    check()
    scroller.addEventListener('scroll', check, { passive: true })
    return () => scroller.removeEventListener('scroll', check)
  }, [showHeader])
  return (
    <div ref={box} className={`tracks ${showPlays ? 'with-plays' : showAlbum ? '' : 'no-album'}`} onKeyDown={onKey} role="grid">
      {showHeader && (
        <div ref={head} className={`track-row head ${stuck ? 'stuck' : ''}`}>
          <span className="num">#</span>
          <span>Title</span>
          {showAlbum && <span>Album</span>}
          <span className="dur">
            <Clock />
          </span>
          <span />
        </div>
      )}
      {tracks.map((t, i) => (
        <Row
          key={t.videoId + i}
          t={t}
          i={i}
          n={nums?.[i] ?? i + 1}
          showAlbum={showAlbum}
          showPlays={showPlays}
          state={player?.videoId !== t.videoId ? '' : player.playing ? 'playing' : 'current'}
          selected={i === sel}
          tabbable={i === sel || (sel < 0 && i === 0)}
          play={play}
          select={select}
          go={go}
          menu={menu}
        />
      ))}
    </div>
  )
}

// Memoised so a play/pause or track change re-renders 2 rows, not the whole 1000-row list.
const Row = memo(function Row({
  t,
  i,
  n,
  showAlbum,
  showPlays,
  state,
  selected,
  tabbable,
  play,
  select,
  go,
  menu
}: {
  t: Track
  i: number
  n: number
  showAlbum: boolean
  showPlays?: boolean
  state: '' | 'current' | 'playing'
  selected: boolean
  tabbable: boolean
  play: (t: Track) => void
  select: (i: number) => void
  go: AppCtx['go']
  menu: (t: Track) => void
}) {
  return (
    <div
      className={`track-row ${state ? 'current' : ''} ${selected ? 'selected' : ''}`}
      tabIndex={tabbable ? 0 : -1}
      role="row"
      aria-selected={selected}
      onClick={() => select(i)}
      onDoubleClick={() => play(t)}
      onContextMenu={(e) => (e.preventDefault(), select(i), menu(t))}
    >
      <span className="num">
        <span className="idx">{state === 'playing' ? <Bars /> : n}</span>
        <button
          className="row-play"
          onClick={(e) => (e.stopPropagation(), play(t))}
          aria-label={state === 'playing' ? `Pause ${t.title}` : `Play ${t.title}`}
          title={state === 'playing' ? 'Pause' : 'Play'}
        >
          {state === 'playing' ? <Pause size={14} /> : <Play size={14} />}
        </button>
      </span>
      <span className="title-cell">
        {t.thumb && <Img src={sized(t.thumb, 40)} />}
        <span className="tt">
          <span className="t1">{t.title}</span>
          <span
            className={`t2 ${t.artistId ? 'link' : ''}`}
            onClick={(e) => {
              if (!t.artistId) return
              e.stopPropagation()
              go({ name: 'artist', id: t.artistId })
            }}
          >
            {t.artists}
          </span>
        </span>
      </span>
      {showAlbum && (
        <span
          className={`sub album-cell ${t.albumId ? 'link' : ''}`}
          onClick={(e) => {
            if (!t.albumId) return
            e.stopPropagation()
            go({ name: 'album', id: t.albumId })
          }}
        >
          {t.album}
        </span>
      )}
      {showPlays && <span className="sub plays">{t.plays?.replace(/\s*plays?$/, '')}</span>}
      <span className="dur sub">{t.duration}</span>
      <button className="row-more" onClick={(e) => (e.stopPropagation(), menu(t))} aria-label={`More options for ${t.title}`} title={`More options for ${t.title}`}>
        <More size={16} />
      </button>
    </div>
  )
})

export function Bars() {
  return <span className="bars" aria-label="Playing" />
}

// Skeleton placeholders shaped like the page that's loading (Spotify-style shimmer).
type SkeletonKind = 'shelves' | 'collection' | 'artist' | 'search' | 'rows'
const bars = (n: number) => Array.from({ length: n }, (_, i) => i)

function SkCards() {
  return (
    <div className="sk-shelf">
      <div className="sk sk-heading" />
      <div className="shelf-row">
        {bars(7).map((i) => (
          <div key={i} className="card">
            <div className="sk sk-square" />
            <div className="sk sk-line" />
            <div className="sk sk-line short" />
          </div>
        ))}
      </div>
    </div>
  )
}

function SkRows({ n = 8 }: { n?: number }) {
  return (
    <div className="sk-rows">
      {bars(n).map((i) => (
        <div key={i} className="sk-row">
          <div className="sk sk-thumb" />
          <div className="sk-row-text">
            <div className="sk sk-line" style={{ width: `${40 + ((i * 17) % 35)}%` }} />
            <div className="sk sk-line short" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function Loading({ kind = 'shelves' }: { kind?: SkeletonKind }) {
  return (
    <div className="page skeleton" aria-busy="true" aria-label="Loading">
      {kind === 'shelves' && (
        <>
          <SkCards />
          <SkCards />
          <SkCards />
        </>
      )}
      {kind === 'collection' && (
        <>
          <div className="hero">
            <div className="sk hero-art" />
            <div className="hero-text sk-hero-text">
              <div className="sk sk-line short" />
              <div className="sk sk-title" />
              <div className="sk sk-line" />
            </div>
          </div>
          <div className="action-bar">
            <div className="sk sk-circle" />
          </div>
          <SkRows n={10} />
        </>
      )}
      {kind === 'artist' && (
        <>
          <div className="sk sk-banner" />
          <div className="action-bar">
            <div className="sk sk-circle" />
          </div>
          <SkRows n={5} />
          <SkCards />
        </>
      )}
      {kind === 'search' && (
        <>
          <div className="search-top">
            <div className="sk sk-top-card" />
            <SkRows n={4} />
          </div>
          <SkCards />
        </>
      )}
      {kind === 'rows' && <SkRows n={6} />}
    </div>
  )
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="page error-box">
      <h2>Something went wrong</h2>
      <p className="sub">{error.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}</p>
      {onRetry && (
        <button className="pill-btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

// Keeps one broken page from blanking the whole app; the error goes to the app log.
export class Boundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    window.ytm.log(`${error.stack ?? error.message}\n${info.componentStack ?? ''}`)
  }
  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }
  render() {
    return this.state.error ? (
      <ErrorBox error={this.state.error.message} onRetry={() => this.setState({ error: null })} />
    ) : (
      this.props.children
    )
  }
}
