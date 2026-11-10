// The two sides of an import, as the import itself (index.ts) sees them: where the music comes from
// and where it goes. Spotify (spotify.ts) and YouTube Music (youtube.ts) are the real ones; test
// runs swap in stand-ins (fixture.ts). Another service would plug in here.
import type * as spotify from './spotify'
import type * as youtube from './youtube'

export type Source = Pick<typeof spotify, 'signedIn' | 'logIn' | 'cancelLogIn' | 'logOut' | 'readLibrary'>

export type Target = Pick<
  typeof youtube,
  'findSong' | 'offers' | 'like' | 'unlike' | 'newPlaylist' | 'addSongs' | 'removeSong' | 'contents' | 'findAlbum' | 'saveAlbum' | 'findArtist' | 'follow'
>
