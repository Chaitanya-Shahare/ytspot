// Import from Spotify: connect, pick what to bring over, watch it move, then fix what wasn't found.
// Loaded only when the page is opened (see App.tsx), with its own styles.
import { useEffect, useMemo, useState } from 'react'
import type { Candidate, LibrarySummary, Missing, Selection, TransferItem, TransferState, Unsure } from '../../../shared/transfer'
import * as I from '../components/icons'
import { ErrorBox, Img, Loading } from '../components/ui'
import { useApp } from '../lib'
import { loadTransfer, progress, useTransfer } from '../transfer'
import './transfer.css'

const t = window.ytm.transfer
const n = (x: number) => x.toLocaleString()
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`
const message = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export default function TransferView() {
  const { authed } = useApp()
  const state = useTransfer()
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    loadTransfer().then(() => setError(null), (e) => setError(message(e)))
  }, [attempt])

  let body: React.ReactNode
  // Main knows best whether YouTube Music is ready; until it answers, go by the app's own sign-in.
  if (!(state ? state.ytm : authed)) body = <SignIn />
  else if (!state) body = error ? <ErrorBox error={error} onRetry={() => setAttempt((a) => a + 1)} /> : <Loading kind="rows" />
  else if (state.phase === 'idle') body = <Start state={state} />
  else if (state.phase === 'connecting') body = <Busy title="Log in to Spotify in the window that opened" note="Close it to cancel." />
  else if (state.phase === 'reading')
    body = <Busy title="Reading your Spotify library…" note={state.found ? `${plural(state.found, 'song')} so far` : 'This takes a few seconds.'} />
  else if (state.phase === 'ready' && state.library) body = <Choose library={state.library} />
  else if (state.phase === 'moving') body = <Moving state={state} />
  else body = <Results state={state} />

  return (
    <div className="page transfer" style={{ '--tint': 'rgb(24,92,56)' } as React.CSSProperties}>
      <header className="hero transfer-hero">
        <div className="hero-art transfer-art">
          <I.Import size={64} />
        </div>
        <div className="hero-text">
          <span className="hero-kind">Import</span>
          <h1 className="hero-title">Import from Spotify</h1>
          <p className="hero-desc">Bring your Liked Songs, playlists, albums and artists over to YouTube Music. Free, with no limits.</p>
        </div>
      </header>
      {body}
    </div>
  )
}

// Run a call; failures show as a toast (the import's own errors arrive with its state instead).
function useAct() {
  const { toast } = useApp()
  const [busy, setBusy] = useState(false)
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast(message(e))
    } finally {
      setBusy(false)
    }
  }
  return [act, busy] as const
}

function SignIn() {
  return (
    <section className="tr-panel">
      <h2>Log in to YouTube Music first</h2>
      <p className="sub">Your Spotify music is added to the YouTube Music account you’re logged in with.</p>
      <button className="pill-btn tr-primary" onClick={() => window.ytm.login()}>
        Log in
      </button>
    </section>
  )
}

const MOVES: [React.ReactNode, string, string][] = [
  [<I.HeartFill key="h" />, 'Liked Songs', 'Liked on YouTube Music, in the same order'],
  [<I.Library key="l" />, 'Playlists', 'Copied as private playlists in your library'],
  [<I.Album key="a" />, 'Saved albums', 'Saved to your library'],
  [<I.Artist key="r" />, 'Followed artists', 'Subscribed to on YouTube Music']
]

function Start({ state }: { state: TransferState }) {
  const [act, busy] = useAct()
  return (
    <>
      {state.error && <p className="tr-error">{state.error}</p>}
      <ul className="tr-moves">
        {MOVES.map(([icon, title, desc]) => (
          <li key={title}>
            <span className="tr-move-icon">{icon}</span>
            <div>
              <b>{title}</b>
              <span className="sub">{desc}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="tr-actions">
        <button className="pill-btn tr-primary green-btn" disabled={busy} onClick={() => act(t.connect)}>
          {state.connected ? 'Continue with Spotify' : 'Connect Spotify'}
        </button>
        {state.connected && (
          <button className="outline-btn" disabled={busy} onClick={() => act(t.disconnect)}>
            Use another account
          </button>
        )}
      </div>
      <p className="sub tr-fine">
        {state.connected ? 'You’re logged in to Spotify here. ' : 'You’ll log in to Spotify in a window here. '}
        ytspot reads your library straight from Spotify and adds it to YouTube Music from this Mac: nothing goes through anyone else’s
        servers. You choose what to import before anything is added.
      </p>
    </>
  )
}

function Busy({ title, note }: { title: string; note: string }) {
  const [act, busy] = useAct()
  return (
    <section className="tr-panel tr-busy" aria-busy="true">
      <span className="tr-spinner" />
      <div>
        <h2>{title}</h2>
        <p className="sub">{note}</p>
      </div>
      <button className="outline-btn" disabled={busy} onClick={() => act(t.cancel)}>
        Cancel
      </button>
    </section>
  )
}

// ---------- choosing ----------

function Choose({ library }: { library: LibrarySummary }) {
  const [act, busy] = useAct()
  const [liked, setLiked] = useState(library.liked > 0)
  const [picked, setPicked] = useState(() => new Set(library.playlists.map((p) => p.id)))
  const [albums, setAlbums] = useState(library.albums.length > 0)
  const [artists, setArtists] = useState(library.artists.length > 0)
  const [find, setFind] = useState('')
  const shown = useMemo(
    () => library.playlists.filter((p) => `${p.title} ${p.owner}`.toLowerCase().includes(find.trim().toLowerCase())),
    [library.playlists, find]
  )
  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const allShown = shown.length > 0 && shown.every((p) => picked.has(p.id))
  const pickShown = (on: boolean) =>
    setPicked((s) => {
      const next = new Set(s)
      shown.forEach((p) => (on ? next.add(p.id) : next.delete(p.id)))
      return next
    })
  const songs = (liked ? library.liked : 0) + library.playlists.filter((p) => picked.has(p.id)).reduce((x, p) => x + p.count, 0)
  const parts = [
    songs && plural(songs, 'song'),
    picked.size && plural(picked.size, 'playlist'),
    albums && library.albums.length && plural(library.albums.length, 'album'),
    artists && library.artists.length && plural(library.artists.length, 'artist')
  ].filter(Boolean) as string[]
  const selection: Selection = { liked, playlists: [...picked], albums, artists }

  return (
    <>
      <div className="tr-account">
        <span>
          Logged in to Spotify{library.account && <> as <b>{library.account}</b></>}
        </span>
        <button className="link tr-link" onClick={() => act(t.disconnect)}>
          Not you?
        </button>
      </div>

      {!!library.unread?.length && (
        <p className="tr-error">
          Spotify wouldn’t hand over {library.unread.length === 1 ? <>the playlist <b>{library.unread[0]}</b></> : <>{plural(library.unread.length, 'playlist')} ({list(library.unread)})</>}, so{' '}
          {library.unread.length === 1 ? 'it’s' : 'they’re'} left out. Go back and connect again to retry.
        </p>
      )}

      {library.liked > 0 && (
        <section className="tr-group">
          <Pick on={liked} onChange={setLiked} art={<span className="liked-art tr-art"><I.HeartFill size={16} /></span>} title="Liked Songs" sub={`${plural(library.liked, 'song')} · liked on YouTube Music`} />
        </section>
      )}

      {library.playlists.length > 0 && (
        <section className="tr-group">
          <div className="tr-group-head">
            <h2>Playlists</h2>
            <span className="sub">
              {n(picked.size)} of {n(library.playlists.length)} chosen
            </span>
            {library.playlists.length > 8 && (
              <label className="tr-find">
                <I.Search size={14} />
                <input placeholder="Search playlists" value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setFind('')} />
              </label>
            )}
            <button className="outline-btn small" disabled={!shown.length} onClick={() => pickShown(!allShown)}>
              {allShown ? 'Choose none' : 'Choose all'}
            </button>
          </div>
          {shown.map((p) => (
            <Pick
              key={p.id}
              on={picked.has(p.id)}
              onChange={() => toggle(p.id)}
              art={<Img src={p.thumb} className="tr-art" />}
              title={p.title}
              sub={[p.owner && `By ${p.owner}`, plural(p.count, 'song')].filter(Boolean).join(' · ')}
              tag={p.linked ? 'Imported before: adds new songs only' : undefined}
            />
          ))}
          {!shown.length && <p className="sub tr-empty">No playlists match “{find}”.</p>}
        </section>
      )}

      {(library.albums.length > 0 || library.artists.length > 0) && (
        <section className="tr-group">
          {library.albums.length > 0 && (
            <Pick
              on={albums}
              onChange={setAlbums}
              art={<Stack images={library.albums.map((a) => a.thumb)} icon={<I.Album size={16} />} />}
              title="Saved albums"
              sub={`${plural(library.albums.length, 'album')} · saved to your library`}
            />
          )}
          {library.artists.length > 0 && (
            <Pick
              on={artists}
              onChange={setArtists}
              art={<Stack images={library.artists.map((a) => a.thumb)} icon={<I.Artist size={16} />} round />}
              title="Followed artists"
              sub={`${plural(library.artists.length, 'artist')} · subscribed to on YouTube Music`}
            />
          )}
        </section>
      )}

      <div className="tr-footer">
        <div className="tr-footer-text">
          <b>{parts.length ? `Import ${list(parts)}` : 'Choose what to import'}</b>
          <span className="sub">Playlists are added as private. Keep listening while it runs.</span>
        </div>
        <button className="outline-btn" disabled={busy} onClick={() => act(t.reset)}>
          Back
        </button>
        <button className="pill-btn tr-primary green-btn" disabled={busy || !parts.length} onClick={() => act(() => t.start(selection))}>
          Import
        </button>
      </div>
    </>
  )
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const list = (parts: string[]) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`)

function Pick(p: { on: boolean; onChange: (on: boolean) => void; art: React.ReactNode; title: string; sub: string; tag?: string }) {
  return (
    <button className={`tr-pick ${p.on ? 'on' : ''}`} role="checkbox" aria-checked={p.on} onClick={() => p.onChange(!p.on)}>
      <span className="tr-check">{p.on && <I.Check size={14} />}</span>
      {p.art}
      <span className="tr-pick-text">
        <span className="tr-pick-title">{p.title}</span>
        <span className="sub">
          {p.sub}
          {p.tag && <span className="tr-tag">{p.tag}</span>}
        </span>
      </span>
    </button>
  )
}

// A few covers fanned out, for "Saved albums" and "Followed artists".
function Stack({ images, icon, round }: { images: string[]; icon: React.ReactNode; round?: boolean }) {
  const shown = images.filter(Boolean).slice(0, 3)
  if (!shown.length) return <span className="tr-art tr-icon-art">{icon}</span>
  return (
    <span className={`tr-art tr-stack ${round ? 'round-stack' : ''}`}>
      {shown.map((src, i) => (
        <Img key={i} src={src} artist={round} />
      ))}
    </span>
  )
}

// ---------- importing ----------

function useNow(every: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(id)
  }, [every])
  return now
}

// "About 4 min left", from how fast this run has gone so far.
function timeLeft(s: TransferState, now: number): string {
  const items = s.items ?? []
  const done = items.reduce((x, i) => x + Math.min(i.done, i.total), 0)
  const total = items.reduce((x, i) => x + i.total, 0)
  const ran = (now - (s.startedAt ?? now)) / 1000
  const did = done - (s.doneAtStart ?? 0)
  if (ran < 5 || did < 10) return 'Working out how long it’ll take…'
  const left = ((total - done) / did) * ran
  if (left < 60) return 'Less than a minute left'
  const min = Math.round(left / 60)
  return min < 90 ? `About ${min} min left` : `About ${Math.round(min / 60)} h left`
}

function Moving({ state }: { state: TransferState }) {
  const [act, busy] = useAct()
  const now = useNow(1000)
  const items = state.items ?? []
  const current = items.find((i) => i.status === 'working')
  const pct = Math.floor(progress(state) * 100)
  const moved = items.reduce((x, i) => x + i.moved, 0)
  const missing = items.reduce((x, i) => x + i.missing.length, 0)
  const unsure = items.reduce((x, i) => x + i.unsure.length, 0)
  return (
    <>
      <section className="tr-panel tr-progress">
        <div className="tr-progress-head">
          <span className="tr-pct">{pct}%</span>
          <div className="tr-progress-text">
            <b>{current ? `Importing ${current.title}` : 'Importing…'}</b>
            <span className="sub">{timeLeft(state, now)}</span>
          </div>
          <button className="outline-btn" disabled={busy} onClick={() => act(t.stop)}>
            Stop
          </button>
        </div>
        <div className="tr-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <p className="sub tr-counts">
          {n(moved)} added{missing > 0 && <> · {n(missing)} not found</>}
          {unsure > 0 && <> · {n(unsure)} to check</>}
        </p>
        <p className="sub tr-fine">Keep listening and browsing: the import carries on in the background, even if you leave this page.</p>
      </section>
      <Items items={items} />
    </>
  )
}

function Items({ items }: { items: TransferItem[] }) {
  const { go } = useApp()
  const open = (i: TransferItem) => (i.kind === 'liked' ? go({ name: 'playlist', id: 'LM' }) : i.target && go({ name: 'playlist', id: i.target }))
  return (
    <section className="tr-group tr-items">
      {items.map((i) => {
        const openable = i.kind === 'liked' ? i.moved > 0 : !!i.target
        return (
          <div key={i.id} className={`tr-item ${i.status} ${openable ? 'openable' : ''}`} onClick={() => openable && open(i)} title={openable ? `Open ${i.title}` : undefined}>
            <ItemArt item={i} />
            <span className="tr-pick-text">
              <span className="tr-pick-title">{i.title}</span>
              <span className="sub">{status(i)}</span>
            </span>
            <span className="tr-item-state">
              {i.status === 'working' && <span className="tr-spinner small" />}
              {i.status === 'done' && <I.Check size={16} className="green" />}
              {i.status === 'failed' && <I.Close size={14} />}
              {i.status === 'working' && <span className="tr-mini" style={{ '--done': i.total ? i.done / i.total : 0 } as React.CSSProperties} />}
            </span>
          </div>
        )
      })}
    </section>
  )
}

function ItemArt({ item }: { item: TransferItem }) {
  if (item.kind === 'liked')
    return (
      <span className="liked-art tr-art">
        <I.HeartFill size={16} />
      </span>
    )
  if (item.kind === 'albums') return <span className="tr-art tr-icon-art"><I.Album size={18} /></span>
  if (item.kind === 'artists') return <span className="tr-art tr-icon-art round"><I.Artist size={18} /></span>
  return <Img src={item.thumb} className="tr-art" />
}

const noun = (i: TransferItem) => (i.kind === 'albums' ? 'album' : i.kind === 'artists' ? 'artist' : 'song')
const verb = (i: TransferItem) => (i.kind === 'albums' ? 'saved' : i.kind === 'artists' ? 'followed' : i.kind === 'liked' ? 'liked' : 'added')

function status(i: TransferItem): string {
  if (i.status === 'waiting') return i.done ? `${n(i.done)} of ${plural(i.total, noun(i))} so far` : plural(i.total, noun(i))
  if (i.status === 'working') return `${n(i.done)} of ${plural(i.total, noun(i))}`
  if (i.status === 'failed') return i.error ?? 'Couldn’t import this'
  const skipped = i.done - i.moved - i.missing.length
  const parts = [i.moved > 0 && `${n(i.moved)} ${verb(i)}`, i.missing.length > 0 && `${n(i.missing.length)} not found`, skipped > 0 && `${n(skipped)} already there`]
  return parts.filter(Boolean).join(' · ') || `0 ${verb(i)}`
}

// ---------- results ----------

function Results({ state }: { state: TransferState }) {
  const [act, busy] = useAct()
  const items = state.items ?? []
  const done = state.phase === 'done'
  const failed = items.some((i) => i.status === 'failed')
  const songs = items.filter((i) => i.kind === 'liked' || i.kind === 'playlist').reduce((x, i) => x + i.moved, 0)
  const playlists = items.filter((i) => i.kind === 'playlist' && i.target).length
  const albums = items.find((i) => i.kind === 'albums')?.moved ?? 0
  const artists = items.find((i) => i.kind === 'artists')?.moved ?? 0
  const missing = items.reduce((x, i) => x + i.missing.length, 0)
  const unsure = items.reduce((x, i) => x + i.unsure.length, 0)
  const left = [missing > 0 && `${n(missing)} not found`, unsure > 0 && `${n(unsure)} worth a check`].filter(Boolean) as string[]
  // Imported again with nothing new since last time.
  const upToDate = done && !failed && items.every((i) => i.moved === 0)
  const tiles: [number, string][] = (
    [
      [songs, songs === 1 ? 'song added' : 'songs added'],
      [playlists, playlists === 1 ? 'playlist' : 'playlists'],
      [albums, albums === 1 ? 'album saved' : 'albums saved'],
      [artists, artists === 1 ? 'artist followed' : 'artists followed']
    ] as [number, string][]
  ).filter(([x], k) => x > 0 || (k === 0 && !playlists && !albums && !artists))
  const again = () => act(async () => (await t.reset(), await t.connect()))
  const over = () => {
    if (missing && !confirm('Start over? This summary, with the songs that weren’t found, will be cleared. What was imported stays in your library.')) return
    act(t.reset)
  }
  return (
    <>
      <section className="tr-panel">
        <h2>{!done ? 'Import paused' : failed ? 'Imported, with a few problems' : upToDate ? 'Already up to date' : 'Your music is on YouTube Music'}</h2>
        {state.error ? (
          <p className="tr-error">{state.error}</p>
        ) : !done ? (
          <p className="sub">Pick up where it left off whenever you like.</p>
        ) : upToDate ? (
          <p className="sub">Everything you chose was already on YouTube Music.{left.length > 0 && ` ${capital(list(left))}: see below.`}</p>
        ) : (
          left.length > 0 && <p className="sub">{capital(list(left))}: see below.</p>
        )}
        {!upToDate && (
          <div className="tr-tiles">
            {tiles.map(([x, label]) => (
              <div key={label} className="tr-tile">
                <b>{n(x)}</b>
                <span className="sub">{label}</span>
              </div>
            ))}
          </div>
        )}
        <div className="tr-actions">
          {(!done || failed) && (
            <button className="pill-btn tr-primary green-btn" disabled={busy} onClick={() => act(t.resume)}>
              {done ? 'Try again' : 'Resume'}
            </button>
          )}
          {done && (
            <button className={`${failed ? 'outline-btn' : 'pill-btn tr-primary'}`} disabled={busy} onClick={again} title="Adds only what’s new since the last import">
              Import again
            </button>
          )}
          <button className="outline-btn" disabled={busy} onClick={over}>
            Start over
          </button>
        </div>
      </section>
      <Items items={items} />
      {missing > 0 && <NotFound items={items} />}
      {unsure > 0 && <CloseMatches items={items} />}
    </>
  )
}

function NotFound({ items }: { items: TransferItem[] }) {
  const total = items.reduce((x, i) => x + i.missing.length, 0)
  return (
    <section className="tr-group tr-missing">
      <div className="tr-group-head">
        <h2>Not found on YouTube Music</h2>
        <span className="sub">{plural(total, 'item')}. Find a version yourself, or leave them out.</span>
      </div>
      {items
        .filter((i) => i.missing.length)
        .map((i) => (
          <div key={i.id} className="tr-missing-group">
            <h3>{i.title}</h3>
            {i.missing.map((m) => (
              <MissingRow key={m.id} item={i} m={m} />
            ))}
          </div>
        ))}
    </section>
  )
}

function MissingRow({ item, m }: { item: TransferItem; m: Missing }) {
  const { go, toast } = useApp()
  const [open, setOpen] = useState(false)
  const song = item.kind === 'liked' || item.kind === 'playlist'
  const query = `${m.title} ${m.artists.split(', ')[0] ?? ''}`.trim()
  const toggle = () => (song ? setOpen((o) => !o) : go({ name: 'search', q: query }))
  const add = async (c: Candidate) => {
    await t.fix(item.id, m.id, c.videoId)
    toast(item.kind === 'liked' ? 'Added to Liked Songs' : `Added to ${item.title}`)
  }
  return (
    <div className={`tr-missing-row ${open ? 'open' : ''}`}>
      <div className="tr-missing-main">
        <span className="tr-pick-text">
          <span className="tr-pick-title">{m.title}</span>
          <span className="sub">{m.note ?? ([m.artists, m.album].filter(Boolean).join(' · ') || (item.kind === 'artists' ? 'Artist' : ''))}</span>
        </span>
        <button className="outline-btn small" onClick={toggle} aria-expanded={song ? open : undefined}>
          {song ? (open ? 'Close' : 'Find') : 'Search'}
        </button>
      </div>
      {open && <Offers item={item} trackId={m.id} query={query} action="Add" busyLabel="Adding…" onPick={add} onFail={() => setOpen(false)} />}
    </div>
  )
}

// ---------- close matches ----------

function CloseMatches({ items }: { items: TransferItem[] }) {
  const [act, busy] = useAct()
  const total = items.reduce((x, i) => x + i.unsure.length, 0)
  return (
    <section className="tr-group tr-missing tr-checks">
      <div className="tr-group-head">
        <h2>Worth a check</h2>
        <span className="sub">
          {total === 1 ? 'This song was added with a close match, not an exact one.' : `These ${n(total)} songs were added with close matches, not exact ones.`} Play to
          compare, then keep or change {total === 1 ? 'it' : 'them'}.
        </span>
        {total > 1 && (
          <button className="outline-btn small" disabled={busy} onClick={() => act(t.keepAll)}>
            Keep all
          </button>
        )}
      </div>
      {items
        .filter((i) => i.unsure.length)
        .map((i) => (
          <div key={i.id} className="tr-missing-group">
            <h3>{i.title}</h3>
            {i.unsure.map((u) => (
              <CheckRow key={u.id} item={i} u={u} />
            ))}
          </div>
        ))}
    </section>
  )
}

function CheckRow({ item, u }: { item: TransferItem; u: Unsure }) {
  const { toast } = useApp()
  const [act, busy] = useAct()
  const [open, setOpen] = useState(false)
  const query = `${u.title} ${u.artists.split(', ')[0] ?? ''}`.trim()
  const swap = async (c: Candidate) => {
    await t.swap(item.id, u.id, c.videoId)
    toast(item.kind === 'liked' ? 'Changed in Liked Songs' : `Changed in ${item.title}`)
  }
  return (
    <div className={`tr-missing-row tr-check-row ${open ? 'open' : ''}`}>
      <div className="tr-missing-main">
        <span className="tr-pick-text tr-check-from" title="On Spotify">
          <span className="tr-pick-title">{u.title}</span>
          <span className="sub">{[u.artists, u.album].filter(Boolean).join(' · ')}</span>
        </span>
        <I.ChevronRight size={16} className="tr-check-arrow" />
        <span className="tr-check-to" title="Added on YouTube Music">
          <PlayThumb c={u.match} />
          <span className="tr-pick-text">
            <span className="tr-pick-title">{u.match.title}</span>
            <span className="sub">{[u.match.artists, u.match.album, u.match.duration].filter(Boolean).join(' · ')}</span>
          </span>
        </span>
        <button className="outline-btn small" disabled={busy} onClick={() => act(() => t.keep(u.id))} title="This is the right song">
          Keep
        </button>
        <button className="outline-btn small" disabled={busy} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Close' : 'Change'}
        </button>
      </div>
      {open && (
        <Offers item={item} trackId={u.id} query={query} action="Use this" busyLabel="Changing…" exclude={u.match.videoId} onPick={swap} onFail={() => setOpen(false)} />
      )}
    </div>
  )
}

// ---------- picking a song on YouTube Music ----------

function PlayThumb({ c }: { c: Candidate }) {
  const { playTrack } = useApp()
  return (
    <button
      className="tr-offer-play"
      title="Play"
      aria-label={`Play ${c.title}`}
      onClick={() => playTrack({ videoId: c.videoId, title: c.title, artists: c.artists, album: c.album, duration: c.duration, thumb: c.thumb })}
    >
      <Img src={c.thumb} className="tr-art small" />
      <I.Play size={14} />
    </button>
  )
}

// YouTube Music songs to pick from for one Spotify song, searched when opened.
function Offers(p: {
  item: TransferItem
  trackId: string
  query: string
  action: string
  busyLabel: string
  exclude?: string
  onPick: (c: Candidate) => Promise<void>
  onFail: () => void
}) {
  const { go, toast } = useApp()
  const [offers, setOffers] = useState<Candidate[] | null>(null)
  const [picking, setPicking] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    t.find(p.item.id, p.trackId).then(
      (list) => live && setOffers(list.filter((c) => c.videoId !== p.exclude)),
      (e) => {
        if (!live) return
        toast(message(e))
        p.onFail()
      }
    )
    return () => void (live = false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.item.id, p.trackId])
  const pick = async (c: Candidate) => {
    setPicking(c.videoId)
    try {
      await p.onPick(c)
    } catch (e) {
      toast(message(e))
      setPicking(null)
    }
  }
  return (
    <div className="tr-offers">
      {!offers && <span className="sub tr-offers-note">Searching YouTube Music…</span>}
      {offers && !offers.length && <span className="sub tr-offers-note">Nothing {p.exclude ? 'else ' : ''}close on YouTube Music.</span>}
      {offers?.map((c) => (
        <div key={c.videoId} className="tr-offer">
          <PlayThumb c={c} />
          <span className="tr-pick-text">
            <span className="tr-pick-title">{c.title}</span>
            <span className="sub">{[c.artists, c.album, c.duration].filter(Boolean).join(' · ')}</span>
          </span>
          <button className="outline-btn small" disabled={!!picking} onClick={() => pick(c)}>
            {picking === c.videoId ? p.busyLabel : p.action}
          </button>
        </div>
      ))}
      {offers && (
        <button className="link tr-link tr-offers-note" onClick={() => go({ name: 'search', q: p.query })}>
          Search for it yourself
        </button>
      )}
    </div>
  )
}
