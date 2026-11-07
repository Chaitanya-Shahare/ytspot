// Chords as players read them: names spelled for the song's key, transposing, Roman numerals, the
// song's main loops, and how to play each chord on guitar, ukulele or piano. Plain functions (no
// React), so scripts/chord-shapes-test.mjs can check every shape against the notes of its chord.

export type Instrument = 'guitar' | 'ukulele' | 'piano'
export const INSTRUMENTS: { id: Instrument; label: string }[] = [
  { id: 'guitar', label: 'Guitar' },
  { id: 'ukulele', label: 'Ukulele' },
  { id: 'piano', label: 'Piano' }
]

// Chord names as main/chords.ts writes them: a root, then "m" for minor. Roots are read in any
// spelling (C# or Db) and written in the one the key uses (see `spell`).
const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
const PC: Record<string, number> = {}
for (const names of [SHARPS, FLATS]) names.forEach((n, i) => (PC[n] = i))
Object.assign(PC, { Cb: 11, 'B#': 0, Fb: 4, 'E#': 5 })

export function parse(name: string): { root: number; minor: boolean; rest: string } | null {
  const m = name.match(/^([A-G][#b]?)(.*)$/)
  const root = m ? PC[m[1]] : undefined
  return root === undefined ? null : { root, minor: m![2].startsWith('m'), rest: m![2] }
}

// The names a key writes its notes with: sharps in sharp keys (G, D, A, E, B, F# major and their
// relative minors), flats in flat keys (F, Bb, Eb, Ab, Db), and in C major / A minor (or with no
// key) the usual mix: C#, Eb, F#, Ab, Bb.
function namesFor(key: string): string[] {
  const [tonic, mode] = key.split(' ')
  const t = PC[tonic]
  if (t === undefined || (mode !== 'major' && mode !== 'minor')) return NOTES
  const major = mode === 'minor' ? (t + 3) % 12 : t
  return [7, 2, 9, 4, 11, 6].includes(major) ? SHARPS : [5, 10, 3, 8, 1].includes(major) ? FLATS : NOTES
}

// "F#m" up 2 → "Abm". Also takes a key ("A minor").
export function transpose(name: string, by: number): string {
  if (!by || !name) return name
  const [head, ...rest] = name.split(' ')
  const c = parse(head)
  return c ? [NOTES[(c.root + by + 120) % 12] + c.rest, ...rest].join(' ') : name
}

// The song's chords and key transposed by `by` semitones, every name spelled as its key spells
// it: "Abm" is "G#m" in E major, "A#" is "Bb" in F major.
export function respell<T extends { key: string; chords: { name: string }[] }>(song: T, by: number): T {
  const keyRoot = parse(song.key.split(' ')[0])
  const names = namesFor(song.key ? transpose(song.key, by) : '')
  const spell = (name: string) => {
    const c = parse(name)
    return c ? names[(c.root + by + 120) % 12] + c.rest : name
  }
  // The key's own name: its tonic as the key signature writes it (Db major, not C# major).
  const key = keyRoot ? `${spell(song.key.split(' ')[0])} ${song.key.split(' ').slice(1).join(' ')}` : song.key
  return { ...song, key, chords: song.chords.map((c) => ({ ...c, name: spell(c.name) })) }
}

// The notes of a major or minor chord, as pitch classes: root, third, fifth.
export function triad(name: string): number[] {
  const c = parse(name)
  return c ? [c.root, (c.root + (c.minor ? 3 : 4)) % 12, (c.root + 7) % 12] : []
}

// The chord's notes by name: with sharps for a root with a sharp, flats for one with a flat, and
// otherwise as the chord's own key would write them (A C# E, F A C, B D F#, C Eb G).
export function noteNames(name: string): string[] {
  const c = parse(name)
  if (!c) return []
  const acc = name[1]
  const names = acc === '#' ? SHARPS : acc === 'b' ? FLATS : namesFor(`${name[0]} ${c.minor ? 'minor' : 'major'}`)
  return triad(name).map((pc, i) => (i ? names[pc] : name.slice(0, acc === '#' || acc === 'b' ? 2 : 1)))
}

// ---- Roman numerals ----

// Scale degrees by semitones above the tonic. In a minor key the numerals count from its own
// tonic (i, III, iv, VI, VII…), as players of minor-key songs usually call them.
const DEGREES = {
  major: ['I', 'bII', 'II', 'bIII', 'III', 'IV', '#IV', 'V', 'bVI', 'VI', 'bVII', 'VII'],
  minor: ['I', 'bII', 'II', 'III', '#III', 'IV', '#IV', 'V', 'VI', '#VI', 'VII', '#VII']
}

// "Bm" in "F# minor" → "iv": upper case for a major chord, lower for a minor one. '' without a key.
export function numeral(name: string, key: string): string {
  const [tonic, mode] = key.split(' ')
  const t = PC[tonic]
  const c = parse(name)
  if (t === undefined || !c || (mode !== 'major' && mode !== 'minor')) return ''
  const n = DEGREES[mode][(c.root - t + 12) % 12]
  return c.minor ? n.replace(/[IV]+/, (r) => r.toLowerCase()) : n
}

// The song's main chord loops, for jamming along: the run of chords that repeats the most (most of
// the song in it, the shortest loop if several do), then the most-repeated one in what's left (often
// the chorus against the verse). Each comes with how many times it goes round.
export function progressions(chords: { name: string }[]): { loop: string[]; times: number }[] {
  const seq: string[] = []
  for (const c of chords) if (c.name !== seq[seq.length - 1]) seq.push(c.name)
  const used = new Array<boolean>(seq.length).fill(false)
  const out: { loop: string[]; times: number }[] = []
  for (let round = 0; round < 2; round++) {
    let best: { at: number; len: number; times: number } | null = null
    for (let len = 2; len <= 8; len++) {
      const free = (i: number) => !used.slice(i, i + len).some(Boolean)
      const keys = seq.map((_, i) => (i + len <= seq.length && free(i) ? seq.slice(i, i + len).join('|') : ''))
      const seen = new Set<string>()
      for (let at = 0; at + len <= seq.length; at++) {
        const key = keys[at]
        if (!key || seen.has(key)) continue
        seen.add(key)
        // A loop that's a smaller loop twice over ("A B A B") is that smaller loop.
        const w = seq.slice(at, at + len)
        if (len % 2 === 0 && w.slice(0, len / 2).join() === w.slice(len / 2).join()) continue
        let times = 0
        for (let i = at; i + len <= seq.length; ) keys[i] === key ? (times++, (i += len)) : i++
        if (times < 2) continue
        if (!best || times * len > best.times * best.len || (times * len === best.times * best.len && len < best.len)) best = { at, len, times }
      }
    }
    // A second loop only if it's a real part of the song, not a stray pair repeated.
    if (!best || (round && best.times * best.len < seq.length * 0.15)) break
    const w = seq.slice(best.at, best.at + best.len)
    out.push({ loop: w, times: best.times })
    for (let i = 0; i + best.len <= seq.length; ) {
      if (seq.slice(i, i + best.len).join() === w.join()) {
        for (let k = i; k < i + best.len; k++) used[k] = true
        i += best.len
      } else i++
    }
  }
  return out
}

// ---- Fretted shapes: guitar and ukulele ----

// A fretting: per string (lowest-sounding first as drawn, left to right) the fret (0 open, null
// not played) and finger (1–4), plus a barre.
export interface Shape {
  frets: (number | null)[]
  fingers: (number | null)[]
  barre?: { fret: number; from: number; to: number }
}
// A movable shape, as offsets from the fret `r` it's played at: `root` is the string the chord's
// root is on and `at` its fret in the shape. `open` is the fingering when r is 0 (the open chord),
// `fingers` and `barre` (strings, and frets above r) when it's moved up the neck. An `openOnly`
// shape is only played as the open chord.
interface Template {
  root: number
  at: number
  frets: (number | null)[]
  fingers: (number | null)[]
  open: (number | null)[]
  barre?: [number, number] | [number, number, number]
  openOnly?: boolean
}
interface Fretted {
  strings: number[] // the open strings' pitch classes, as drawn left to right
  maxFret: number
  shapes: Record<'major' | 'minor', Template[]>
}
const X = null
const FRETTED: Record<'guitar' | 'ukulele', Fretted> = {
  // Standard tuning, low E to high e. The CAGED shapes guitarists move up the neck.
  guitar: {
    strings: [4, 9, 2, 7, 11, 4],
    maxFret: 15,
    shapes: {
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
  },
  // Standard (re-entrant) tuning G C E A, as a chord chart draws it: G string on the left.
  ukulele: {
    strings: [7, 0, 4, 9],
    maxFret: 12,
    shapes: {
      major: [
        // C 0003, moved up as a full barre with the pinky on the A string (D 2225).
        { root: 1, at: 0, frets: [0, 0, 0, 3], fingers: [1, 1, 1, 4], open: [0, 0, 0, 3], barre: [0, 3] },
        // A 2100 (Bb 3211).
        { root: 3, at: 0, frets: [2, 1, 0, 0], fingers: [3, 2, 1, 1], open: [2, 1, 0, 0], barre: [2, 3] },
        // G 0232 (A 2454).
        { root: 0, at: 0, frets: [0, 2, 3, 2], fingers: [1, 2, 4, 3], open: [0, 1, 3, 2] },
        // F 2010 (F# 3121).
        { root: 2, at: 1, frets: [2, 0, 1, 0], fingers: [3, 1, 2, 1], open: [2, 0, 1, 0], barre: [1, 3] },
        // D 2220 (E 4442).
        { root: 1, at: 2, frets: [2, 2, 2, 0], fingers: [2, 3, 4, 1], open: [1, 2, 3, 0] },
        // E 1402, only as the open chord.
        { root: 2, at: 0, frets: [1, 4, 0, 2], fingers: [1, 4, 0, 2], open: [1, 4, 0, 2], openOnly: true }
      ],
      minor: [
        // Am 2000 (Bbm 3111).
        { root: 3, at: 0, frets: [2, 0, 0, 0], fingers: [3, 1, 1, 1], open: [2, 0, 0, 0], barre: [1, 3] },
        // Dm 2210 (Ebm 3321).
        { root: 1, at: 2, frets: [2, 2, 1, 0], fingers: [3, 4, 2, 1], open: [2, 3, 1, 0] },
        // Gm 0231 (Am 2453).
        { root: 0, at: 0, frets: [0, 2, 3, 1], fingers: [1, 3, 4, 2], open: [0, 2, 3, 1] },
        // Cm 0333, moved up with the ring finger barring three strings (C#m 1444).
        { root: 1, at: 0, frets: [0, 3, 3, 3], fingers: [1, 3, 3, 3], open: [0, 1, 2, 3], barre: [1, 3, 3] },
        // Em 0432 and Fm 1013, only as the open chords.
        { root: 2, at: 0, frets: [0, 4, 3, 2], fingers: [0, 3, 2, 1], open: [0, 3, 2, 1], openOnly: true },
        { root: 2, at: 1, frets: [1, 0, 1, 3], fingers: [1, 0, 2, 4], open: [1, 0, 2, 4], openOnly: true }
      ]
    }
  }
}

export const stringCount = (instrument: 'guitar' | 'ukulele') => FRETTED[instrument].strings.length

// Every position of a major or minor chord on a fretted instrument, lowest on the neck first
// (Ultimate Guitar's order).
export function shapesFor(name: string, instrument: 'guitar' | 'ukulele' = 'guitar'): Shape[] {
  const c = parse(name)
  if (!c) return []
  const { strings, maxFret, shapes } = FRETTED[instrument]
  const out: Shape[] = []
  for (const t of shapes[c.minor ? 'minor' : 'major']) {
    const r = (c.root - strings[t.root] - t.at + 24) % 12
    if (t.openOnly && r) continue
    const frets = t.frets.map((f) => (f === null ? null : f + r))
    if (Math.max(...frets.map((f) => f ?? 0)) > maxFret) continue
    out.push({
      frets,
      fingers: r ? t.fingers : t.open,
      ...(r && t.barre ? { barre: { fret: r + (t.barre[2] ?? 0), from: t.barre[0], to: t.barre[1] } } : {})
    })
  }
  const low = (s: Shape) => Math.min(...s.frets.map((f) => (f === null ? 99 : f)))
  return out.sort((a, b) => low(a) - low(b))
}

// The notes a fretting sounds, as pitch classes (for checking shapes).
export function sounds(shape: Shape, instrument: 'guitar' | 'ukulele'): number[] {
  const strings = FRETTED[instrument].strings
  return shape.frets.flatMap((f, s) => (f === null ? [] : [(strings[s] + f) % 12]))
}

// ---- Piano voicings ----

// A right-hand voicing: the keys (MIDI numbers, middle C = 60) and the fingers on them, named for
// its inversion.
export interface Voicing {
  keys: number[]
  fingers: number[]
  label: string
}

// Root position (root in the octave from middle C) and the two inversions above it, fingered as
// pianists learn them: 1 3 5, 1 2 5, 1 3 5.
export function voicingsFor(name: string): Voicing[] {
  const notes = triad(name)
  if (!notes.length) return []
  const root = 60 + notes[0]
  const above = (pc: number, from: number) => from + ((((pc - from) % 12) + 12) % 12)
  const third = above(notes[1], root), fifth = above(notes[2], root)
  return [
    { keys: [root, third, fifth], fingers: [1, 3, 5], label: 'Root position' },
    { keys: [third, fifth, root + 12], fingers: [1, 2, 5], label: '1st inversion' },
    { keys: [fifth, root + 12, third + 12], fingers: [1, 3, 5], label: '2nd inversion' }
  ]
}
