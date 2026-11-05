import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight } from './icons'

// Chord names as main/chords.ts writes them: a root from NOTES, then "m" for minor.
const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const parse = (name: string) => {
  const m = name.match(/^([A-G][#b]?)(.*)$/)
  const root = m ? NOTES.indexOf(m[1]) : -1
  return root < 0 ? null : { root, minor: m![2].startsWith('m') }
}

// "F#m" up 2 → "Abm". Also takes a key ("A minor").
export function transpose(name: string, by: number): string {
  if (!by || !name) return name
  const [head, ...rest] = name.split(' ')
  const m = head.match(/^([A-G][#b]?)(.*)$/)
  const root = m ? NOTES.indexOf(m[1]) : -1
  if (root < 0) return name
  return [NOTES[(root + by + 120) % 12] + m![2], ...rest].join(' ')
}

// ---- Chord shapes ----

// Strings low E to high e, as pitch classes.
const OPEN = [4, 9, 2, 7, 11, 4]
// A fretting: per string the fret (0 open, null not played) and finger (1–4), plus a barre.
export interface Shape {
  frets: (number | null)[]
  fingers: (number | null)[]
  barre?: { fret: number; from: number; to: number }
}
// The movable shapes guitarists use (CAGED), each as offsets from the fret `r` its root string is
// played at: `root` is that string and `at` where the root sits in the shape. `open` is the
// fingering when r is 0 (the open chord), `fingers` and `barre` (strings) when it's moved up.
interface Template {
  root: number
  at: number
  frets: (number | null)[]
  fingers: (number | null)[]
  open: (number | null)[]
  barre?: [number, number]
  openOnly?: boolean
}
const X = null
const TEMPLATES: Record<'major' | 'minor', Template[]> = {
  major: [
    { root: 0, at: 0, frets: [0, 2, 2, 1, 0, 0], fingers: [1, 3, 4, 2, 1, 1], open: [0, 2, 3, 1, 0, 0], barre: [0, 5] },
    { root: 1, at: 0, frets: [X, 0, 2, 2, 2, 0], fingers: [X, 1, 2, 3, 4, 1], open: [X, 0, 1, 2, 3, 0], barre: [1, 5] },
    { root: 1, at: 3, frets: [X, 3, 2, 0, 1, 0], fingers: [X, 4, 3, 1, 2, 1], open: [X, 3, 2, 0, 1, 0], barre: [3, 5] },
    { root: 2, at: 0, frets: [X, X, 0, 2, 3, 2], fingers: [X, X, 1, 2, 4, 3], open: [X, X, 0, 1, 3, 2] },
    { root: 0, at: 3, frets: [3, 2, 0, 0, 0, 3], fingers: [2, 1, 0, 0, 0, 3], open: [2, 1, 0, 0, 0, 3], openOnly: true }
  ],
  minor: [
    { root: 0, at: 0, frets: [0, 2, 2, 0, 0, 0], fingers: [1, 3, 4, 1, 1, 1], open: [0, 2, 3, 0, 0, 0], barre: [0, 5] },
    { root: 1, at: 0, frets: [X, 0, 2, 2, 1, 0], fingers: [X, 1, 3, 4, 2, 1], open: [X, 0, 2, 3, 1, 0], barre: [1, 5] },
    { root: 2, at: 0, frets: [X, X, 0, 2, 3, 1], fingers: [X, X, 1, 3, 4, 2], open: [X, X, 0, 2, 3, 1] }
  ]
}

// Every position of a major or minor chord, lowest on the neck first (Ultimate Guitar's order).
export function shapesFor(name: string): Shape[] {
  const c = parse(name)
  if (!c) return []
  const out: Shape[] = []
  for (const t of TEMPLATES[c.minor ? 'minor' : 'major']) {
    const r = (c.root - OPEN[t.root] - t.at + 24) % 12
    if (t.openOnly && r) continue
    const frets = t.frets.map((f) => (f === null ? null : f + r))
    if (Math.max(...frets.map((f) => f ?? 0)) > 15) continue
    out.push({
      frets,
      fingers: r ? t.fingers : t.open,
      ...(r && t.barre ? { barre: { fret: r, from: t.barre[0], to: t.barre[1] } } : {})
    })
  }
  const low = (s: Shape) => Math.min(...s.frets.map((f) => (f === null ? 99 : f)))
  return out.sort((a, b) => low(a) - low(b))
}

// A chord box: strings up and down, frets across, dots with the finger to use, a barre as one bar,
// × and ○ over muted and open strings, and the fret it starts at when it's up the neck.
export function ChordDiagram({ shape }: { shape: Shape }) {
  const ROWS = 4, SX = 17, SY = 22, L = 26, T = 20
  const played = shape.frets.filter((f): f is number => f !== null && f > 0)
  const max = Math.max(0, ...played)
  const base = max <= ROWS ? 1 : Math.min(...played)
  const y = (fret: number) => T + (fret - base + 0.5) * SY
  const x = (s: number) => L + s * SX
  return (
    <svg className="chord-diagram" width={L + 5 * SX + 12} height={T + ROWS * SY + 6} viewBox={`0 0 ${L + 5 * SX + 12} ${T + ROWS * SY + 6}`} aria-hidden>
      {base > 1 && (
        <text className="cd-base" x={L - 8} y={y(base) + 4} textAnchor="end">
          {base}fr
        </text>
      )}
      <line className={base === 1 ? 'cd-nut' : 'cd-fret'} x1={x(0)} x2={x(5)} y1={T} y2={T} />
      {Array.from({ length: ROWS }, (_, i) => (
        <line key={i} className="cd-fret" x1={x(0)} x2={x(5)} y1={T + (i + 1) * SY} y2={T + (i + 1) * SY} />
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

// Hovering a chord name shows its shape, with ‹ › through the other positions, as on Ultimate
// Guitar. `bind(name)` goes on each chord name; `popover` is rendered once.
export function useChordShapes(): { bind: (name: string) => { onMouseEnter: (e: React.MouseEvent) => void; onMouseLeave: () => void }; popover: React.ReactNode } {
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
    popover: open && createPortal(<ShapesCard key={open.name} name={open.name} at={open.at} onEnter={stay} onLeave={hide} />, document.body)
  }
}

// Which position each chord was last shown in, so moving between chords keeps the player's choice.
const lastPosition = new Map<string, number>()

function ShapesCard({ name, at, onEnter, onLeave }: { name: string; at: DOMRect; onEnter: () => void; onLeave: () => void }) {
  const shapes = shapesFor(name)
  const [i, setI] = useState(() => Math.min(lastPosition.get(name) ?? 0, Math.max(0, shapes.length - 1)))
  const go = (d: number) => setI((n) => {
    const next = (n + d + shapes.length) % shapes.length
    lastPosition.set(name, next)
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
  if (!shapes.length) return null
  return (
    <div ref={box} className="chord-card" style={{ visibility: 'hidden' }} onMouseEnter={onEnter} onMouseLeave={onLeave} role="dialog" aria-label={`${name} chord shapes`}>
      <div className="chord-card-name">{name}</div>
      <ChordDiagram shape={shapes[i]} />
      {shapes.length > 1 && (
        <div className="chord-card-nav">
          <button className="icon-btn" onClick={() => go(-1)} aria-label="Previous position">
            <ChevronLeft size={14} />
          </button>
          <span>
            {i + 1} / {shapes.length}
          </span>
          <button className="icon-btn" onClick={() => go(1)} aria-label="Next position">
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
