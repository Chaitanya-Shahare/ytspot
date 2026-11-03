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

// Chords worked out from the song's own audio (main/chords.ts). Each runs from `time` to `end`
// (seconds); only the parts of the song heard so far have any.
export interface Chords {
  videoId: string
  key: string // e.g. "A minor"; '' until enough has been heard
  chords: { time: number; end: number; name: string }[]
  heard: number // how much of the song has been heard, 0..1
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
  local?: boolean // playing a downloaded file (see main/local.ts), not through YouTube Music
}

// Where the UI wants the video, in CSS pixels. `full`: the full-screen player's video, which fills
// the window beneath the page (whose controls show over it) instead of sitting on top of it.
export interface VideoRect {
  x: number
  y: number
  width: number
  height: number
  full?: boolean
}

// What the menu bar item shows next to its icon; 'off' removes it.
export type MenuBarMode = 'both' | 'song' | 'artist' | 'icon' | 'off'
// The menu bar item's icon: always the ♫ note, or a play/pause status for the song on show.
export type MenuBarIcon = 'note' | 'status'

// The settings main acts on. The renderer owns them (localStorage) and sends them over 'ui:prefs'.
export interface MainPrefs {
  keepPlaying: boolean
  videoMode: boolean
  openAtLogin: boolean
  menuBar: MenuBarMode
  menuBarIcon: MenuBarIcon
  autoUpdate: boolean
  chords: boolean
}

// Where the app's self-update is (see main/updater.ts); `current` is the running version.
export type UpdateStatus =
  | { status: 'idle' | 'checking' | 'latest' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string }
export type UpdateState = UpdateStatus & { current: string }

export type PlayerCommand =
  // `shuffle` (Shuffle play): turn shuffle on first, unless it's on already (Smart Shuffle included).
  | { type: 'play'; videoId: string; playlistId?: string; shuffle?: boolean }
  // Downloaded songs, played from disk in this order starting at `index` (works offline).
  | { type: 'playLocal'; videoIds: string[]; index: number }
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

// Audio quality for new downloads: YouTube's Opus streams at about 50 and 70 kbps, or its best (~130 kbps).
export type DownloadQuality = 'low' | 'normal' | 'high'

// A song saved for offline listening (main/downloads.ts). `thumb` is the artwork saved with it.
export interface Download extends Track {
  bytes: number
  added: number // when it was downloaded (ms); sorts the list, newest first
}

// Everything downloaded, newest first, and what's still on its way (`progress` 0–1).
export interface DownloadsState {
  songs: Download[]
  queue: { videoId: string; title: string; progress: number }[]
}
