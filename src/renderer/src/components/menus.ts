import type { PopupItem } from '../../../preload'
import { cachedPlaylists, invalidate, type AppCtx } from '../lib'

export interface MenuSong {
  videoId: string
  title: string
  artistId?: string
  albumId?: string
}

interface Where {
  playlistId?: string // the playlist page the row is on (enables "Remove from this playlist")
  liked?: boolean // known like state (current song, or rows of Liked Songs)
  queueIndex?: number // row in the Now Playing queue (enables "Remove from queue")
}

// Spotify-style "…" / right-click menu for a song, shared by track rows, the queue and Now Playing.
export async function songMenu(song: MenuSong, ctx: AppCtx, where: Where = {}): Promise<void> {
  const { go, toast } = ctx
  const playlists = cachedPlaylists().filter((p) => p.id !== 'VLLM' && p.id !== 'LM')
  const ownPlaylist = where.playlistId && where.playlistId !== 'LM' ? where.playlistId : undefined
  const items: PopupItem[] = [
    {
      id: 'add',
      label: 'Add to playlist',
      submenu: [
        { id: 'new', label: 'New playlist' },
        ...(playlists.length ? [{ id: '-', label: '-' }] : []),
        ...playlists.map((p) => ({ id: `pl:${p.id}`, label: p.title }))
      ]
    },
    ...(ownPlaylist ? [{ id: 'remove-pl', label: 'Remove from this playlist' }] : []),
    where.liked
      ? { id: 'unlike', label: 'Remove from your Liked Songs' }
      : { id: 'like', label: 'Save to your Liked Songs' },
    ...(where.queueIndex !== undefined
      ? [{ id: 'remove-q', label: 'Remove from queue' }]
      : [
          { id: 'next', label: 'Play next' },
          { id: 'queue', label: 'Add to queue' }
        ]),
    { id: '-', label: '-' },
    { id: 'radio', label: 'Go to song radio' },
    { id: 'artist', label: 'Go to artist', enabled: !!song.artistId },
    { id: 'album', label: 'Go to album', enabled: !!song.albumId },
    { id: '-', label: '-' },
    { id: 'share', label: 'Share', submenu: [{ id: 'copy', label: 'Copy song link' }] },
    { id: 'open', label: 'Open in YouTube Music' }
  ]
  const pick = await window.ytm.popup(items)
  if (!pick) return
  const url = `https://music.youtube.com/watch?v=${song.videoId}`
  const done = (msg: string) => () => toast(msg)
  const failed = () => toast('That didn’t work — try again')
  if (pick.startsWith('pl:')) {
    const id = pick.slice(3)
    const name = playlists.find((p) => p.id === id)?.title ?? 'playlist'
    window.ytm.addToPlaylist(id, song.videoId).then(() => (invalidate(`playlist:${id}`), toast(`Added to ${name}`)), failed)
  }
  if (pick === 'new') {
    const n = playlists.filter((p) => p.title.startsWith('My Playlist #')).length + 1
    window.ytm
      .createPlaylist(`My Playlist #${n}`)
      .then((id) => window.ytm.addToPlaylist(id, song.videoId).then(() => toast(`Added to My Playlist #${n}`)), failed)
  }
  if (pick === 'remove-pl' && ownPlaylist)
    window.ytm.removeFromPlaylist(ownPlaylist, song.videoId).then(
      () => (invalidate(`playlist:${ownPlaylist}`), toast('Removed from this playlist')),
      () => toast('You can only remove songs from your own playlists')
    )
  if (pick === 'like' || pick === 'unlike')
    window.ytm.rate(song.videoId, pick === 'like').then(() => {
      invalidate('playlist:LM')
      toast(pick === 'like' ? 'Added to Liked Songs' : 'Removed from Liked Songs')
    }, failed)
  if (pick === 'next') window.ytm.cmd({ type: 'queueAdd', videoId: song.videoId, next: true }).then(done('Playing next'))
  if (pick === 'queue') window.ytm.cmd({ type: 'queueAdd', videoId: song.videoId, next: false }).then(done('Added to queue'))
  if (pick === 'remove-q' && where.queueIndex !== undefined)
    window.ytm.cmd({ type: 'queueRemove', index: where.queueIndex }).then(done('Removed from queue'))
  if (pick === 'radio') window.ytm.cmd({ type: 'play', videoId: song.videoId, playlistId: `RDAMVM${song.videoId}` })
  if (pick === 'artist' && song.artistId) go({ name: 'artist', id: song.artistId })
  if (pick === 'album' && song.albumId) go({ name: 'album', id: song.albumId })
  if (pick === 'copy') window.ytm.copy(url).then(done('Link copied to clipboard'))
  if (pick === 'open') window.ytm.open(url)
}
