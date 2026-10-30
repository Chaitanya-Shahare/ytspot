import type { PopupItem } from '../../../preload'
import type { Card } from '../../../shared/types'
import { libraryChanged, playlistChanged, routeFor, savablePlaylists, type AppCtx } from '../lib'

export interface MenuSong {
  videoId: string
  title: string
  artistId?: string
  albumId?: string
}

interface Where {
  playlistId?: string // your own playlist page (route id) the row is on (enables "Remove from this playlist")
  onRemoved?: (videoId: string) => void // drop the row from that page once YouTube confirms
  liked?: boolean // known like state (current song, or rows of Liked Songs)
  queueIndex?: number // row in the Now Playing queue (enables "Remove from queue")
}

// Adds a song to one of your playlists. YTM won't add a song twice unless asked, so a repeat offers
// "Add anyway" instead. Resolves with whether the song is now in the playlist.
export async function addSong(ctx: AppCtx, pl: { id: string; title: string }, videoId: string, force = false): Promise<boolean> {
  try {
    if ((await window.ytm.addToPlaylist(pl.id, videoId, force)) === 'duplicate') {
      ctx.toast(`Already in ${pl.title}`, { label: 'Add anyway', run: () => void addSong(ctx, pl, videoId, true) })
      return true
    }
    playlistChanged(pl.id)
    ctx.toast(`Added to ${pl.title}`)
    return true
  } catch {
    ctx.toast('That didn’t work — try again')
    return false
  }
}

// Spotify names a playlist made from a song's menu after the song; the song goes straight in.
export async function newPlaylistWith(ctx: AppCtx, song: { videoId: string; title: string }): Promise<void> {
  try {
    const id = await window.ytm.createPlaylist(song.title, [song.videoId])
    libraryChanged()
    ctx.toast(`Added to ${song.title}`, { label: 'View', run: () => ctx.go({ name: 'playlist', id }) })
  } catch {
    ctx.toast('Couldn’t create the playlist')
  }
}

// Saves a song to / removes it from Liked Songs. The playing song goes through the player's own
// like button so its heart updates too.
export function setLiked(ctx: AppCtx, videoId: string, like: boolean): Promise<void> {
  const done = () => {
    playlistChanged('LM')
    ctx.toast(like ? 'Added to Liked Songs' : 'Removed from Liked Songs')
  }
  if (videoId === ctx.player?.videoId) {
    if (ctx.player.liked !== like) window.ytm.cmd({ type: 'like' })
    return Promise.resolve(done())
  }
  return window.ytm.rate(videoId, like).then(done, () => ctx.toast('That didn’t work — try again'))
}

export const queue = (videoIds: string[], next: boolean) => window.ytm.cmd({ type: 'queueAdd', videoIds, next })

// The songs of an album or playlist card (a playlist's first page), for queueing it whole.
export async function cardSongs(c: Card): Promise<string[]> {
  const col = c.kind === 'album' ? await window.ytm.album(c.id) : await window.ytm.playlist(c.id, true)
  return col.tracks.map((t: { videoId: string }) => t.videoId)
}

// Extra entries when the card is in Your Library (the sidebar): pinning it, and taking it out.
export interface InLibrary {
  pinned: boolean
  onPin: () => void
}

// A YouTube video that always exists, for asking YTM which playlists are yours (it lists the same
// ones whatever the song).
const ANY_VIDEO = 'jNQXAC9IVRw'

// Takes a card out of Your Library on YouTube Music: unfollows an artist, unsaves an album or
// someone else's playlist, deletes a playlist you own.
async function removeFromLibrary(c: Card, own: boolean, ctx: AppCtx): Promise<void> {
  const bareId = c.id.replace(/^VL/, '')
  try {
    if (own) {
      if (!confirm(`Delete “${c.title}” from YouTube Music? This can’t be undone.`)) return
      await window.ytm.deletePlaylist(c.id)
    } else if (c.kind === 'artist') await window.ytm.subscribe(c.id, false)
    else if (c.kind === 'album') await window.ytm.saveToLibrary(c.playlistId ?? (await window.ytm.album(c.id)).saveId, false)
    else await window.ytm.saveToLibrary(bareId, false)
    libraryChanged()
    ctx.toast(own ? `Deleted ${c.title}` : 'Removed from Your Library')
    if (JSON.stringify(ctx.route) === JSON.stringify(routeFor(c))) ctx.go({ name: 'home' })
  } catch {
    ctx.toast('That didn’t work — try again')
  }
}

// Right-click / "…" menu for a card: songs get the song menu; albums and playlists can be queued.
export async function cardMenu(c: Card, ctx: AppCtx, lib?: InLibrary): Promise<void> {
  if (c.kind === 'song' || c.kind === 'video') return songMenu({ videoId: c.id, title: c.title }, ctx)
  const { go, toast, playCard } = ctx
  const own = !!lib && c.kind === 'playlist' && (await savablePlaylists(ANY_VIDEO).catch(() => [])).some((p) => p.id === c.id)
  const kindName = c.kind === 'album' ? 'album' : c.kind === 'artist' ? 'artist' : 'playlist'
  const r = routeFor(c)
  const url =
    c.kind === 'artist' ? `https://music.youtube.com/channel/${c.id}`
    : c.kind === 'album' ? `https://music.youtube.com/browse/${c.id}`
    : `https://music.youtube.com/playlist?list=${c.playlistId ?? c.id.replace(/^VL/, '')}`
  const songs = c.kind === 'album' || c.kind === 'playlist'
  const pick = await window.ytm.popup([
    { id: 'play', label: 'Play' },
    ...(songs
      ? [
          { id: 'next', label: 'Play next' },
          { id: 'queue', label: 'Add to queue' }
        ]
      : []),
    ...(lib
      ? [
          { id: '-', label: '-' },
          { id: 'pin', label: `${lib.pinned ? 'Unpin' : 'Pin'} ${kindName}` },
          { id: 'remove', label: own ? 'Delete' : c.kind === 'artist' ? 'Unfollow' : 'Remove from Your Library' }
        ]
      : []),
    { id: '-', label: '-' },
    ...(songs ? [{ id: 'radio', label: `Go to ${kindName} radio` }] : []),
    { id: 'go', label: `Go to ${c.kind}`, enabled: !!r },
    { id: '-', label: '-' },
    { id: 'share', label: 'Share', submenu: [{ id: 'copy', label: `Copy link to ${c.kind === 'album' ? 'Album' : c.kind}` }] },
    { id: 'open', label: 'Open in YouTube Music' }
  ])
  if (pick === 'play') playCard(c)
  if (pick === 'pin') lib?.onPin()
  if (pick === 'remove') removeFromLibrary(c, own, ctx)
  // YTM's radio for a list: its first song, continuing as a mix built from the whole list.
  if (pick === 'radio')
    (c.kind === 'album' ? window.ytm.album(c.id) : window.ytm.playlist(c.id, true)).then(
      (col: { tracks: { videoId: string; title: string }[]; playlistId?: string }) => {
        const first = col.tracks[0]
        const list = col.playlistId ?? c.id.replace(/^VL/, '')
        if (first) ctx.playTrack({ ...first, artists: '', duration: '', thumb: '' }, `RDAMPL${list}`)
      },
      () => toast('That didn’t work — try again')
    )
  if (pick === 'next' || pick === 'queue')
    cardSongs(c)
      .then((ids) => queue(ids, pick === 'next'))
      .then(() => toast(pick === 'next' ? 'Playing next' : 'Added to queue'), () => toast('That didn’t work — try again'))
  if (pick === 'go' && r) go(r)
  if (pick === 'copy') window.ytm.copy(url).then(() => toast('Link copied to clipboard'))
  if (pick === 'open') window.ytm.open(url)
}

// Spotify-style "…" / right-click menu for a song, shared by track rows, the queue and Now Playing.
export async function songMenu(song: MenuSong, ctx: AppCtx, where: Where = {}): Promise<void> {
  const { go, toast } = ctx
  // Only your own playlists take songs; the list comes from YTM's "Save to playlist".
  const playlists = await savablePlaylists(song.videoId).catch(() => [])
  const ownPlaylist = where.playlistId && !/^(VL)?LM$/.test(where.playlistId) ? where.playlistId : undefined
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
    { id: 'share', label: 'Share', submenu: [{ id: 'copy', label: 'Copy link to Song' }] },
    { id: 'open', label: 'Open in YouTube Music' }
  ]
  const pick = await window.ytm.popup(items)
  if (!pick) return
  const url = `https://music.youtube.com/watch?v=${song.videoId}`
  const done = (msg: string) => () => toast(msg)
  if (pick.startsWith('pl:')) {
    const pl = playlists.find((p) => p.id === pick.slice(3))
    if (pl) addSong(ctx, pl, song.videoId)
  }
  if (pick === 'new') newPlaylistWith(ctx, song)
  if (pick === 'remove-pl' && ownPlaylist)
    window.ytm.removeFromPlaylist(ownPlaylist, song.videoId).then(
      () => (where.onRemoved?.(song.videoId), playlistChanged(ownPlaylist), toast('Removed from this playlist')),
      () => toast('You can only remove songs from your own playlists')
    )
  if (pick === 'like' || pick === 'unlike') setLiked(ctx, song.videoId, pick === 'like')
  if (pick === 'next') queue([song.videoId], true).then(done('Playing next'))
  if (pick === 'queue') queue([song.videoId], false).then(done('Added to queue'))
  if (pick === 'remove-q' && where.queueIndex !== undefined)
    window.ytm.cmd({ type: 'queueRemove', index: where.queueIndex }).then(done('Removed from queue'))
  // Through playTrack so "Playing from" lets go of the page the song was on.
  if (pick === 'radio') ctx.playTrack({ videoId: song.videoId, title: song.title, artists: '', duration: '', thumb: '' }, `RDAMVM${song.videoId}`)
  if (pick === 'artist' && song.artistId) go({ name: 'artist', id: song.artistId })
  if (pick === 'album' && song.albumId) go({ name: 'album', id: song.albumId })
  if (pick === 'copy') window.ytm.copy(url).then(done('Link copied to clipboard'))
  if (pick === 'open') window.ytm.open(url)
}
