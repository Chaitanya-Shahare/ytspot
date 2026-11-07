// Moving a music library from Spotify to YouTube Music (see main/transfer). Everything runs on
// this Mac: Spotify is read through its own web player's API, YouTube Music is written through the
// signed-in session, and no other server is involved.
//
// Only summaries cross over to the UI; the songs themselves stay in main.

// A song as Spotify lists it.
export interface SourceTrack {
  id: string // spotify:track:…
  title: string
  artists: string[]
  album: string
  ms: number // duration
}

export interface SourcePlaylist {
  id: string // spotify:playlist:…
  title: string
  owner: string
  thumb: string
  count: number // songs (podcasts and local files left out)
  linked?: boolean // imported before: importing again only adds its new songs
}

export interface SourceAlbum {
  id: string
  title: string
  artists: string[]
  thumb: string
}

export interface SourceArtist {
  id: string
  name: string
  thumb: string
}

// What the user can pick from, once their Spotify library has been read.
export interface LibrarySummary {
  account: string // the Spotify account's display name ('' when Spotify didn't say)
  liked: number
  playlists: SourcePlaylist[]
  albums: SourceAlbum[]
  artists: SourceArtist[]
}

export interface Selection {
  liked: boolean
  playlists: string[] // ids
  albums: boolean
  artists: boolean
}

// Something that couldn't be found on YouTube Music.
export interface Missing {
  id: string // the Spotify id
  title: string
  artists: string
  album?: string
}

// One part of the import: Liked Songs, a playlist, or all the albums or artists.
export interface TransferItem {
  id: string // 'liked', 'albums', 'artists' or a playlist id
  kind: 'liked' | 'playlist' | 'albums' | 'artists'
  title: string
  thumb?: string
  total: number
  done: number // looked up so far (found or not)
  moved: number // added to YouTube Music, this run
  missing: Missing[]
  target?: string // the YouTube Music playlist (VL…) it went into
  status: 'waiting' | 'working' | 'done' | 'failed'
  error?: string
}

export type TransferPhase =
  | 'idle' // nothing read yet
  | 'connecting' // the Spotify login window is open
  | 'reading' // reading the Spotify library
  | 'ready' // read: pick what to import
  | 'moving' // importing
  | 'stopped' // paused by the user, an error, or quitting; can resume
  | 'done'

export interface TransferState {
  phase: TransferPhase
  ytm: boolean // logged in to YouTube Music (where everything goes)
  connected: boolean // a Spotify login is saved on this Mac
  found?: number // songs found so far while reading
  library?: LibrarySummary
  items?: TransferItem[]
  // For the time left: when this run (re)started, and how much was done by then.
  startedAt?: number
  doneAtStart?: number
  error?: string
}

// A YouTube Music song offered when fixing one that wasn't found.
export interface Candidate {
  videoId: string
  title: string
  artists: string
  album?: string
  duration: string
  thumb: string
}

// The calls the UI makes (one IPC channel, 'transfer', takes the method name and its arguments).
export interface TransferApi {
  state(): Promise<TransferState>
  connect(): Promise<void> // log in to Spotify if needed, then read the library
  cancel(): Promise<void> // close the login window or stop reading
  start(s: Selection): Promise<void>
  stop(): Promise<void>
  resume(): Promise<void> // carry on after stopping, or retry what failed
  reset(): Promise<void> // back to the start (keeps what was imported, so importing again adds only new songs)
  disconnect(): Promise<void> // forget the Spotify login
  find(itemId: string, trackId: string): Promise<Candidate[]>
  fix(itemId: string, trackId: string, videoId: string): Promise<void>
}
