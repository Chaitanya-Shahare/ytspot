import { useEffect, useState } from 'react'
import type { ArtistPage, Collection, HomeData, Shelf, Track } from '../../../shared/types'
import { More, Shuffle } from '../components/icons'
import { queue } from '../components/menus'
import { ErrorBox, GreenPlay, Loading, ShelfRow, TrackTable } from '../components/ui'
import { sized, useApp, useCached, useColor } from '../lib'

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
        data.shelves.map((s, i) => <ShelfRow key={chip + s.title + i} shelf={s} />)
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

export function CollectionView({ kind, id }: { kind: 'playlist' | 'album'; id: string }) {
  const { player, playTrack, toast } = useApp()
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
  const isCurrent = !!player && data.tracks.some((t) => t.videoId === player.videoId)
  const play = () =>
    isCurrent ? window.ytm.cmd({ type: 'toggle' }) : data.tracks[0] && playTrack(data.tracks[0], data.playlistId)
  const shufflePlay = () => {
    const t = shuffled(data.tracks)
    if (!t) return
    playTrack(t, data.playlistId)
    // YTM shuffles its queue once the new list has loaded.
    setTimeout(() => window.ytm.cmd({ type: 'shuffle' }), 3000)
    toast('Shuffling ' + data.title)
  }
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
      <header className="hero">
        {data.thumb ? <img src={data.thumb} className="hero-art" /> : <div className="hero-art liked-art" />}
        <div className="hero-text">
          <span className="hero-kind">
            {kind === 'album' ? (data.subtitle.match(/\b(Single|EP|Album)\b/)?.[1] ?? 'Album') : 'Playlist'}
          </span>
          <h1 className="hero-title">{data.title}</h1>
          <div className="hero-meta">
            {data.subtitle && <b>{data.subtitle}</b>}
            {data.meta && <span> • {data.meta}</span>}
          </div>
        </div>
      </header>
      <div className="action-bar">
        <GreenPlay size={56} playing={isCurrent && player?.playing} onClick={play} />
        <button className="icon-btn big" aria-label="Shuffle play" title="Shuffle play" onClick={shufflePlay}>
          <Shuffle size={28} />
        </button>
        <button className="icon-btn big" aria-label="More options" title="More options" onClick={more}>
          <More size={24} />
        </button>
      </div>
      <TrackTable tracks={data.tracks} playlistId={data.playlistId} showAlbum={kind === 'playlist'} />
      {data.more && <div className="loading">Loading more songs…</div>}
    </div>
  )
}

export function ArtistView({ id }: { id: string }) {
  const { playTrack } = useApp()
  const { data, error, retry } = useCached<ArtistPage>(`artist:${id}`, () => window.ytm.artist(id), { revalidate: false })
  const color = useColor(data?.thumb)
  if (error) return <ErrorBox error={error} onRetry={retry} />
  if (!data) return <Loading kind="artist" />
  return (
    <div className="page artist" style={{ '--tint': color } as React.CSSProperties}>
      <header className="artist-hero" style={{ backgroundImage: `url(${data.thumb})` }}>
        <h1 className="hero-title">{data.title}</h1>
      </header>
      <div className="action-bar">
        <GreenPlay size={56} onClick={() => data.songs[0] && playTrack(data.songs[0])} />
      </div>
      {data.songs.length > 0 && (
        <section>
          <h2 className="section-title">Popular</h2>
          <TrackTable tracks={data.songs.slice(0, 10)} showAlbum={false} showHeader={false} />
        </section>
      )}
      {data.shelves.map((s, i) => (
        <ShelfRow key={s.title + i} shelf={s} />
      ))}
    </div>
  )
}
