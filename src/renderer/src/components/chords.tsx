import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { INSTRUMENTS, noteNames, shapesFor, triad, voicingsFor, type Instrument, type Shape, type Voicing } from '../chord-shapes'
import { ChevronLeft, ChevronRight } from './icons'

// A chord box: strings up and down (six for guitar, four for ukulele), frets across, dots with the
// finger to use, a barre as one bar, × and ○ over muted and open strings, and the fret it starts
// at when it's up the neck.
export function ChordDiagram({ shape }: { shape: Shape }) {
  const n = shape.frets.length
  const ROWS = 4, SX = n > 4 ? 17 : 22, SY = 22, L = 26, T = 20
  const played = shape.frets.filter((f): f is number => f !== null && f > 0)
  const max = Math.max(0, ...played)
  const base = max <= ROWS ? 1 : Math.min(...played)
  const y = (fret: number) => T + (fret - base + 0.5) * SY
  const x = (s: number) => L + s * SX
  const w = L + (n - 1) * SX + 12, h = T + ROWS * SY + 6
  return (
    <svg className="chord-diagram" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      {base > 1 && (
        <text className="cd-base" x={L - 8} y={y(base) + 4} textAnchor="end">
          {base}fr
        </text>
      )}
      <line className={base === 1 ? 'cd-nut' : 'cd-fret'} x1={x(0)} x2={x(n - 1)} y1={T} y2={T} />
      {Array.from({ length: ROWS }, (_, i) => (
        <line key={i} className="cd-fret" x1={x(0)} x2={x(n - 1)} y1={T + (i + 1) * SY} y2={T + (i + 1) * SY} />
      ))}
      {shape.frets.map((_, s) => (
        <line key={s} className="cd-string" x1={x(s)} x2={x(s)} y1={T} y2={T + ROWS * SY} />
      ))}
      {shape.frets.map((f, s) =>
        f === null ? (
          <text key={s} className="cd-mark" x={x(s)} y={T - 5.5} textAnchor="middle">
            ×
          </text>
        ) : f === 0 ? (
          <circle key={s} className="cd-open" cx={x(s)} cy={T - 10} r={4} />
        ) : null
      )}
      {shape.barre && (
        <rect className="cd-dot" x={x(shape.barre.from) - 7.5} y={y(shape.barre.fret) - 7.5} width={x(shape.barre.to) - x(shape.barre.from) + 15} height={15} rx={7.5} />
      )}
      {shape.frets.map((f, s) => {
        if (f === null || f === 0) return null
        const inBarre = shape.barre && f === shape.barre.fret && s >= shape.barre.from && s <= shape.barre.to
        const label = (shape.barre && s === shape.barre.from && f === shape.barre.fret) || !inBarre
        return (
          <g key={s}>
            {!inBarre && <circle className="cd-dot" cx={x(s)} cy={y(f)} r={7.5} />}
            {label && shape.fingers[s] ? (
              <text className="cd-finger" x={x(s)} y={y(f) + 4} textAnchor="middle">
                {shape.fingers[s]}
              </text>
            ) : null}
          </g>
        )
      })}
    </svg>
  )
}

// A stretch of piano keyboard (the same for each of a chord's voicings, so flicking through them
// shows the hand moving), with the keys to press dotted and numbered with the finger to use, and
// middle C marked.
const BLACK = [1, 3, 6, 8, 10]
export function KeysDiagram({ voicing, range }: { voicing: Voicing; range: [number, number] }) {
  const WK = 15, H = 64, BH = 40, BW = 9
  const isWhite = (k: number) => !BLACK.includes(((k % 12) + 12) % 12)
  // From the white key below the lowest note to the one above the highest.
  let lo = range[0] - 1, hi = range[1] + 1
  while (!isWhite(lo)) lo--
  while (!isWhite(hi)) hi++
  const whites: number[] = []
  for (let k = lo; k <= hi; k++) if (isWhite(k)) whites.push(k)
  const left = (k: number) => whites.indexOf(k) * WK
  // A black key sits across the line between its two white neighbours.
  const blackX = (k: number) => left(k - 1) + WK - BW / 2
  const blacks: number[] = []
  for (let k = lo; k <= hi; k++) if (!isWhite(k)) blacks.push(k)
  const pressed = new Map(voicing.keys.map((k, i) => [k, voicing.fingers[i]]))
  const w = whites.length * WK + 1
  const dot = (k: number, cx: number, cy: number) => (
    <g key={`d${k}`}>
      <circle className="kd-dot" cx={cx} cy={cy} r={6} />
      <text className="kd-finger" x={cx} y={cy + 3.5} textAnchor="middle">
        {pressed.get(k)}
      </text>
    </g>
  )
  return (
    <svg className="keys-diagram" width={w} height={H + 1} viewBox={`0 0 ${w} ${H + 1}`} aria-hidden>
      {whites.map((k) => (
        <rect key={k} className="kd-white" x={left(k) + 0.5} y={0.5} width={WK} height={H} rx={2} />
      ))}
      {whites.includes(60) && (
        <text className="kd-c4" x={left(60) + WK / 2 + 0.5} y={H - (pressed.has(60) ? 18 : 4)} textAnchor="middle">
          C4
        </text>
      )}
      {blacks.map((k) => (
        <rect key={k} className="kd-black" x={blackX(k)} y={0.5} width={BW} height={BH} rx={1.5} />
      ))}
      {whites.filter((k) => pressed.has(k)).map((k) => dot(k, left(k) + WK / 2 + 0.5, H - 10))}
      {blacks.filter((k) => pressed.has(k)).map((k) => dot(k, blackX(k) + BW / 2, BH - 9))}
    </svg>
  )
}

// The instrument chord shapes are shown for.
export function InstrumentSwitch({ value, onChange }: { value: Instrument; onChange: (i: Instrument) => void }) {
  return (
    <div className="chord-instrument" role="radiogroup" aria-label="Chord shapes for">
      {INSTRUMENTS.map((i) => (
        <button key={i.id} role="radio" aria-checked={value === i.id} className={value === i.id ? 'on' : ''} onClick={() => onChange(i.id)}>
          {i.label}
        </button>
      ))}
    </div>
  )
}

// Hovering a chord name shows how to play it on the chosen instrument, with ‹ › through the other
// positions (or the piano's inversions), as on Ultimate Guitar. `bind(name)` goes on each chord
// name; `popover` is rendered once.
export function useChordShapes(instrument: Instrument): {
  bind: (name: string) => { onMouseEnter: (e: React.MouseEvent) => void; onMouseLeave: () => void }
  popover: React.ReactNode
} {
  const [open, setOpen] = useState<{ name: string; at: DOMRect } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const show = (name: string, el: Element) => {
    clearTimeout(timer.current)
    const at = el.getBoundingClientRect()
    // A moment's hover first, so passing over other chords on the way to the card doesn't switch it.
    timer.current = setTimeout(() => setOpen({ name, at }), open ? 120 : 150)
  }
  const hide = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(null), 200)
  }
  const stay = () => clearTimeout(timer.current)
  return {
    bind: (name) => ({ onMouseEnter: (e) => show(name, e.currentTarget), onMouseLeave: hide }),
    popover:
      open &&
      createPortal(<ShapesCard key={`${instrument}:${open.name}`} name={open.name} instrument={instrument} at={open.at} onEnter={stay} onLeave={hide} />, document.body)
  }
}

// Which position each chord was last shown in (per instrument), so moving between chords keeps
// the player's choice.
const lastPosition = new Map<string, number>()

function ShapesCard({ name, instrument, at, onEnter, onLeave }: { name: string; instrument: Instrument; at: DOMRect; onEnter: () => void; onLeave: () => void }) {
  const shapes = instrument === 'piano' ? [] : shapesFor(name, instrument)
  const voicings = instrument === 'piano' ? voicingsFor(name) : []
  const count = shapes.length || voicings.length
  const memo = `${instrument}:${name}`
  const [i, setI] = useState(() => Math.min(lastPosition.get(memo) ?? 0, Math.max(0, count - 1)))
  const go = (d: number) =>
    setI((n) => {
      const next = (n + d + count) % count
      lastPosition.set(memo, next)
      return next
    })
  const box = useRef<HTMLDivElement>(null)
  // Above the chord name when there's room, else below; kept inside the window.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const w = el.offsetWidth, h = el.offsetHeight, m = 8
    const left = Math.min(Math.max(m, at.left + at.width / 2 - w / 2), window.innerWidth - w - m)
    const top = at.top - h - m >= m ? at.top - h - m : Math.min(at.bottom + m, window.innerHeight - h - m)
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    el.style.visibility = 'visible'
  }, [at])
  if (!count) return null
  const range: [number, number] = [Math.min(...voicings.flatMap((v) => v.keys)), Math.max(...voicings.flatMap((v) => v.keys))]
  // The chord's notes; on piano in the order the voicing plays them, lowest first.
  const notes = noteNames(name), pcs = triad(name)
  const order = voicings[i] ? voicings[i].keys.map((k) => notes[pcs.indexOf(k % 12)]) : notes
  return (
    <div
      ref={box}
      className="chord-card"
      style={{ visibility: 'hidden' }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      role="dialog"
      aria-label={`${name} on ${instrument}`}
    >
      <div className="chord-card-name">{name}</div>
      {voicings[i] ? <KeysDiagram voicing={voicings[i]} range={range} /> : <ChordDiagram shape={shapes[i]} />}
      <div className="chord-card-notes">
        {voicings[i] && <span>{voicings[i].label} · </span>}
        {order.join(' ')}
      </div>
      {count > 1 && (
        <div className="chord-card-nav">
          <button className="icon-btn" onClick={() => go(-1)} aria-label={voicings.length ? 'Previous inversion' : 'Previous position'}>
            <ChevronLeft size={14} />
          </button>
          <span>
            {i + 1} / {count}
          </span>
          <button className="icon-btn" onClick={() => go(1)} aria-label={voicings.length ? 'Next inversion' : 'Next position'}>
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
