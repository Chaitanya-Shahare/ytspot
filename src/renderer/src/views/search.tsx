import { useEffect, useRef, useState } from 'react'
import type { SearchFilter, SearchResult, Shelf } from '../../../shared/types'
import { Close, More } from '../components/icons'
import { cardMenu } from '../components/menus'
import { CardTile, ErrorBox, GreenPlay, Loading, ShelfRow, TrackTable } from '../components/ui'
import { sized, useApp, useCached } from '../lib'

const FILTERS: [SearchFilter, string][] = [
  ['all', 'All'],
  ['song', 'Songs'],
  ['video', 'Videos'],
  ['album', 'Albums'],
  ['artist', 'Artists'],
  ['playlist', 'Playlists']
]

// Spotify's Browse tiles are bright solid colours; YTM doesn't send any, so pick from a palette.
const TILE_COLORS = ['#dc148c', '#006450', '#8400e7', '#1e3264', '#e8115b', '#27856a', '#509bf5', '#ba5d07', '#e13300', '#7358ff', '#148a08', '#bc5900', '#477d95', '#af2896', '#0d73ec', '#8d67ab']
const colorFor = (s: string) => TILE_COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % TILE_COLORS.length]

const RECENT_KEY = 'recent-searches'
const loadRecent = (): string[] => JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
const saveRecent = (list: string[]) => localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10)))

export function SearchView({ q }: { q: string }) {
  const query = q.trim()
  const [filter, setFilter] = useState<SearchFilter>('all')
  if (!query) return <BrowseAll />
  return (
    <div className="page search">
      <div className="chips search-chips">
        {FILTERS.map(([f, label]) => (
          <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
            {label}
          </button>
        ))}
      </div>
      <Results query={query} filter={filter} />
    </div>
  )
}

function Results({ query, filter }: { query: string; filter: SearchFilter }) {
  const ctx = useApp()
  const { playTrack, openCard, playCard } = ctx
  const { data, error, retry } = useCached<SearchResult>(`search:${filter}:${query}`, () => window.ytm.search(query, filter))
  // Keep the previous results on screen (dimmed) while the next query loads, like Spotify.
  const last = useRef<SearchResult | undefined>(undefined)
  if (data) last.current = data
  const shown = data ?? last.current

  // Remember queries the user actually looked at.
  useEffect(() => {
    if (!data || query.length < 2) return
    const t = setTimeout(() => saveRecent([query, ...loadRecent().filter((r) => r.toLowerCase() !== query.toLowerCase())]), 1500)
    return () => clearTimeout(t)
  }, [data, query])

  if (error && !shown) return <ErrorBox error={error} onRetry={retry} />
  if (!shown) return <Loading kind="search" />
  const top = shown.top
  const cards = shown.shelves.flatMap((s) => s.cards)
  return (
    <div className={data ? '' : 'stale'}>
      {filter === 'all' ? (
        <>
          <div className="search-top">
            {top && (
              <section className="top-result">
                <h2>Top result</h2>
                <div
                  className="top-card"
                  onClick={() =>
                    top.kind === 'song' || top.kind === 'video'
                      ? playTrack({ videoId: top.id, title: top.title, artists: top.subtitle, duration: '', thumb: top.thumb })
                      : openCard(top)
                  }
                  onContextMenu={(e) => (e.preventDefault(), cardMenu(top, ctx))}
                >
                  <button
                    className="top-more"
                    onClick={(e) => (e.stopPropagation(), cardMenu(top, ctx))}
                    aria-label={`More options for ${top.title}`}
                    title="More options"
                  >
                    <More size={24} />
                  </button>
                  <img src={sized(top.thumb, 92)} className={top.kind === 'artist' ? 'round' : ''} />
                  <div className="top-title">{top.title}</div>
                  <div className="sub">{top.subtitle}</div>
                  <GreenPlay
                    onClick={() =>
                      top.kind === 'song' || top.kind === 'video'
                        ? playTrack({ videoId: top.id, title: top.title, artists: top.subtitle, duration: '', thumb: top.thumb })
                        : playCard(top)
                    }
                  />
                </div>
              </section>
            )}
            {shown.songs.length > 0 && (
              <section className="top-songs">
                <h2>Songs</h2>
                <TrackTable tracks={shown.songs.slice(0, 4)} showAlbum={false} showHeader={false} />
              </section>
            )}
          </div>
          {shown.shelves.map((s: Shelf, i) => (
            <ShelfRow key={s.title + i} shelf={s} />
          ))}
        </>
      ) : filter === 'song' || filter === 'video' ? (
        <TrackTable tracks={shown.songs} showAlbum={filter === 'song'} />
      ) : (
        <div className="card-grid">
          {cards.map((c) => (
            <CardTile key={c.kind + c.id} card={c} />
          ))}
        </div>
      )}
      {!top && !shown.songs.length && !cards.length && (
        <div className="empty-search">
          <h2>No results found for “{query}”</h2>
          <p className="sub">Check the spelling, or try fewer or different keywords.</p>
        </div>
      )}
    </div>
  )
}

function BrowseAll() {
  const { go } = useApp()
  const [recent, setRecent] = useState(loadRecent)
  const { data, error, retry } = useCached<{ title: string; tiles: { title: string; params: string }[] }[]>(
    'moods',
    () => window.ytm.moods(),
    { persist: true }
  )
  const remove = (r: string) => {
    const next = recent.filter((x) => x !== r)
    saveRecent(next)
    setRecent(next)
  }
  return (
    <div className="page search">
      {recent.length > 0 && (
        <section className="recent">
          <div className="shelf-head">
            <h2>Recent searches</h2>
            <button className="link-btn" onClick={() => (saveRecent([]), setRecent([]))}>
              Clear
            </button>
          </div>
          <div className="recent-list">
            {recent.map((r) => (
              <span key={r} className="recent-chip" onClick={() => go({ name: 'search', q: r })}>
                {r}
                <button aria-label={`Remove ${r}`} onClick={(e) => (e.stopPropagation(), remove(r))}>
                  <Close size={10} />
                </button>
              </span>
            ))}
          </div>
        </section>
      )}
      {error && !data && <ErrorBox error={error} onRetry={retry} />}
      {!data && !error && <Loading kind="rows" />}
      {data?.map((group) => (
        <section key={group.title} className="browse">
          <h2 className="section-title">{group.title}</h2>
          <div className="tile-grid">
            {group.tiles.map((t) => (
              <button
                key={t.params}
                className="tile"
                style={{ background: colorFor(t.title) }}
                onClick={() => go({ name: 'mood', params: t.params, title: t.title })}
              >
                {t.title}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export function MoodView({ params, title }: { params: string; title: string }) {
  const { data, error, retry } = useCached<Shelf[]>(`mood:${params}`, () => window.ytm.mood(params), { revalidate: false })
  if (error) return <ErrorBox error={error} onRetry={retry} />
  if (!data) return <Loading />
  return (
    <div className="page" style={{ '--tint': colorFor(title) } as React.CSSProperties}>
      <h1 className="mood-title">{title}</h1>
      {data.map((s, i) => (
        <ShelfRow key={s.title + i} shelf={s} />
      ))}
    </div>
  )
}
