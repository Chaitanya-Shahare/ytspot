import { useEffect, useRef, useState } from 'react'
import type { ArtistPage, Card, Collection, HomeData, Shelf, Track } from '../../../shared/types'
import { More, Shuffle } from '../components/icons'
import { cardMenu, queue } from '../components/menus'
import { CardTile, ErrorBox, GreenPlay, Loading, ShelfRow, StickyHead, TrackTable } from '../components/ui'
import { moreRoute, routeFor, sameRoute, sized, useApp, useCached, useColor } from '../lib'

// "55 songs • 3 hours, 9 minutes" -> "55 songs, 3 hr 9 min", as Spotify writes it.
const spotifyMeta = (m: string) =>
  m
    .replace(' • ', ', ')
    .replace(/(\d+) hours?,?/, '$1 hr')
    .replace(/(\d+) minutes?,?/, '$1 min')
    .replace(/(\d+) seconds?/, '$1 sec')

function Shortcuts({ cards }: { cards: Card[] }) {
  const ctx = useApp()
  const { openCard, playCard, player, source } = ctx
  return (
    <div className="shortcuts">
      {cards.map((c) => {
        const playing = !!player?.playing && (c.id === player.videoId || sameRoute(routeFor(c), source?.route))
        return (
          <div key={c.kind + c.id} className={`shortcut ${playing ? 'playing' : ''}`} onClick={() => openCard(c)} onContextMenu={(e) => (e.preventDefault(), cardMenu(c, ctx))}>
            <img src={sized(c.thumb, 64)} className={c.kind === 'artist' ? 'round' : ''} />
            <span className="shortcut-title">{c.title}</span>
            <GreenPlay size={32} playing={playing} onClick={() => (playing ? window.ytm.cmd({ type: 'toggle' }) : playCard(c))} />
          </div>
        )
      })}
    </div>
  )
}

// The chip picked on Home, kept while browsing elsewhere so Back returns to the same mood, and
// the chip list, kept so it stays on screen while a mood's shelves load.
let homeChip = ''
let homeChips: string[] = []

export function HomeView() {
  const [chip, setChip] = useState(homeChip)
  const pick = (c: string) => setChip((homeChip = c === chip ? '' : c))
  const { data, error, retry } = useCached<HomeData>(`home:${chip}`, () => window.ytm.home(chip || undefined), { persist: !chip })
  if (data?.chips.length) homeChips = data.chips
  const chips = homeChips
  return (
    <div className="page home">
      {chips.length > 0 && (
        <div className="chips home-chips">
          <button className={`chip ${chip ? '' : 'on'}`} onClick={() => pick('')}>
            All
          </button>
          {chips.map((c) => (
            <button key={c} className={`chip ${chip === c ? 'on' : ''}`} onClick={() => pick(c)}>
              {c}
            </button>
          ))}
        </div>
      )}
      {error && !data ? (
        <ErrorBox error={error} onRetry={retry} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          {/* Spotify opens Home with a compact grid of shortcuts; the first shelf fills it. */}
          {!chip && data.shelves[0] && <Shortcuts cards={data.shelves[0].cards.slice(0, 8)} />}
          {data.shelves.slice(chip ? 0 : 1).map((s, i) => (
            <ShelfRow key={chip + s.title + i} shelf={s} />
          ))}
        </>
      )}
    </div>
  )
}

export function ExploreView() {
  const { data, error, retry } = useCached<Shelf[]>('explore', () => window.ytm.explore(), { persist: true })
  if (error) return <ErrorBox error={error} onRetry={retry} />
  if (!data) return <Loading />
  return (
    <div className="page home">
      <h1 className="page-title">Explore</h1>
      {data.map((s, i) => (
        <ShelfRow key={s.title + i} shelf={s} />
      ))}
    </div>
  )
}

const shuffled = (tracks: Track[]) => tracks[Math.floor(Math.random() * tracks.length)]

// YTM can only shuffle a queue once it has loaded, so wait for the picked song to be playing with
// its list behind it. If something else starts first (the user moved on), leave that alone.
async function shuffleWhenLoaded(videoId: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const s = await window.ytm.state()
    if (s?.videoId === videoId && s.queue.length > 1) return void window.ytm.cmd({ type: 'shuffle' })
  }
}

export function CollectionView({ kind, id }: { kind: 'playlist' | 'album'; id: string }) {
  const { player, playTrack, toast, go } = useApp()
  const actions = useRef<HTMLDivElement>(null)
  const key = `${kind}:${id}`
  const { data, error, set, retry } = useCached<Collection>(
    key,
    () => (kind === 'album' ? window.ytm.album(id) : window.ytm.playlist(id)),
    { revalidate: false }
  )
  const color = useColor(data?.thumb)

  // Stream the rest of a long playlist in after the first page is on screen. Results always land
  // in the cache, so leaving mid-load and coming back resumes where it stopped.
  useEffect(() => {
    if (!data?.more) return
    window.ytm
      .playlistMore(id, data.tracks.length)
      .then((r: { tracks: Track[]; more: boolean }) => set({ ...data, tracks: [...data.tracks, ...r.tracks], more: r.more }))
      .catch(() => set({ ...data, more: false }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, id])

  if (error) return <ErrorBox error={error} onRetry={retry} />
  if (!data) return <Loading kind="collection" />
  const from = { route: { name: kind, id } as const, title: data.title }
  const isCurrent = !!player && data.tracks.some((t) => t.videoId === player.videoId)
  const play = () =>
    isCurrent ? window.ytm.cmd({ type: 'toggle' }) : data.tracks[0] && playTrack(data.tracks[0], data.playlistId, from)
  const shufflePlay = () => {
    const t = shuffled(data.tracks)
    if (!t) return
    playTrack(t, data.playlistId, from)
    shuffleWhenLoaded(t.videoId)
    toast('Shuffling ' + data.title)
  }
  // YTM's subtitle is "Album • 2016" / "Playlist • Public • 2024": the first part names the kind.
  const parts = data.subtitle.split(' • ').filter(Boolean)
  const heroKind = kind === 'album' ? (parts[0]?.match(/\b(Single|EP|Album)\b/)?.[1] ?? 'Album') : 'Playlist'
  const details = (/^(Single|EP|Album|Playlist)$/i.test(parts[0] ?? '') ? parts.slice(1) : parts).join(' • ')
  const url =
    kind === 'album'
      ? `https://music.youtube.com/browse/${id}`
      : `https://music.youtube.com/playlist?list=${data.playlistId}`
  const more = async () => {
    const pick = await window.ytm.popup([
      { id: 'play', label: 'Play' },
      { id: 'shuffle', label: 'Shuffle play' },
      { id: 'next', label: 'Play next' },
      { id: 'queue', label: 'Add to queue' },
      { id: '-', label: '-' },
      { id: 'copy', label: 'Copy link' },
      { id: 'open', label: 'Open in YouTube Music' }
    ])
    if (pick === 'play') play()
    if (pick === 'shuffle') shufflePlay()
    if (pick === 'next' || pick === 'queue')
      queue(data.tracks.map((t) => t.videoId), pick === 'next').then(() => toast(pick === 'next' ? 'Playing next' : 'Added to queue'))
    if (pick === 'copy') window.ytm.copy(url).then(() => toast('Link copied to clipboard'))
    if (pick === 'open') window.ytm.open(url)
  }
  return (
    <div className="page collection" style={{ '--tint': color } as React.CSSProperties}>
      <StickyHead title={data.title} playing={isCurrent && player?.playing} onPlay={play} anchor={actions} />
      <header className="hero">
        {data.thumb ? <img src={data.thumb} className="hero-art" /> : <div className="hero-art liked-art" />}
        <div className="hero-text">
          <span className="hero-kind">{heroKind}</span>
          <h1 className="hero-title">{data.title}</h1>
          <div className="hero-meta">
            {[
              data.owner && (
                <b
                  key="owner"
                  className={data.ownerId ? 'link' : ''}
                  onClick={() => data.ownerId && go({ name: data.ownerId.startsWith('UC') ? 'artist' : 'playlist', id: data.ownerId })}
                >
                  {data.owner}
                </b>
              ),
              details && <span key="details">{details}</span>,
              data.meta && <span key="meta" className="hero-meta-sub">{spotifyMeta(data.meta)}</span>
            ]
              .filter(Boolean)
              .flatMap((x, i) => (i ? [<span key={`dot${i}`}> • </span>, x] : [x]))}
          </div>
        </div>
      </header>
      <div className="action-bar" ref={actions}>
        <GreenPlay size={56} playing={isCurrent && player?.playing} onClick={play} />
        <button className="icon-btn big" aria-label="Shuffle play" title="Shuffle play" onClick={shufflePlay}>
          <Shuffle size={28} />
        </button>
        <button className="icon-btn big" aria-label="More options" title="More options" onClick={more}>
          <More size={24} />
        </button>
      </div>
      <TrackTable
        tracks={data.tracks}
        playlistId={data.playlistId}
        from={from}
        editable={kind === 'playlist' ? { id, onRemoved: (v) => set({ ...data, tracks: data.tracks.filter((t) => t.videoId !== v) }) } : undefined}
        showAlbum={kind === 'playlist' && data.tracks.some((t) => t.album)}
      />
      {data.more && <div className="loading">Loading more songs…</div>}
      {!data.tracks.length && !data.more && (
        <div className="empty-collection">
          <h2>{kind === 'playlist' ? 'Let’s find something for your playlist' : 'Nothing to play here yet'}</h2>
          {kind === 'playlist' && (
            <button className="pill-btn" onClick={() => go({ name: 'search', q: '' })}>
              Search for songs
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function ArtistView({ id }: { id: string }) {
  const { playTrack, player, toast, go } = useApp()
  const actions = useRef<HTMLDivElement>(null)
  const { data, error, retry, set } = useCached<ArtistPage>(`artist:${id}`, () => window.ytm.artist(id), { revalidate: false })
  const color = useColor(data?.thumb)
  const [aboutOpen, setAboutOpen] = useState(false)
  if (error) return <ErrorBox error={error} onRetry={retry} />
  if (!data) return <Loading kind="artist" />
  // Playing an artist plays their top songs as a list, like Spotify.
  const list = data.songsMore?.browseId.replace(/^VL/, '')
  const from = { route: { name: 'artist', id } as const, title: data.title }
  const isCurrent = !!player && data.songs.some((t) => t.videoId === player.videoId)
  const play = () => (isCurrent ? window.ytm.cmd({ type: 'toggle' }) : data.songs[0] && playTrack(data.songs[0], list, from))
  const shufflePlay = () => {
    const t = shuffled(data.songs)
    if (!t) return
    playTrack(t, list, from)
    shuffleWhenLoaded(t.videoId)
    toast('Shuffling ' + data.title)
  }
  const follow = async () => {
    if (!(await window.ytm.authStatus())) return window.ytm.login()
    const on = !data.subscribed
    set({ ...data, subscribed: on })
    window.ytm.subscribe(id, on).then(
      () => toast(on ? `Following ${data.title}` : `Unfollowed ${data.title}`),
      () => (set({ ...data }), toast('That didn’t work — try again'))
    )
  }
  return (
    <div className="page artist" style={{ '--tint': color } as React.CSSProperties}>
      <StickyHead title={data.title} playing={isCurrent && player?.playing} onPlay={play} anchor={actions} />
      <header className="artist-hero" style={{ backgroundImage: `url(${data.thumb})` }}>
        <h1 className="hero-title">{data.title}</h1>
      </header>
      <div className="action-bar" ref={actions}>
        <GreenPlay size={56} playing={isCurrent && player?.playing} onClick={play} />
        <button className="icon-btn big" aria-label="Shuffle play" title={`Shuffle play ${data.title}`} onClick={shufflePlay}>
          <Shuffle size={28} />
        </button>
        <button className={`outline-btn follow ${data.subscribed ? 'on' : ''}`} onClick={follow}>
          {data.subscribed ? 'Following' : 'Follow'}
        </button>
      </div>
      {data.songs.length > 0 && (
        <section>
          <h2 className="section-title">Popular</h2>
          <TrackTable tracks={data.songs.slice(0, 10)} from={from} playlistId={list} showAlbum={false} showPlays showHeader={false} />
          {data.songsMore && (
            <button className="show-all see-more" onClick={() => go(moreRoute(data.songsMore!, `${data.title}: Popular`))}>
              See more
            </button>
          )}
        </section>
      )}
      {data.shelves.map((s, i) => (
        <ShelfRow key={s.title + i} shelf={s} />
      ))}
      {data.description && (
        <section className="about">
          <h2 className="section-title">About</h2>
          <div className="about-card" style={{ backgroundImage: `url(${data.thumb})` }} onClick={() => setAboutOpen((v) => !v)}>
            <p className={aboutOpen ? 'open' : ''}>{data.description}</p>
          </div>
        </section>
      )}
    </div>
  )
}

// A shelf's "Show all": every card in a grid.
export function MoreView({ title, browseId, params }: { title: string; browseId: string; params?: string }) {
  const { data, error, retry } = useCached<Card[]>(`more:${browseId}:${params ?? ''}`, () => window.ytm.browseMore({ browseId, params }), {
    revalidate: false
  })
  if (error) return <ErrorBox error={error} onRetry={retry} />
  if (!data) return <Loading />
  return (
    <div className="page more">
      <h1 className="page-title">{title}</h1>
      {data.length ? (
        <div className="card-grid">
          {data.map((c) => (
            <CardTile key={c.kind + c.id} card={c} />
          ))}
        </div>
      ) : (
        <p className="empty-search">Nothing here yet.</p>
      )}
    </div>
  )
}
