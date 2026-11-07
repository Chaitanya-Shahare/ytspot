// The Spotify import's state, shared by its page (views/transfer.tsx, loaded only when opened) and
// the sidebar's progress row. Nothing here asks main for anything until the page is opened, so
// main never loads its import code for someone who doesn't use it.
import { useSyncExternalStore } from 'react'
import type { TransferState } from '../../shared/transfer'
import { libraryChanged, playlistChanged } from './lib'

let state: TransferState | null = null
const subs = new Set<() => void>()

// Library pages that an import changes are reloaded as it goes: a new playlist shows in the
// sidebar, and a finished one (or Liked Songs) shows its songs.
function refresh(prev: TransferState | null, next: TransferState): void {
  const before = new Map((prev?.items ?? []).map((i) => [i.id, i]))
  let newPlaylist = false
  for (const item of next.items ?? []) {
    const was = before.get(item.id)
    if (item.target && !was?.target) newPlaylist = true
    const finished = item.status !== 'working' && was?.status === 'working'
    const fixed = was && item.moved > was.moved && item.status === 'done'
    const page = item.kind === 'liked' ? 'LM' : item.target
    if ((finished || fixed) && page) playlistChanged(page)
  }
  if (newPlaylist) libraryChanged()
  if (next.phase === 'done') localStorage.setItem(CTA_KEY, 'done')
}

function set(next: TransferState): void {
  const prev = state
  state = next
  if (prev) refresh(prev, next)
  subs.forEach((f) => f())
}

// Updates only arrive once an import has been opened in this run of the app (main pushes them;
// listening costs nothing).
window.ytm.onTransfer(set)

// The page calls this when it opens.
export async function loadTransfer(): Promise<void> {
  set(await window.ytm.transfer.state())
}

const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f))
export const useTransfer = () => useSyncExternalStore(subscribe, () => state)

// The share of the work done, 0–1.
export function progress(s: TransferState | null): number {
  const items = s?.items ?? []
  const total = items.reduce((n, i) => n + i.total, 0)
  return total ? items.reduce((n, i) => n + Math.min(i.done, i.total), 0) / total : 0
}

// The sidebar's "Coming from Spotify?" card: hidden once dismissed or once an import has finished.
export const CTA_KEY = 'spotify-import-cta'
