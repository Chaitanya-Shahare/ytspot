import { useEffect, useRef, useState } from 'react'
import type { Lyrics, PlayerState } from '../../../shared/types'
import { ErrorBox } from '../components/ui'
import { liveClock, setClock, useApp, useCached, useColor } from '../lib'

// Spotify's lyrics colours: upcoming lines dark on a mid-tone of the artwork's colour, the current
// line white, sung lines white at 70%. The average artwork colour is pulled to a fixed saturation
// and lightness so the dark text stays readable on any cover.
function lyricsBackground(rgb: string): string {
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

function SongLyrics({ player }: { player: PlayerState }) {
  const { videoId, title, artist, album, duration } = player
  const { data, error, retry } = useCached<Lyrics | null>(
    `lyrics:${videoId}:${title}`,
    () => window.ytm.lyrics({ videoId, title, artist, album, duration }),
    { revalidate: false }
  )
  const bg = lyricsBackground(useColor(player.thumb))
  const active = useActiveLine(data, player.playing)
  const box = useRef<HTMLDivElement>(null)
  const scrolled = useRef(0)

  // Keep the sung line in view, unless the user just scrolled away to read ahead.
  useEffect(() => {
    if (active < 0 || Date.now() - scrolled.current < 4000) return
    box.current?.children[active]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [active])

  const seek = (t?: number) => {
    if (t === undefined) return
    setClock(t)
    window.ytm.cmd({ type: 'seek', seconds: t })
    if (!player.playing) window.ytm.cmd({ type: 'toggle' })
    scrolled.current = 0
  }

  return (
    <div className="page lyrics-page" style={{ '--lyrics-bg': bg } as React.CSSProperties} onWheel={() => (scrolled.current = Date.now())}>
      {error && data === undefined ? (
        <ErrorBox error={error} onRetry={retry} />
      ) : data === undefined ? (
        <p className="lyrics-note">Loading lyrics…</p>
      ) : !data?.lines.length ? (
        <p className="lyrics-note">Looks like we don’t have the lyrics for this song.</p>
      ) : (
        <div className="lyrics-wrap">
          {!data.synced && <p className="lyrics-unsynced">These lyrics aren’t synced to the song yet.</p>}
          <div ref={box} className={`lyrics ${data.synced ? 'synced' : ''}`}>
            {data.lines.map((l, i) => (
              <div
                key={i}
                className={`lyric ${!data.synced ? '' : i === active ? 'active' : i < active ? 'passed' : ''}`}
                onClick={() => data.synced && seek(l.time)}
              >
                {l.text || '♪'}
              </div>
            ))}
          </div>
          <p className="lyrics-source">Lyrics provided by {data.source}</p>
        </div>
      )}
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
    const id = setInterval(tick, 200)
    return () => clearInterval(id)
  }, [data, playing])
  return active
}
