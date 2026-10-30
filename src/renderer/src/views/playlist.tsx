import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Collection, Privacy, SearchResult, Track } from '../../../shared/types'
import { Close, Edit, Note, Play, PlusCircle, Search } from '../components/icons'
import { addSong } from '../components/menus'
import { Img } from '../components/ui'
import { libraryChanged, playlistChanged, sized, useApp, useCached } from '../lib'

// Songs you can add straight to your playlist (Spotify's "Recommended" and search rows). They use
// the playlist table's own grid, so titles, albums and times line up with the songs above.
function AddRows({ tracks, onAdd, showAlbum, playlist }: { tracks: Track[]; onAdd: (t: Track) => void; showAlbum: boolean; playlist: string }) {
  const { playTrack, go, player } = useApp()
  return (
    <div className={`tracks add-rows ${showAlbum ? '' : 'no-album'}`}>
      {tracks.map((t) => (
        <div key={t.videoId} className={`track-row ${player?.videoId === t.videoId ? 'current' : ''}`} onDoubleClick={() => playTrack(t)}>
          <span className="num">
            <button className="row-play" onClick={() => playTrack(t)} aria-label={`Play ${t.title}`} title="Play">
              <Play size={14} />
            </button>
          </span>
          <span className="title-cell">
            <Img src={sized(t.thumb, 40)} />
            <span className="tt">
              <span className="t1">{t.title}</span>
              <span className={`t2 ${t.artistId ? 'link' : ''}`} onClick={() => t.artistId && go({ name: 'artist', id: t.artistId })}>
                {t.artists}
              </span>
            </span>
          </span>
          {showAlbum && (
            <span className={`sub album-cell ${t.albumId ? 'link' : ''}`} onClick={() => t.albumId && go({ name: 'album', id: t.albumId })}>
              {t.album}
            </span>
          )}
          <span className="dur sub">{t.duration}</span>
          <button className="row-add" onClick={() => onAdd(t)} aria-label={`Add ${t.title} to ${playlist}`} title={`Add to ${playlist}`}>
            <PlusCircle size={16} />
          </button>
        </div>
      ))}
    </div>
  )
}

// Under a playlist you own: a search box to find songs for it ("Let's find something for your
// playlist"), and YTM's suggestions for it, each with an Add button, as in Spotify.
export function PlaylistExtras({ data }: { data: Collection }) {
  const ctx = useApp()
  const empty = !data.tracks.length && !data.more
  const [finding, setFinding] = useState(empty)
  const add = (t: Track) => addSong(ctx, { id: data.id, title: data.title }, t.videoId)
  // Same columns as the table above (an empty playlist has none, so show the album).
  const rows = { showAlbum: empty || data.tracks.some((t) => t.album), playlist: data.title }
  return (
    <>
      {finding ? <FindSongs onAdd={add} rows={rows} onClose={empty ? undefined : () => setFinding(false)} /> : (
        <div className="find-more">
          <button className="link-btn" onClick={() => setFinding(true)}>
            Find more
          </button>
        </div>
      )}
      <Recommended data={data} onAdd={add} rows={rows} />
    </>
  )
}

type RowOpts = { showAlbum: boolean; playlist: string }

function FindSongs({ onAdd, onClose, rows }: { onAdd: (t: Track) => void; onClose?: () => void; rows: RowOpts }) {
  const [q, setQ] = useState('')
  const [res, setRes] = useState<Track[] | null>(null)
  useEffect(() => {
    if (!q.trim()) return setRes(null)
    let live = true
    const t = setTimeout(
      () =>
        window.ytm.search(q.trim(), 'song').then(
          (r: SearchResult) => live && setRes(r.songs),
          () => live && setRes([])
        ),
      300
    )
    return () => ((live = false), clearTimeout(t))
  }, [q])
  return (
    <section className="find-songs">
      <div className="find-head">
        <h2 className="section-title">Let’s find something for your playlist</h2>
        {onClose && (
          <button className="icon-btn big" onClick={onClose} aria-label="Close" title="Close">
            <Close size={20} />
          </button>
        )}
      </div>
      <label className="find-box">
        <Search size={20} />
        <input autoFocus placeholder="Search for songs" value={q} onChange={(e) => setQ(e.target.value)} />
        {q && (
          <button className="search-clear" onClick={() => setQ('')} aria-label="Clear search field" title="Clear search field">
            <Close size={16} />
          </button>
        )}
      </label>
      {res && (res.length ? <AddRows tracks={res} onAdd={onAdd} {...rows} /> : <p className="sub find-none">No songs found for “{q}”.</p>)}
    </section>
  )
}

function Recommended({ data, onAdd, rows }: { data: Collection; onAdd: (t: Track) => Promise<boolean>; rows: RowOpts }) {
  // Depends on what's in the playlist, so it's fetched again whenever the songs change.
  const { data: recs, set } = useCached<Track[]>(`suggest:${data.id}:${data.tracks.length}`, () => window.ytm.playlistSuggestions(data.id), {
    revalidate: false
  })
  const [busy, setBusy] = useState(false)
  if (!recs?.length) return null
  const have = new Set(data.tracks.map((t) => t.videoId))
  const shown = recs.filter((t) => !have.has(t.videoId))
  const refresh = () => {
    setBusy(true)
    window.ytm
      .playlistSuggestions(data.id, true)
      .then(set, () => undefined)
      .finally(() => setBusy(false))
  }
  return (
    <section className="recommended">
      <h2 className="section-title">Recommended</h2>
      <p className="sub">Based on what’s in this playlist</p>
      <AddRows tracks={shown} {...rows} onAdd={(t) => onAdd(t).then((ok) => ok && set(recs.filter((r) => r.videoId !== t.videoId)))} />
      <div className="recommended-foot">
        <button className="link-btn" onClick={refresh} disabled={busy}>
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </section>
  )
}

const PRIVACY: { value: Privacy; label: string; hint: string }[] = [
  { value: 'PUBLIC', label: 'Public', hint: 'Anyone can search for and view' },
  { value: 'UNLISTED', label: 'Unlisted', hint: 'Anyone with the link can view' },
  { value: 'PRIVATE', label: 'Private', hint: 'Only you can view' }
]

// A picked photo, centre-cropped to a square no bigger than YTM keeps (and at least its 360px).
async function squareJpeg(file: File): Promise<{ base64: string; mime: string; preview: string }> {
  const img = await createImageBitmap(file)
  const side = Math.min(img.width, img.height)
  if (side < 360) throw new Error('Pick an image at least 360 × 360 pixels')
  const out = Math.min(side, 1200)
  const c = document.createElement('canvas')
  c.width = c.height = out
  c.getContext('2d')!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, out, out)
  const preview = c.toDataURL('image/jpeg', 0.92)
  return { base64: preview.split(',')[1], mime: 'image/jpeg', preview }
}

// Spotify's "Edit details": cover, name and description (plus YTM's privacy), saved to YouTube Music.
export function EditDetails({ data, onClose }: { data: Collection; onClose: () => void }) {
  const { toast } = useApp()
  const [title, setTitle] = useState(data.title)
  const [description, setDescription] = useState(data.description ?? '')
  const [privacy, setPrivacy] = useState<Privacy>(data.privacy ?? 'PRIVATE')
  const [cover, setCover] = useState<{ base64: string; mime: string; preview: string } | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const pick = async (f?: File) => {
    if (!f) return
    if (f.size > 15 * 1024 * 1024) return setError('Pick an image that’s 15 MB or smaller')
    try {
      setCover(await squareJpeg(f))
      setError('')
    } catch (e) {
      setError((e as Error).message || 'Couldn’t read that image')
    }
  }
  const save = async () => {
    if (!title.trim()) return setError('Playlist name is required.')
    setSaving(true)
    setError('')
    try {
      const edit = {
        ...(title.trim() !== data.title ? { title: title.trim() } : {}),
        ...(description !== (data.description ?? '') ? { description } : {}),
        ...(privacy !== data.privacy ? { privacy } : {})
      }
      await window.ytm.updatePlaylist(data.id, edit)
      if (cover) await window.ytm.setPlaylistCover(data.id, { base64: cover.base64, mime: cover.mime })
      playlistChanged(data.id)
      libraryChanged()
      onClose()
      toast('Playlist updated')
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || 'That didn’t work — try again')
      setSaving(false)
    }
  }
  // On <body>, so it covers the side panels too (the main view is its own stacking context).
  return createPortal(
    <div className="modal-bg" onMouseDown={onClose}>
      <form
        className="modal edit-details"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => (e.preventDefault(), save())}
        onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}
      >
        <div className="modal-head">
          <h1>Edit details</h1>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
            <Close />
          </button>
        </div>
        <div className="edit-body">
          <button type="button" className="edit-cover" onClick={() => file.current?.click()} aria-label="Choose photo">
            {cover ? <img src={cover.preview} alt="" /> : data.thumb ? <Img src={data.thumb} /> : <span className="edit-cover-empty"><Note size={48} /></span>}
            <span className="edit-cover-hover">
              <Edit size={40} />
              <span>Choose photo</span>
            </span>
          </button>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => pick(e.target.files?.[0])} />
          <div className="edit-fields">
            <label className="field">
              <span>Name</span>
              <input autoFocus value={title} maxLength={150} onChange={(e) => setTitle(e.target.value)} placeholder="Add a name" />
            </label>
            <label className="field grow">
              <span>Description</span>
              <textarea value={description} maxLength={5000} onChange={(e) => setDescription(e.target.value)} placeholder="Add an optional description" />
            </label>
          </div>
        </div>
        <div className="edit-foot">
          <label className="field privacy">
            <span>Privacy</span>
            <select value={privacy} onChange={(e) => setPrivacy(e.target.value as Privacy)}>
              {PRIVACY.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label} — {p.hint}
                </option>
              ))}
            </select>
          </label>
          <button className="pill-btn" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {error && <p className="edit-error" role="alert">{error}</p>}
        <p className="edit-note sub">Changes are saved to your playlist on YouTube Music. The cover must be at least 360 × 360 pixels.</p>
      </form>
    </div>,
    document.body
  )
}

export function DeletePlaylist({ data, onClose }: { data: Collection; onClose: () => void }) {
  const { toast, go } = useApp()
  const [busy, setBusy] = useState(false)
  const remove = () => {
    setBusy(true)
    window.ytm.deletePlaylist(data.id).then(
      () => {
        libraryChanged()
        onClose()
        toast('Removed from Your Library')
        go({ name: 'home' })
      },
      () => (setBusy(false), toast('Couldn’t delete the playlist'))
    )
  }
  return createPortal(
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal confirm" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}>
        <h1>Delete from Your Library?</h1>
        <p className="sub">
          This will delete <b>{data.title}</b> from YouTube Music.
        </p>
        <div className="confirm-actions">
          <button className="link-btn" onClick={onClose} autoFocus>
            Cancel
          </button>
          <button className="pill-btn" onClick={remove} disabled={busy}>
            Delete
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
