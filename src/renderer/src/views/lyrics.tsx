import { useEffect, useMemo, useRef, useState } from 'react'
import type { Chords, Lyrics, PlayerState } from '../../../shared/types'
import * as I from '../components/icons'
import { ErrorBox } from '../components/ui'
import { liveClock, setClock, useApp, useCached, useColor } from '../lib'

// Spotify's lyrics colours: upcoming lines dark on a mid-tone of the artwork's colour, the current
// line white, sung lines white at 70%. The average artwork colour is pulled to a fixed saturation
// and lightness so the dark text stays readable on any cover.
export function lyricsBackground(rgb: string): string {
  const [r, g, b] = (rgb.match(/\d+/g) ?? ['83', '83', '83']).map((x) => Number(x) / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  let h = 0
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  const s = d ? d / (1 - Math.abs(max + min - 1)) : 0
  return `hsl(${Math.round(h * 60 + 360) % 360} ${Math.round(Math.min(0.6, Math.max(0.3, s)) * 100)}% 40%)`
}

export function LyricsView() {
  const { player } = useApp()
  if (!player?.videoId)
    return (
      <div className="page lyrics-page">
        <p className="lyrics-note">Play a song to see its lyrics.</p>
      </div>
    )
  return <SongLyrics key={player.videoId} player={player} />
}

// The lyrics filling the full-screen player (Spotify's full-screen lyrics: the Lyrics page's lines
// and colours, starting a quarter of the way down the screen).
export function FullScreenLyrics({ player }: { player: PlayerState }) {
  return <SongLyrics key={player.videoId} player={player} full />
}

// The playing song's lyrics; the Lyrics page and the Now Playing card share one fetch.
function useLyrics(player: PlayerState) {
  const { videoId, title, artist, album, duration } = player
  return useCached<Lyrics | null>(
    `lyrics:${videoId}:${title}`,
    () => window.ytm.lyrics({ videoId, title, artist, album, duration }),
    { revalidate: false }
  )
}

// Jump to a line (and start playing, as Spotify does when you click a lyric).
function seekTo(t: number | undefined, playing: boolean): void {
  if (t === undefined) return
  setClock(t)
  window.ytm.cmd({ type: 'seek', seconds: t })
  if (!playing) window.ytm.cmd({ type: 'toggle' })
}

function SongLyrics({ player, full }: { player: PlayerState; full?: boolean }) {
  const { data, error, retry } = useLyrics(player)
  const { prefs } = useApp()
  const chords = useChords(player.videoId, prefs.chords && prefs.showChords)
  // Placed once per chords update, not on every line change.
  const placed = useMemo(() => (chords && data?.synced ? data.lines.map((_, i) => lineChords(data, chords, i)) : null), [chords, data])
  const bg = lyricsBackground(useColor(player.thumb))
  const active = useActiveLine(data, player.playing)
  const box = useRef<HTMLDivElement>(null)
  // Each song starts at its first line: the page scrolls in the main view, which outlives the song,
  // and unsynced lyrics never scroll themselves.
  const pageRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    pageRef.current?.closest('.main-scroll')?.scrollTo({ top: 0 })
  }, [])
  // Scrolling by hand stops the view following the song until "Sync" is pressed (Spotify).
  const [away, setAway] = useState(false)
  const follow = () => box.current?.children[active]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  useEffect(() => {
    if (active >= 0 && !away) follow()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, away])

  const seek = (t?: number) => {
    seekTo(t, player.playing)
    setAway(false)
  }

  return (
    <div ref={pageRef} className={`page lyrics-page ${full ? 'full' : ''}`} style={{ '--lyrics-bg': bg } as React.CSSProperties} onWheel={() => data?.synced && setAway(true)}>
      {chords && <ChordBar chords={chords} playing={player.playing} />}
      {error && data === undefined ? (
        <ErrorBox error={error} onRetry={retry} />
      ) : data === undefined ? (
        <p className="lyrics-note">Loading lyrics…</p>
      ) : !data?.lines.length ? (
        <div className="lyrics-empty">
          <p className="lyrics-empty-title">No lyrics for this song</p>
          <p className="lyrics-empty-sub">Looks like we don’t have the lyrics for this one yet.</p>
        </div>
      ) : (
        <div className="lyrics-wrap">
          {!data.synced && <p className="lyrics-unsynced">These lyrics aren’t synced to the song yet.</p>}
          <div ref={box} className={`lyrics ${data.synced ? 'synced' : ''} ${placed ? 'jam' : ''}`}>
            {data.lines.map((l, i) => (
              <div
                key={i}
                className={`lyric ${!data.synced ? '' : i === active ? 'active' : i < active ? 'passed' : ''}`}
                onClick={() => data.synced && seek(l.time)}
              >
                {placed ? <ChordLine text={l.text || '♪'} at={placed[i]} /> : l.text || '♪'}
              </div>
            ))}
          </div>
          <p className="lyrics-source">Lyrics provided by {data.source}</p>
          {away && data.synced && (
            <button className="lyrics-sync" onClick={() => setAway(false)}>
              Sync
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// The song's chords (main/chords.ts) while the setting is on: what's known now, then each update.
function useChords(videoId: string, on: boolean): Chords | null {
  const [chords, setChords] = useState<Chords | null>(null)
  useEffect(() => {
    setChords(null)
    if (!on) return
    let live = true
    window.ytm.chords(videoId).then((c) => live && setChords(c))
    const off = window.ytm.onChords((c) => c.videoId === videoId && setChords(c))
    return () => {
      live = false
      off()
    }
  }, [videoId, on])
  return chords
}

// The chords starting during lyric line i (the one already sounding at its start included), each
// at the character its time falls on, moved to the start of that word. Lines only have start
// times, so this assumes the words are sung at an even pace.
function lineChords(data: Lyrics, chords: Chords, i: number): { at: number; name: string }[] {
  const start = data.lines[i].time ?? 0, next = data.lines[i + 1]?.time ?? start + 8
  const text = data.lines[i].text || '♪'
  const out: { at: number; name: string }[] = []
  const during = chords.chords.filter((c) => c.end > start && c.time < next)
  // A chord carried over from the line before gives way to one changing right as the line starts.
  const changesAtStart = during.some((c) => c.time >= start && c.time < start + 0.15 * (next - start))
  for (const c of during) {
    if (c.time < start && changesAtStart) continue
    let at = Math.round((Math.max(0, c.time - start) / (next - start)) * text.length)
    while (at > 0 && at < text.length && text[at - 1] !== ' ') at--
    // Keep labels from running into each other; ones that don't fit trail after the words.
    const prev = out[out.length - 1]
    if (prev) at = Math.max(at, prev.at + prev.name.length + 1)
    if (prev?.name === c.name) continue
    out.push({ at, name: c.name })
  }
  return out
}

function ChordLine({ text, at }: { text: string; at: { at: number; name: string }[] }) {
  const parts: React.ReactNode[] = []
  let from = 0
  for (const [k, c] of at.entries()) {
    const to = Math.min(c.at, text.length)
    parts.push(text.slice(from, to))
    // Past the end of the words: leave room for the label after them.
    const tail = c.at >= text.length
    parts.push(
      <span key={k} className={`chord-at ${tail ? 'tail' : ''}`} style={tail ? { width: `${c.name.length * 0.35 + 0.4}em` } : undefined}>
        <b className="chord">{c.name}</b>
      </span>
    )
    from = to
  }
  parts.push(text.slice(from))
  return <>{parts}</>
}

// The chord sounding now and the ones coming next, for playing along.
function ChordBar({ chords, playing }: { chords: Chords; playing: boolean }) {
  const [t, setT] = useState(() => liveClock(playing))
  useEffect(() => {
    const id = setInterval(() => setT(liveClock(playing)), 100)
    return () => clearInterval(id)
  }, [playing])
  const list = chords.chords
  let i = -1
  while (i + 1 < list.length && list[i + 1].time <= t) i++
  // On a first listen the newest chord ends where the analysis has got to, a second or so behind
  // the song: it's still the one sounding.
  const now = i >= 0 && (list[i].end > t || (i === list.length - 1 && t - list[i].end < 3)) ? list[i] : null
  const coming = list.slice(i + 1, i + 5)
  const soon = coming[0] ? Math.max(0, coming[0].time - t) : 0
  return (
    <div className="chord-bar">
      <div className="chord-now">{now?.name ?? '–'}</div>
      <div className="chord-next">
        {coming.map((c, k) => (
          <span key={k} className="chord-chip" style={k === 0 ? ({ '--soon': Math.min(1, soon / 4) } as React.CSSProperties) : undefined}>
            {c.name}
          </span>
        ))}
        {/* Nothing ahead yet: on a first listen, chords appear as they're heard. */}
        {!coming.length && <span className="chord-wait">Listening for chords…</span>}
      </div>
      <div className="chord-meta">
        {chords.key && <span>Key: {chords.key}</span>}
        <span>{chords.heard >= 0.97 ? 'Whole song heard' : `${Math.round(chords.heard * 100)}% of the song heard`}</span>
      </div>
    </div>
  )
}

// Index of the line being sung. Polls an extrapolated clock a few times a second while the
// lyrics are on screen; the component only re-renders when the line changes.
function useActiveLine(data: Lyrics | null | undefined, playing: boolean): number {
  const [active, setActive] = useState(-1)
  useEffect(() => {
    if (!data?.synced) return
    const tick = () => {
      const t = liveClock(playing) + 0.15
      let i = -1
      while (i + 1 < data.lines.length && (data.lines[i + 1].time ?? 0) <= t) i++
      setActive(i)
    }
    tick()
    // While paused only a seek can move the line, so check far less often.
    const id = setInterval(tick, playing ? 200 : 1000)
    return () => clearInterval(id)
  }, [data, playing])
  return active
}

// Spotify's lyrics card in the Now Playing panel: a few lines around the one being sung, on the
// song's lyrics colour, following along; "Show more" makes it taller, the header opens the full
// Lyrics page, and the full-screen button shows them in the full-screen player.
export function LyricsCard({ player, onOpen, onFull }: { player: PlayerState; onOpen: () => void; onFull: () => void }) {
  const { data } = useLyrics(player)
  const bg = lyricsBackground(useColor(player.thumb))
  const active = useActiveLine(data, player.playing)
  const [more, setMore] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  // Keep the sung line at the top of the card, just below the faded edge (scrolling only the card;
  // a long line can wrap to three rows in this narrow panel).
  // A new song (synced or not) starts from its first line.
  useEffect(() => {
    const box = body.current
    const line = box?.children[Math.max(0, active)] as HTMLElement | undefined
    if (box && line) box.scrollTo({ top: Math.max(0, line.offsetTop - 28), behavior: 'smooth' })
  }, [active, more, player.videoId, data])
  if (!data?.lines.length) return null
  return (
    <div className={`np-card np-lyrics ${more ? 'more' : ''}`} style={{ '--lyrics-bg': bg } as React.CSSProperties}>
      <div className="np-lyrics-head">
        <b className="link" onClick={onOpen}>
          Lyrics
        </b>
        <div className="np-lyrics-actions">
          <button className="np-lyrics-btn" onClick={onOpen}>
            Show lyrics
          </button>
          <button className="np-lyrics-btn icon" onClick={onFull} aria-label="Full screen lyrics" title="Full screen lyrics">
            <I.FullScreen />
          </button>
        </div>
      </div>
      <div ref={body} className={`np-lyrics-body ${data.synced ? 'synced' : ''}`}>
        {data.lines.map((l, i) => (
          <div
            key={i}
            className={`lyric ${!data.synced ? '' : i === active ? 'active' : i < active ? 'passed' : ''}`}
            onClick={() => (data.synced ? seekTo(l.time, player.playing) : onOpen())}
          >
            {l.text || '♪'}
          </div>
        ))}
      </div>
      <div className="np-lyrics-foot">
        <button className="np-lyrics-btn" onClick={() => setMore((m) => !m)}>
          {more ? 'Show less' : 'Show more'}
        </button>
      </div>
    </div>
  )
}
