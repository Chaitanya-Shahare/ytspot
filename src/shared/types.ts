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
  tracks: Track[]
  more?: boolean
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
  selected: boolean
}

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
  liked: boolean
  // The current item is a video (music video / upload); `videoMode` is the user's preference.
  isVideo: boolean
  videoMode: boolean
  queue: QueueItem[]
  autoplay: QueueItem[]
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
