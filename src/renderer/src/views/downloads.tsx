import { useRef } from 'react'
import type { Track } from '../../../shared/types'
import { Download, Downloaded, More, Shuffle } from '../components/icons'
import { downloadSongs, removeDownloads } from '../components/menus'
import { GreenPlay, StickyHead, TrackTable } from '../components/ui'
import { downloadsSource, sameRoute, useApp, useDownloads } from '../lib'

// "48 MB", "1.2 GB"
export const megabytes = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`)

// Everything saved for offline listening, newest first. Plays from disk, so it works offline.
export function DownloadsView() {
  const ctx = useApp()
  const { player, playTrack, source, toast } = ctx
  const { songs, queue } = useDownloads()
  const actions = useRef<HTMLDivElement>(null)
  const from = downloadsSource(songs.map((d) => d.videoId))
  const isCurrent = !!player?.videoId && sameRoute(source?.route, from.route)
  const play = () => (isCurrent ? window.ytm.cmd({ type: 'toggle' }) : songs[0] && playTrack(songs[0], undefined, from))
  const shufflePlay = async () => {
    const t = songs[Math.floor(Math.random() * songs.length)]
    if (!t) return
    await playTrack(t, undefined, from)
    await window.ytm.cmd({ type: 'shuffleMode', mode: 'on' })
    toast('Shuffling Downloaded')
  }
  const bytes = songs.reduce((n, d) => n + d.bytes, 0)
  const pending = queue.length ? queue.reduce((n, q) => n + q.progress, 0) / queue.length : 0
  const more = async () => {
    const pick = await window.ytm.popup([
      { id: 'play', label: 'Play', enabled: songs.length > 0 },
      { id: 'shuffle', label: 'Shuffle play', enabled: songs.length > 0 },
      { id: '-', label: '-' },
      { id: 'remove', label: 'Remove all downloads', enabled: songs.length > 0 }
    ])
    if (pick === 'play') play()
    if (pick === 'shuffle') shufflePlay()
    if (pick === 'remove' && confirm(`Remove all ${songs.length} downloaded songs from this Mac? You can download them again later.`))
      removeDownloads(ctx, songs.map((d) => d.videoId))
  }
  return (
    <div className="page collection downloads" style={{ '--tint': 'rgb(16,92,52)' } as React.CSSProperties}>
      <StickyHead title="Downloaded" playing={isCurrent && player?.playing} onPlay={play} anchor={actions} />
      <header className="hero">
        <div className="hero-art downloads-art">
          <Downloaded size={64} />
        </div>
        <div className="hero-text">
          <span className="hero-kind">Playlist</span>
          <h1 className="hero-title">Downloaded</h1>
          <p className="hero-desc sub">Songs saved on this Mac. They play without an internet connection.</p>
          <div className="hero-meta">
            <b>ytspot</b>
            {songs.length > 0 && <span> • {songs.length} {songs.length === 1 ? 'song' : 'songs'}, {megabytes(bytes)}</span>}
          </div>
        </div>
      </header>
      <div className="action-bar" ref={actions}>
        <GreenPlay size={56} playing={isCurrent && player?.playing} onClick={play} />
        <button className="icon-btn big" aria-label="Shuffle play" title="Shuffle play" onClick={shufflePlay} disabled={!songs.length}>
          <Shuffle size={28} />
        </button>
        <button className="icon-btn big" aria-label="More options" title="More options" onClick={more}>
          <More size={24} />
        </button>
      </div>
      {queue.length > 0 && (
        <p className="sub downloading-note">
          Downloading {queue.length} {queue.length === 1 ? 'song' : 'songs'}… {Math.round(pending * 100)}%
        </p>
      )}
      {songs.length > 0 ? (
        <TrackTable tracks={songs} from={from} showAlbum={songs.some((d) => d.album)} />
      ) : (
        !queue.length && (
          <div className="empty-collection">
            <h2>Songs you download will appear here</h2>
            <p className="sub">Choose Download in a song’s ⋯ menu, or press the download button on an album or playlist.</p>
          </div>
        )
      )}
    </div>
  )
}

// Spotify's download button on an album or playlist: downloads every song, shows how far along it
// is, and once they're all saved turns green and offers to remove them again.
export function DownloadButton({ tracks, title, loading }: { tracks: Track[]; title: string; loading?: boolean }) {
  const ctx = useApp()
  const { ids, progress } = useDownloads()
  const saved = tracks.filter((t) => ids.has(t.videoId)).length
  const busy = tracks.some((t) => progress.has(t.videoId))
  const all = saved === tracks.length
  // Songs done, plus how far the ones in progress have got.
  const done = (saved + tracks.reduce((n, t) => n + (progress.get(t.videoId) ?? 0), 0)) / tracks.length
  const label = all ? 'Remove from Downloads' : busy ? 'Downloading…' : loading ? 'Loading songs…' : 'Download'
  const click = () => {
    if (all) {
      if (confirm(`Remove “${title}” from Downloads? Its songs will no longer play offline.`)) removeDownloads(ctx, tracks.map((t) => t.videoId))
    } else if (!busy) downloadSongs(ctx, tracks, title)
  }
  return (
    <button
      className={`icon-btn big download-btn ${all ? 'green' : ''} ${busy ? 'busy' : ''}`}
      style={busy ? ({ '--done': done } as React.CSSProperties) : undefined}
      aria-label={label}
      title={label}
      disabled={!all && !busy && loading}
      onClick={click}
    >
      {all ? <Downloaded size={28} /> : <Download size={28} />}
    </button>
  )
}
