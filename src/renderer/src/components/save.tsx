import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Card } from '../../../shared/types'
import { savablePlaylists, sized, useApp, type SaveSong } from '../lib'
import { CheckCircle, HeartFill, Plus, Search } from './icons'
import { addSong, newPlaylistWith, setLiked } from './menus'
import { Img } from './ui'

// Spotify's "Add to playlist" popover: Liked Songs plus your own playlists, a filter and "New
// playlist". A tick marks where the song is (Liked Songs, and playlists it was added to here);
// clicking a ticked playlist takes the song back out.
export function SavePopover({ song, anchor, onClose }: { song: SaveSong; anchor: DOMRect; onClose: () => void }) {
  const ctx = useApp()
  const [lists, setLists] = useState<Card[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [find, setFind] = useState('')
  const [inList, setInList] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const playing = song.videoId === ctx.player?.videoId
  const [likedHere, setLikedHere] = useState(song.liked)
  const liked = playing ? !!ctx.player?.liked : !!likedHere
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    savablePlaylists(song.videoId).then(setLists, () => setFailed(true))
  }, [song.videoId])

  // Close on a click outside or Esc (before the app's own Esc handling sees it).
  useEffect(() => {
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose()
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('mousedown', down)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  // Opens above the button (it lives in the player bar), kept inside the window.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = Math.min(window.innerWidth - w - 8, Math.max(8, anchor.left + anchor.width / 2 - w / 2))
    const below = anchor.top - h - 8 < 8
    setPos({ left, top: below ? Math.min(window.innerHeight - h - 8, anchor.bottom + 8) : anchor.top - h - 8 })
  }, [anchor, lists])

  const toggle = async (pl: Card) => {
    if (busy) return
    setBusy(pl.id)
    if (inList.has(pl.id)) {
      await window.ytm.removeFromPlaylist(pl.id, song.videoId).then(
        () => {
          setInList((s) => new Set([...s].filter((x) => x !== pl.id)))
          ctx.toast(`Removed from ${pl.title}`)
        },
        () => ctx.toast('That didn’t work — try again')
      )
    } else if (await addSong(ctx, pl, song.videoId)) setInList((s) => new Set(s).add(pl.id))
    setBusy(null)
  }
  const toggleLike = () => {
    setLikedHere(!liked)
    setLiked(ctx, song.videoId, !liked)
  }
  const shown = (lists ?? []).filter((p) => p.title.toLowerCase().includes(find.trim().toLowerCase()))
  return (
    <div
      ref={box}
      className="save-pop"
      role="dialog"
      aria-label="Add to playlist"
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
    >
      <div className="save-title">Add to playlist</div>
      <label className="save-find">
        <Search size={14} />
        <input autoFocus placeholder="Find a playlist" value={find} onChange={(e) => setFind(e.target.value)} />
      </label>
      <button className="save-row save-new" onClick={() => (onClose(), newPlaylistWith(ctx, song))}>
        <span className="save-art plus">
          <Plus size={16} />
        </span>
        <span className="save-name">New playlist</span>
      </button>
      <div className="save-list">
        {!find && (
          <button className="save-row" onClick={toggleLike} aria-pressed={liked}>
            <span className="save-art liked-art">
              <HeartFill size={12} />
            </span>
            <span className="save-text">
              <span className="save-name">Liked Songs</span>
            </span>
            <Tick on={liked} />
          </button>
        )}
        {failed && <p className="save-empty">Couldn’t load your playlists.</p>}
        {!lists && !failed && <p className="save-empty">Loading your playlists…</p>}
        {lists && !shown.length && <p className="save-empty">{find ? `No playlists match “${find}”` : 'You haven’t made any playlists yet.'}</p>}
        {shown.map((p) => (
          <button key={p.id} className="save-row" onClick={() => toggle(p)} aria-pressed={inList.has(p.id)} disabled={busy === p.id}>
            <Img src={sized(p.thumb, 32)} className="save-art" />
            <span className="save-text">
              <span className="save-name">{p.title}</span>
              <span className="save-sub">{p.subtitle}</span>
            </span>
            <Tick on={inList.has(p.id)} />
          </button>
        ))}
      </div>
      <div className="save-foot">
        <button className="pill-btn small" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}

function Tick({ on }: { on: boolean }) {
  return on ? <CheckCircle size={16} className="save-tick green" /> : <span className="save-tick empty" />
}
