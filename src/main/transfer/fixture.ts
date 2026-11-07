// Test runs only (YTSPOT_PROFILE with YTSPOT_TRANSFER_FIXTURE=<public Spotify playlist ids>): a
// few public playlists stand in for a Spotify library, and YouTube Music only pretends to add
// things. Reading Spotify and every search are real, so an import can be tried end to end without
// logging in to either service or changing anyone's library.
import { readPublicPlaylist } from './spotify'
import * as youtube from './youtube'
import type { Source, Target } from './ports'
import type { SourceAlbum, SourceArtist } from '../../shared/transfer'

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function fixture(uris: string[]): { source: Source; target: Target } {
  let loggedIn = false
  let made = 0
  const source: Source = {
    signedIn: async () => loggedIn,
    // Stands for the user logging in, in a window that isn't there.
    logIn: async () => (await pause(1200), (loggedIn = true)),
    cancelLogIn: () => undefined,
    logOut: async () => void (loggedIn = false),
    readLibrary: async (signal, found) => {
      const lists = []
      let songs = 0
      for (const uri of uris) {
        const p = await readPublicPlaylist(uri, signal)
        found((songs += p.tracks.length))
        lists.push(p)
      }
      const [first, ...rest] = lists
      // Songs, an album and an artist that YouTube Music won't have, for the "Not found" list.
      first?.tracks.push(
        { id: 'test:track:missing1', title: 'Glorptastic Moonbeam Overture', artists: ['The Nonexistent Quartet'], album: 'Imaginary Sounds', ms: 201000 },
        { id: 'test:track:missing2', title: 'Hello', artists: ['Zzyzx Unknown Band'], album: '', ms: 180000 }
      )
      const albums = new Map<string, SourceAlbum>()
      const artists = new Map<string, SourceArtist>()
      for (const t of first?.tracks ?? []) {
        if (t.album && albums.size < 6) albums.set(t.album, { id: `test:album:${t.album}`, title: t.album, artists: t.artists.slice(0, 1), thumb: '' })
        if (t.artists[0] && artists.size < 6) artists.set(t.artists[0], { id: `test:artist:${t.artists[0]}`, name: t.artists[0], thumb: '' })
      }
      albums.set('missing', { id: 'test:album:missing', title: 'Imaginary Sounds', artists: ['The Nonexistent Quartet'], thumb: '' })
      artists.set('missing', { id: 'test:artist:missing', name: 'The Nonexistent Quartet', thumb: '' })
      return { account: 'Test listener', liked: first?.tracks ?? [], playlists: rest, albums: [...albums.values()], artists: [...artists.values()] }
    }
  }
  const target: Target = {
    ...youtube,
    like: () => pause(40),
    newPlaylist: async () => (await pause(300), `VLtest${++made}`),
    addSongs: () => pause(150),
    contents: async () => [],
    saveAlbum: () => pause(80),
    follow: () => pause(80)
  }
  return { source, target }
}
