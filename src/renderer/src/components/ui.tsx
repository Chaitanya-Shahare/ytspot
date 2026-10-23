import type { Card, Shelf, Track } from '../../../shared/types'
import { Component, memo, useCallback, useRef, type ReactNode } from 'react'
import { sized, useApp, type AppCtx } from '../lib'
import { Clock, More, Pause, Play } from './icons'
import { songMenu } from './menus'

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

export function CardTile({ card }: { card: Card }) {
  const { openCard, playCard } = useApp()
  return (
    <div className="card" onClick={() => openCard(card)}>
      <div className="card-img">
        <img src={sized(card.thumb, 180)} className={card.kind === 'artist' ? 'round' : ''} loading="lazy" />
        <GreenPlay onClick={() => playCard(card)} />
      </div>
      <div className="card-title">{card.title}</div>
      <div className="card-sub">{card.subtitle}</div>
    </div>
  )
}

export function ShelfRow({ shelf }: { shelf: Shelf }) {
  return (
    <section className="shelf">
      <div className="shelf-head">
        <h2>{shelf.title}</h2>
      </div>
      <div className="shelf-row">
        {shelf.cards.map((c) => (
          <CardTile key={c.kind + c.id} card={c} />
        ))}
      </div>
    </section>
  )
}

export function TrackTable({
  tracks,
  playlistId,
  showAlbum = true,
  showHeader = true
}: {
  tracks: Track[]
  playlistId?: string
  showAlbum?: boolean
  showHeader?: boolean
}) {
  const ctx = useApp()
  const { player, playTrack, go } = ctx
  // Rows are memoised; read the latest context through a ref so the menu callback stays stable.
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const menu = useCallback(
    (t: Track) => songMenu(t, ctxRef.current, { playlistId, liked: playlistId === 'LM' || undefined }),
    [playlistId]
  )
  return (
    <div className={`tracks ${showAlbum ? '' : 'no-album'}`}>
      {showHeader && (
        <div className="track-row head">
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
          playlistId={playlistId}
          showAlbum={showAlbum}
          state={player?.videoId !== t.videoId ? '' : player.playing ? 'playing' : 'current'}
          playTrack={playTrack}
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
  playlistId,
  showAlbum,
  state,
  playTrack,
  go,
  menu
}: {
  t: Track
  i: number
  playlistId?: string
  showAlbum: boolean
  state: '' | 'current' | 'playing'
  playTrack: AppCtx['playTrack']
  go: AppCtx['go']
  menu: (t: Track) => void
}) {
  return (
    <div
      className={`track-row ${state ? 'current' : ''}`}
      onDoubleClick={() => playTrack(t, playlistId)}
      onContextMenu={(e) => (e.preventDefault(), menu(t))}
    >
      <span className="num">
        <span className="idx">{state === 'playing' ? <Bars /> : i + 1}</span>
        <button className="row-play" onClick={() => playTrack(t, playlistId)} aria-label="Play">
          <Play size={14} />
        </button>
      </span>
      <span className="title-cell">
        {t.thumb && <img src={sized(t.thumb, 40)} loading="lazy" />}
        <span className="tt">
          <span className="t1">{t.title}</span>
          <span
            className={`t2 ${t.artistId ? 'link' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              if (t.artistId) go({ name: 'artist', id: t.artistId })
            }}
          >
            {t.artists}
          </span>
        </span>
      </span>
      {showAlbum && (
        <span className={`sub ${t.albumId ? 'link' : ''}`} onClick={() => t.albumId && go({ name: 'album', id: t.albumId })}>
          {t.album}
        </span>
      )}
      <span className="dur sub">{t.duration}</span>
      <button className="row-more" onClick={() => menu(t)} aria-label={`More options for ${t.title}`} title="More options">
        <More size={16} />
      </button>
    </div>
  )
})

export function Bars() {
  return (
    <span className="bars">
      <i />
      <i />
      <i />
    </span>
  )
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
