export type Kind = 'song' | 'video' | 'album' | 'playlist' | 'artist' | 'other'

export interface Card {
  kind: Kind
  id: string
  title: string
  subtitle: string
  thumb: string
  playlistId?: string
}

export interface Track {
  videoId: string
  title: string
  artists: string
  artistId?: string
  album?: string
  albumId?: string
  duration: string
  thumb: string
  plays?: string // "2.7B plays", on an artist's top songs
}

// Where a shelf's "Show all" leads: a browse page (playlist, discography, …).
export interface More {
  browseId: string
  params?: string
}

export interface Shelf {
  title: string
  cards: Card[]
  more?: More
}

export interface Collection {
  kind: 'playlist' | 'album'
  id: string
  title: string
  subtitle: string
  meta: string
  thumb: string
  owner?: string // album artist or playlist owner
  ownerId?: string
  playlistId?: string
  description?: string
  editable?: boolean // a playlist you own (rename, cover, remove songs, suggestions)
  privacy?: Privacy
  saved?: boolean // in your library (albums and others' playlists)
  saveId?: string // the playlist id YTM saves to your library for it
  tracks: Track[]
  more?: boolean
  loaded?: number // songs fetched so far, counting ones since removed (the next page starts here)
}

export interface ArtistPage {
  id: string
  title: string
  thumb: string
  description: string
  subscribed: boolean
  songs: Track[]
  songsMore?: More // the full top-songs list
  shelves: Shelf[]
}

export interface HomeData {
  chips: string[]
  shelves: Shelf[]
}

// Lyrics lines carry a start time (seconds) when synced.
export interface Lyrics {
  lines: { time?: number; text: string }[]
  synced: boolean
  source: string
}

export interface SearchResult {
  top?: Card
  songs: Track[]
  shelves: Shelf[]
}

export interface QueueItem {
  videoId: string
  title: string
  artist: string
  artistId?: string
  albumId?: string
  duration: string
  thumb: string
  art?: string // Now Playing-size artwork: album art when there is any, else a video frame
  square?: boolean // `art` is album art
  selected: boolean
  rec?: boolean // added by Smart Shuffle
}

// Play in order, shuffle, or Smart Shuffle (shuffle plus recommendations), as in Spotify.
export type ShuffleMode = 'off' | 'on' | 'smart'

export interface PlayerState {
  videoId: string
  title: string
  artist: string
  artistId?: string
  album: string
  albumId?: string
  thumb: string
  time: number
  duration: number
  playing: boolean
  volume: number
  muted: boolean
  repeat: 'NONE' | 'ALL' | 'ONE'
  shuffle: ShuffleMode
  liked: boolean
  // The current item is a video (music video / upload); `videoMode` is the user's preference.
  isVideo: boolean
  videoMode: boolean
  queue: QueueItem[]
  autoplay: QueueItem[]
  pending?: boolean // the song just changed and its details haven't arrived yet
}

// What the menu bar item shows next to its icon; 'off' removes it.
export type MenuBarMode = 'both' | 'song' | 'artist' | 'icon' | 'off'

// The settings main acts on. The renderer owns them (localStorage) and sends them over 'ui:prefs'.
export interface MainPrefs {
  keepPlaying: boolean
  videoMode: boolean
  openAtLogin: boolean
  menuBar: MenuBarMode
}

export type PlayerCommand =
  | { type: 'play'; videoId: string; playlistId?: string }
  | { type: 'toggle' | 'next' | 'prev' | 'shuffle' | 'repeat' | 'like' | 'dislike' | 'mute' }
  | { type: 'seek'; seconds: number }
  | { type: 'volume'; value: number }
  | { type: 'jump' | 'jumpAuto'; index: number }
  | { type: 'queueAdd'; videoIds: string[]; next: boolean }
  | { type: 'queueRemove'; index: number }
  | { type: 'queueMove' | 'autoplayMove'; from: number; to: number }
  | { type: 'videoMode'; on: boolean }
  | { type: 'shuffleMode'; mode: ShuffleMode }

// A YouTube Music setting mirrored from its own settings dialog.
export interface YtmSetting {
  tab: string
  title: string
  summary?: string
  kind: 'toggle' | 'choice' | 'action' | 'link'
  value?: boolean | string
  options?: string[]
  url?: string
  confirm?: string
  // YTM's own endpoint for each value ("true"/"false", an option name, or "run" for actions).
  endpoints?: Record<string, unknown>
}

export type SearchFilter = 'all' | 'song' | 'video' | 'album' | 'artist' | 'playlist'

export type LibraryFilter = 'Playlists' | 'Albums' | 'Artists'

export type Privacy = 'PUBLIC' | 'UNLISTED' | 'PRIVATE'
