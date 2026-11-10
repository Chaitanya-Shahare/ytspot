// Test runs only (YTSPOT_PROFILE with YTSPOT_TRANSFER_FIXTURE=<public Spotify playlist ids>): a
// few public playlists stand in for a Spotify library, and YouTube Music only pretends to add
// things. Reading Spotify and every search are real, so an import can be tried end to end without
// logging in to either service or changing anyone's library.
//
// The pretend YouTube Music library is kept in a file (`file`), so a relaunch or "Import again"
// finds what earlier runs added; edit or delete it to act out changes made on YouTube Music. It
// refuses one song, as YouTube Music does with one that's been taken down.
import { readFileSync, writeFileSync } from 'node:fs'
import { readPublicPlaylists } from './spotify'
import * as youtube from './youtube'
import type { Source, Target } from './ports'
import type { SourceAlbum, SourceArtist } from '../../shared/transfer'

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

interface Library {
  playlists: Record<string, string[]>
  liked: string[]
  made: number
  refused?: string
}

export function fixture(uris: string[], file: string): { source: Source; target: Target } {
  let loggedIn = false
  let cancel: (() => void) | null = null
  let ytm: Library = { playlists: {}, liked: [], made: 0 }
  // Read before every call, so edits to the file take effect straight away.
  const load = () => {
    try {
      ytm = { playlists: {}, liked: [], made: 0, ...JSON.parse(readFileSync(file, 'utf8')) }
    } catch {
      // First run.
    }
  }
  const save = () => writeFileSync(file, JSON.stringify(ytm, null, 1))
  const source: Source = {
    signedIn: async () => loggedIn,
    // Stands for the user logging in, in a window that isn't there.
    logIn: () =>
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => ((cancel = null), resolve((loggedIn = true))), 1200)
        cancel = () => (clearTimeout(t), (cancel = null), resolve(false))
      }),
    cancelLogIn: () => cancel?.(),
    logOut: async () => void (loggedIn = false),
    readLibrary: async (signal, found) => {
      let songs = 0
      const uri = (id: string) => (id.startsWith('spotify:') ? id : `spotify:playlist:${id}`)
      const { playlists: lists, unread } = await readPublicPlaylists(uris.map(uri), signal, (n) => found((songs += n)))
      const [first, ...rest] = lists
      // Songs, an album and an artist that YouTube Music won't have, for the "Not found" list.
      first?.tracks.push(
        { id: 'test:track:missing1', title: 'Glorptastic Moonbeam Overture', artists: ['The Nonexistent Quartet'], album: 'Imaginary Sounds', ms: 201000 },
        { id: 'test:track:missing2', title: 'Hello', artists: ['Zzyzx Unknown Band'], album: '', ms: 180000 }
      )
      // Songs that YouTube Music has, but that only match closely (the main artist isn't credited
      // there, or the length is off), for the "Worth a check" list: one liked, one in a playlist.
      first?.tracks.push({ id: 'test:track:close1', title: 'Shape of You', artists: ['Stormzy', 'Ed Sheeran'], album: '', ms: 249000 })
      rest[0]?.tracks.splice(1, 0, { id: 'test:track:close2', title: 'Blinding Light', artists: ['The Weeknd'], album: '', ms: 226000 })
      if (rest[0]) rest[0].count = rest[0].tracks.length
      const albums = new Map<string, SourceAlbum>()
      const artists = new Map<string, SourceArtist>()
      for (const t of first?.tracks ?? []) {
        if (t.album && albums.size < 6) albums.set(t.album, { id: `test:album:${t.album}`, title: t.album, artists: t.artists.slice(0, 1), thumb: '' })
        if (t.artists[0] && artists.size < 6) artists.set(t.artists[0], { id: `test:artist:${t.artists[0]}`, name: t.artists[0], thumb: '' })
      }
      albums.set('missing', { id: 'test:album:missing', title: 'Imaginary Sounds', artists: ['The Nonexistent Quartet'], thumb: '' })
      artists.set('missing', { id: 'test:artist:missing', name: 'The Nonexistent Quartet', thumb: '' })
      return { account: 'Test listener', liked: first?.tracks ?? [], playlists: rest, albums: [...albums.values()], artists: [...artists.values()], unread }
    }
  }
  const target: Target = {
    ...youtube,
    like: async (v) => (await pause(150), load(), ytm.liked.includes(v) || ytm.liked.push(v), save()),
    unlike: async (v) => (await pause(150), load(), (ytm.liked = ytm.liked.filter((x) => x !== v)), save()),
    newPlaylist: async () => {
      await pause(300)
      load()
      const id = `VLtest${++ytm.made}`
      ytm.playlists[id] = []
      save()
      return id
    },
    addSongs: async (id, videos) => {
      await pause(150)
      load()
      const list = ytm.playlists[id]
      if (!list) throw new Error('YouTube Music couldn’t find that playlist')
      // The third song of the first batch is the one it won't take.
      if (videos.length > 2 && !ytm.refused) (ytm.refused = videos[2]), save()
      if (ytm.refused && videos.includes(ytm.refused)) throw new Error('YouTube Music didn’t add the songs')
      list.push(...videos)
      save()
    },
    removeSong: async (id, v) => {
      await pause(150)
      load()
      const list = ytm.playlists[id]
      if (!list) throw new Error('You can only remove songs from your own playlists')
      ytm.playlists[id] = list.filter((x) => x !== v)
      save()
    },
    contents: async (id) => (await pause(200), load(), ytm.playlists[id] ? [...ytm.playlists[id]] : null),
    saveAlbum: () => pause(80),
    follow: () => pause(80)
  }
  return { source, target }
}
