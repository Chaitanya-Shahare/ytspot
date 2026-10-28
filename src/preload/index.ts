import { contextBridge, ipcRenderer } from 'electron'
import type { Action } from '../shared/shortcuts'
import type { Card, HomeData, LibraryFilter, Lyrics, More, PlayerCommand, PlayerState, SearchFilter, YtmSetting } from '../shared/types'
import type { LyricsQuery } from '../main/lyrics'

export interface PopupItem {
  id: string
  label: string
  enabled?: boolean
  checked?: boolean
  submenu?: PopupItem[]
}

const bridge = {
  authStatus: (): Promise<boolean> => ipcRenderer.invoke('auth:status'),
  login: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  account: (): Promise<{ name: string; photo: string } | null> => ipcRenderer.invoke('yt:account'),
  home: (chip?: string): Promise<HomeData> => ipcRenderer.invoke('yt:home', chip),
  explore: () => ipcRenderer.invoke('yt:explore'),
  moods: () => ipcRenderer.invoke('yt:moods'),
  mood: (params: string) => ipcRenderer.invoke('yt:mood', params),
  addToPlaylist: (playlistId: string, videoId: string) => ipcRenderer.invoke('yt:addToPlaylist', playlistId, videoId),
  removeFromPlaylist: (playlistId: string, videoId: string) =>
    ipcRenderer.invoke('yt:removeFromPlaylist', playlistId, videoId),
  rate: (videoId: string, like: boolean) => ipcRenderer.invoke('yt:rate', videoId, like),
  subscribe: (channelId: string, on: boolean) => ipcRenderer.invoke('yt:subscribe', channelId, on),
  browseMore: (more: More): Promise<Card[]> => ipcRenderer.invoke('yt:browseMore', more),
  ytmSettings: (): Promise<YtmSetting[]> => ipcRenderer.invoke('ytm:settings'),
  applyYtmSetting: (endpoint: unknown) => ipcRenderer.invoke('ytm:applySetting', endpoint),
  library: (f: LibraryFilter) => ipcRenderer.invoke('yt:library', f),
  playlist: (id: string) => ipcRenderer.invoke('yt:playlist', id),
  playlistMore: (id: string, have: number) => ipcRenderer.invoke('yt:playlistMore', id, have),
  createPlaylist: (title: string): Promise<string> => ipcRenderer.invoke('yt:createPlaylist', title),
  album: (id: string) => ipcRenderer.invoke('yt:album', id),
  artist: (id: string) => ipcRenderer.invoke('yt:artist', id),
  search: (q: string, filter?: SearchFilter) => ipcRenderer.invoke('yt:search', q, filter),
  lyrics: (q: LyricsQuery): Promise<Lyrics | null> => ipcRenderer.invoke('yt:lyrics', q),
  cmd: (c: PlayerCommand) => ipcRenderer.invoke('player:cmd', c),
  state: (): Promise<PlayerState | null> => ipcRenderer.invoke('player:get'),
  popup: (items: PopupItem[]): Promise<string | null> =>
    ipcRenderer.invoke('ui:popup', items),
  open: (url: string) => ipcRenderer.invoke('ui:open', url),
  copy: (text: string) => ipcRenderer.invoke('ui:copy', text),
  fullscreen: (on?: boolean): Promise<boolean> => ipcRenderer.invoke('ui:fullscreen', on),
  log: (msg: string) => ipcRenderer.invoke('ui:log', msg),
  videoRect: (r: { x: number; y: number; width: number; height: number } | null) => ipcRenderer.invoke('ui:videoRect', r),
  setBindings: (b: Record<Action, string[]>) => ipcRenderer.invoke('ui:bindings', b),
  setPrefs: (p: { keepPlaying: boolean; videoMode: boolean; openAtLogin: boolean }) => ipcRenderer.invoke('ui:prefs', p),
  onState: (cb: (s: PlayerState) => void) => {
    const fn = (_: unknown, s: PlayerState) => cb(s)
    ipcRenderer.on('player:state', fn)
    return () => void ipcRenderer.removeListener('player:state', fn)
  },
  onTime: (cb: (t: number) => void) => {
    const fn = (_: unknown, t: number) => cb(t)
    ipcRenderer.on('player:time', fn)
    return () => void ipcRenderer.removeListener('player:time', fn)
  },
  onMenu: (cb: (a: Action) => void) => {
    const fn = (_: unknown, a: Action) => cb(a)
    ipcRenderer.on('menu:action', fn)
    return () => void ipcRenderer.removeListener('menu:action', fn)
  },
  onFullscreen: (cb: (on: boolean) => void) => {
    const fn = (_: unknown, on: boolean) => cb(on)
    ipcRenderer.on('fullscreen', fn)
    return () => void ipcRenderer.removeListener('fullscreen', fn)
  },
  onAuth: (cb: (ok: boolean) => void) => {
    const fn = (_: unknown, ok: boolean) => cb(ok)
    ipcRenderer.on('auth', fn)
    return () => void ipcRenderer.removeListener('auth', fn)
  }
}

export type Bridge = typeof bridge
contextBridge.exposeInMainWorld('ytm', bridge)
