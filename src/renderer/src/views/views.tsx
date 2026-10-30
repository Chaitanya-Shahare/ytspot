import { useEffect, useRef, useState } from 'react'
import type { ArtistPage, Card, Collection, HomeData, PlayerState, Shelf, Track } from '../../../shared/types'
import { CheckCircle, Close, Edit, HeartFill, More, PlusCircle, Search, Shuffle, ViewList } from '../components/icons'
import { cardMenu, queue } from '../components/menus'
import { CardTile, ErrorBox, GreenPlay, Img, Loading, ShelfRow, StickyHead, TrackTable } from '../components/ui'
import { DeletePlaylist, EditDetails, PlaylistExtras } from './playlist'
import { libraryChanged, moreRoute, routeFor, sameRoute, sized, useApp, useCached, useColor } from '../lib'

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
        const current = !!player?.videoId && (c.id === player.videoId || sameRoute(routeFor(c), source?.route))
        const playing = current && !!player?.playing
        return (
          <div key={c.kind + c.id} className={`shortcut ${playing ? 'playing' : ''}`} onClick={() => openCard(c)} onContextMenu={(e) => (e.preventDefault(), cardMenu(c, ctx))}>
            <Img src={sized(c.thumb, 64)} artist={c.kind === 'artist'} />
            <span className={`shortcut-title ${current ? 'green' : ''}`}>{c.title}</span>
            <GreenPlay size={32} playing={playing} onClick={() => (current ? window.ytm.cmd({ type: 'toggle' }) : playCard(c))} />
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
// Signing in or out: the old session's mood chips may not exist in the new one.
export function resetHome(): void {
  homeChip = ''
  homeChips = []
}

export function HomeView() {
  const [chip, setChip] = useState(homeChip)
  const pick = (c: string) => setChip((homeChip = c === chip ? '' : c))
  const { data, error, retry } = useCached<HomeData>(`home:${chip}`, () => window.ytm.home(chip || undefined), { persist: !chip })
  if (data?.chips.length) homeChips = data.chips
  const chips = homeChips
  // The chip row sticks to the top and gets a background once the page scrolls under it.
  const [scrolled, setScrolled] = useState(false)
  const pageRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const scroller = pageRef.current?.closest('.main-scroll')
    if (!scroller) return
    const check = () => setScrolled(scroller.scrollTop > 8)
    check()
    scroller.addEventListener('scroll', check, { passive: true })
    return () => scroller.removeEventListener('scroll', check)
  }, [])
  return (
    <div className="page home" ref={pageRef}>
      {chips.length > 0 && (
        <div className={`chips home-chips ${scrolled ? 'scrolled' : ''}`}>
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

const SORT_ORDERS = ['Custom order', 'Title', 'Artist', 'Album', 'Duration'] as const
type SortOrder = (typeof SORT_ORDERS)[number]

const shuffled = (tracks: Track[]) => tracks[Math.floor(Math.random() * tracks.length)]

// Shuffle play turns shuffle on (Smart Shuffle stays on if it is), so the list shuffles as it loads.
const shuffleOn = (player: PlayerState | null) => player?.shuffle === 'off' && window.ytm.cmd({ type: 'shuffleMode', mode: 'on' })

export function CollectionView({ kind, id }: { kind: 'playlist' | 'album'; id: string }) {
  const { player, playTrack, toast, go, source } = useApp()
  const [dialog, setDialog] = useState<'edit' | 'delete' | null>(null)
  // Spotify's "Search in playlist" and sort ("Custom order" is the playlist's own order).
  const [find, setFind] = useState<string | null>(null)
  const [order, setOrder] = useState<SortOrder>('Custom order')
  const findRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (kind !== 'playlist') return
    // Cmd+F searches the playlist, as in Spotify.
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.key.toLowerCase() !== 'f') return
      e.preventDefault()
      setFind((f) => f ?? '')
      setTimeout(() => findRef.current?.focus())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [kind])
  const actions = useRef<HTMLDivElement>(null)
  const key = `${kind}:${id}`
  const { data, error, set, retry } = useCached<Collection>(
    key,
    () => (kind === 'album' ? window.ytm.album(id) : window.ytm.playlist(id)),
    { revalidate: false }
  )
  const color = useColor(data?.thumb)

  // Stream the rest of a long playlist in after the first page is on screen. Results always land
  // in the cache, so leaving mid-load and coming back resumes where it stopped. Pages are added to
  // the newest data (a row may have been removed meanwhile) and counted by what was fetched.
  const latest = useRef(data)
  latest.current = data
  const [moreFailed, setMoreFailed] = useState(false)
  const loaded = data ? (data.loaded ?? data.tracks.length) : 0
  useEffect(() => {
    if (!data?.more || moreFailed) return
    window.ytm.playlistMore(id, loaded).then(
      (r: { tracks: Track[]; more: boolean }) => {
        const cur = latest.current
        if (cur) set({ ...cur, tracks: [...cur.tracks, ...r.tracks], more: r.more, loaded: loaded + r.tracks.length })
      },
      () => setMoreFailed(true)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.more, loaded, id, moreFailed])

  if (error) return <ErrorBox error={error} onRetry={retry} />
  if (!data) return <Loading kind="collection" />
  // While the rest of a long playlist is still loading, its later songs still count as "from" it.
  const from = { route: { name: kind, id } as const, title: data.title, ids: data.more ? undefined : data.tracks.map((t) => t.videoId) }
  // Playing from this page (not just the same song started somewhere else).
  const isCurrent =
    !!player?.videoId && (source ? sameRoute(source.route, from.route) : data.tracks.some((t) => t.videoId === player.videoId))
  const editable = kind === 'playlist' && !!data.editable
  // What the table shows: matching songs in the chosen order, numbered by their place in the playlist.
  const q = (find ?? '').trim().toLowerCase()
  let rows = data.tracks.map((t, i) => ({ t, n: i + 1 }))
  if (q) rows = rows.filter(({ t }) => `${t.title} ${t.artists} ${t.album ?? ''}`.toLowerCase().includes(q))
  if (order !== 'Custom order') {
    const key = (t: Track) => (order === 'Title' ? t.title : order === 'Artist' ? t.artists : order === 'Album' ? (t.album ?? '') : '')
    const secs = (d: string) => d.split(':').reduce((a, x) => a * 60 + Number(x), 0)
    rows = [...rows].sort((a, b) => (order === 'Duration' ? secs(a.t.duration) - secs(b.t.duration) : key(a.t).localeCompare(key(b.t))))
  }
  const sortMenu = async () => {
    const pick = await window.ytm.popup([
      { id: 'head', label: 'Sort by', enabled: false },
      ...SORT_ORDERS.map((o) => ({ id: o, label: o, checked: o === order }))
    ])
    if (pick && pick !== 'head') setOrder(pick as SortOrder)
  }
  const play = () =>
    isCurrent ? window.ytm.cmd({ type: 'toggle' }) : data.tracks[0] && playTrack(data.tracks[0], data.playlistId, from)
  const shufflePlay = () => {
    const t = shuffled(data.tracks)
    if (!t) return
    shuffleOn(player)
    playTrack(t, data.playlistId, from)
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
  // Spotify's +/✓: save the album or someone else's playlist to Your Library (on YouTube Music).
  const saveToggle = async () => {
    if (!data.saveId) return
    const on = !data.saved
    set({ ...data, saved: on })
    try {
      await window.ytm.saveToLibrary(data.saveId, on)
      libraryChanged()
      toast(on ? 'Added to Your Library' : 'Removed from Your Library')
    } catch {
      set({ ...data, saved: !on })
      toast('That didn’t work — try again')
    }
  }
  const more = async () => {
    const pick = await window.ytm.popup([
      { id: 'play', label: 'Play' },
      { id: 'shuffle', label: 'Shuffle play' },
      { id: 'next', label: 'Play next' },
      { id: 'queue', label: 'Add to queue' },
      ...(editable
        ? [
            { id: '-', label: '-' },
            { id: 'edit', label: 'Edit details' },
            { id: 'delete', label: 'Delete' }
          ]
        : []),
      { id: '-', label: '-' },
      { id: 'share', label: 'Share', submenu: [{ id: 'copy', label: `Copy link to ${kind === 'album' ? 'Album' : 'playlist'}` }] },
      { id: 'open', label: 'Open in YouTube Music' }
    ])
    if (pick === 'edit' || pick === 'delete') setDialog(pick)
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
        {id === 'LM' || id === 'VLLM' ? (
          <div className="hero-art liked-art">
            <HeartFill size={64} />
          </div>
        ) : editable ? (
          <button className="hero-art hero-edit" onClick={() => setDialog('edit')} aria-label="Edit details" title="Edit details">
            <Img src={data.thumb} className="hero-art" />
            <span className="hero-edit-hover">
              <Edit size={48} />
              <span>Choose photo</span>
            </span>
          </button>
        ) : (
          <Img src={data.thumb} className="hero-art" />
        )}
        <div className="hero-text">
          <span className="hero-kind">{heroKind}</span>
          <h1
            className={`hero-title ${editable ? 'clickable' : ''} ${data.title.length > 40 ? 'longer' : data.title.length > 22 ? 'long' : ''}`}
            onClick={() => editable && setDialog('edit')}
          >
            {data.title}
          </h1>
          {data.description && <p className="hero-desc sub">{data.description}</p>}
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
        {data.saved !== undefined && data.saveId && (
          <button
            className={`icon-btn big ${data.saved ? 'green' : ''}`}
            aria-label={data.saved ? 'Remove from Your Library' : 'Save to Your Library'}
            title={data.saved ? 'Remove from Your Library' : 'Save to Your Library'}
            onClick={saveToggle}
          >
            {data.saved ? <CheckCircle size={28} /> : <PlusCircle size={28} />}
          </button>
        )}
        <button className="icon-btn big" aria-label="More options" title="More options" onClick={more}>
          <More size={24} />
        </button>
        {kind === 'playlist' && data.tracks.length > 0 && (
          <div className="pl-tools">
            {find === null ? (
              <button className="icon-btn pl-find-btn" onClick={() => setFind('')} aria-label="Search in playlist" title="Search in playlist">
                <Search size={16} />
              </button>
            ) : (
              <label className="pl-find">
                <Search size={16} />
                <input
                  ref={findRef}
                  autoFocus
                  placeholder="Search in playlist"
                  value={find}
                  onChange={(e) => setFind(e.target.value)}
                  onBlur={() => !find && setFind(null)}
                  onKeyDown={(e) => e.key === 'Escape' && (setFind(null), e.currentTarget.blur())}
                />
                {find && (
                  <button className="pl-find-clear" onMouseDown={(e) => e.preventDefault()} onClick={() => (setFind(''), findRef.current?.focus())} aria-label="Clear search" title="Clear search">
                    <Close size={14} />
                  </button>
                )}
              </label>
            )}
            <button className="lib-sort" onClick={sortMenu} title="Sort">
              {order} <ViewList size={16} />
            </button>
          </div>
        )}
      </div>
      {q && !rows.length && (
        <div className="pl-none">
          <b>Couldn’t find “{find?.trim()}”</b>
          <span className="sub">Try searching again using a different spelling or keyword.</span>
        </div>
      )}
      {rows.length > 0 && <TrackTable
        tracks={q || order !== 'Custom order' ? rows.map((r) => r.t) : data.tracks}
        nums={q || order !== 'Custom order' ? rows.map((r) => r.n) : undefined}
        playlistId={data.playlistId}
        from={from}
        editable={
          editable
            ? {
                id,
                onRemoved: (v) => {
                  const cur = latest.current ?? data
                  set({ ...cur, loaded: cur.loaded ?? cur.tracks.length, tracks: cur.tracks.filter((t) => t.videoId !== v) })
                }
              }
            : undefined
        }
        showAlbum={kind === 'playlist' && data.tracks.some((t) => t.album)}
      />}
      {data.more && !moreFailed && <div className="loading">Loading more songs…</div>}
      {data.more && moreFailed && (
        <div className="loading">
          Couldn’t load the rest of this playlist.{' '}
          <button className="link-btn" onClick={() => setMoreFailed(false)}>
            Try again
          </button>
        </div>
      )}
      {!editable && !data.tracks.length && !data.more && (
        <div className="empty-collection">
          <h2>Nothing to play here yet</h2>
        </div>
      )}
      {editable && !data.more && !q && <PlaylistExtras key={id} data={data} />}
      {dialog === 'edit' && <EditDetails data={data} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && <DeletePlaylist data={data} onClose={() => setDialog(null)} />}
    </div>
  )
}

export function ArtistView({ id }: { id: string }) {
  const { playTrack, player, toast, go, source } = useApp()
  const actions = useRef<HTMLDivElement>(null)
  const { data, error, retry, set } = useCached<ArtistPage>(`artist:${id}`, () => window.ytm.artist(id), { revalidate: false })
  const color = useColor(data?.thumb)
  const [aboutOpen, setAboutOpen] = useState(false)
  if (error) return <ErrorBox error={error} onRetry={retry} />
  if (!data) return <Loading kind="artist" />
  // Playing an artist plays their top songs as a list, like Spotify.
  const list = data.songsMore?.browseId.replace(/^VL/, '')
  const from = { route: { name: 'artist', id } as const, title: data.title, ids: data.songs.map((t) => t.videoId) }
  const isCurrent =
    !!player?.videoId && (source ? sameRoute(source.route, from.route) : data.songs.some((t) => t.videoId === player.videoId))
  const play = () => (isCurrent ? window.ytm.cmd({ type: 'toggle' }) : data.songs[0] && playTrack(data.songs[0], list, from))
  const shufflePlay = () => {
    const t = shuffled(data.songs)
    if (!t) return
    shuffleOn(player)
    playTrack(t, list, from)
    toast('Shuffling ' + data.title)
  }
  const follow = async () => {
    if (!(await window.ytm.authStatus())) return window.ytm.login()
    const on = !data.subscribed
    set({ ...data, subscribed: on })
    window.ytm.subscribe(id, on).then(
      () => (libraryChanged(), toast(on ? `Following ${data.title}` : `Unfollowed ${data.title}`)),
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
