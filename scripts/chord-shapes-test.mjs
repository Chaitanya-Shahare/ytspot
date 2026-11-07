// Checks src/renderer/src/chord-shapes.ts: every guitar and ukulele shape and piano voicing of all
// 24 major and minor chords plays exactly that chord's notes and can be fingered, and names are
// spelled for their key.   node scripts/chord-shapes-test.mjs
import assert from 'node:assert/strict'

const S = await import(new URL('../src/renderer/src/chord-shapes.ts', import.meta.url).href)

const ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const CHORDS = ROOTS.flatMap((r) => [r, `${r}m`])
const same = (a, b) => [...new Set(a)].sort().join() === [...new Set(b)].sort().join()
let checked = 0

for (const instrument of ['guitar', 'ukulele']) {
  const max = instrument === 'guitar' ? 15 : 12
  for (const name of CHORDS) {
    const shapes = S.shapesFor(name, instrument)
    assert.ok(shapes.length >= 2, `${instrument} ${name}: only ${shapes.length} shapes`)
    const lows = shapes.map((s) => Math.min(...s.frets.map((f) => (f === null ? 99 : f))))
    assert.deepEqual(lows, [...lows].sort((a, b) => a - b), `${instrument} ${name}: not lowest first`)
    for (const shape of shapes) {
      const where = `${instrument} ${name} ${shape.frets.map((f) => f ?? 'x').join('-')}`
      assert.equal(shape.frets.length, S.stringCount(instrument), where)
      // Exactly the chord's three notes, all of them.
      assert.ok(same(S.sounds(shape, instrument), S.triad(name)), `${where}: sounds ${S.sounds(shape, instrument)} not ${S.triad(name)}`)
      const fretted = shape.frets.filter((f) => f !== null && f > 0)
      assert.ok(Math.max(...shape.frets.map((f) => f ?? 0)) <= max, `${where}: past fret ${max}`)
      assert.ok(Math.max(...fretted) - Math.min(...fretted) <= 4, `${where}: too wide a stretch`)
      // A finger on every fretted string and none on open or muted ones; at most four fingers, each
      // on one fret (a barre is one finger across several strings at the same fret).
      const used = new Map()
      shape.frets.forEach((f, s) => {
        const finger = shape.fingers[s]
        if (f === null || f === 0) return assert.ok(!finger, `${where}: finger on an open or muted string`)
        assert.ok(finger >= 1 && finger <= 4, `${where}: no finger on string ${s}`)
        if (used.has(finger)) assert.equal(used.get(finger), f, `${where}: finger ${finger} on two frets`)
        used.set(finger, f)
      })
      if (shape.barre) {
        const { fret, from, to } = shape.barre
        for (let s = from; s <= to; s++) assert.ok(shape.frets[s] !== null && shape.frets[s] >= fret, `${where}: barre over string ${s}`)
        assert.equal(shape.frets[from], fret, `${where}: barre doesn't start on a string it frets`)
      }
      // On guitar the lowest string played is the root (no accidental inversions).
      if (instrument === 'guitar') {
        const low = shape.frets.findIndex((f) => f !== null)
        assert.equal(([4, 9, 2, 7, 11, 4][low] + shape.frets[low]) % 12, S.triad(name)[0], `${where}: lowest note isn't the root`)
      }
      checked++
    }
  }
}

// Shapes players know by heart come out as they know them.
const frets = (name, inst) => S.shapesFor(name, inst).map((s) => s.frets.map((f) => f ?? 'x').join(''))
assert.ok(frets('C', 'guitar').includes('x32010'))
assert.ok(frets('G', 'guitar').includes('320003'))
assert.ok(frets('F', 'guitar').includes('133211'))
assert.ok(frets('Bm', 'guitar').includes('x24432'))
assert.deepEqual(S.shapesFor('C', 'ukulele')[0].frets, [0, 0, 0, 3])
assert.ok(frets('G', 'ukulele').includes('0232'))
assert.ok(frets('F', 'ukulele').includes('2010'))
assert.ok(frets('Am', 'ukulele').includes('2000'))
assert.ok(frets('Bb', 'ukulele').includes('3211'))
assert.ok(frets('E', 'ukulele').includes('1402'))
assert.ok(frets('Em', 'ukulele').includes('0432'))
assert.ok(frets('D', 'ukulele').includes('2220'))

// Piano: root position and both inversions, each exactly the chord, rising, within an octave.
for (const name of CHORDS) {
  const v = S.voicingsFor(name)
  assert.deepEqual(v.map((x) => x.label), ['Root position', '1st inversion', '2nd inversion'])
  for (const x of v) {
    assert.ok(same(x.keys.map((k) => k % 12), S.triad(name)), `piano ${name} ${x.label}`)
    assert.deepEqual(x.keys, [...x.keys].sort((a, b) => a - b), `piano ${name} ${x.label} not rising`)
    assert.ok(x.keys[2] - x.keys[0] <= 12, `piano ${name} ${x.label} wider than an octave`)
    checked++
  }
  assert.equal(v[0].keys[0] % 12, S.triad(name)[0])
  assert.ok(v[0].keys[0] >= 60 && v[0].keys[0] < 72)
}
assert.deepEqual(S.voicingsFor('C')[0].keys, [60, 64, 67])
assert.deepEqual(S.voicingsFor('Am')[1].keys, [72, 76, 81])

// Names spelled for the key.
const song = (key, ...names) => ({ key, chords: names.map((name) => ({ name, time: 0, end: 1 })) })
const names = (s) => [s.key, ...s.chords.map((c) => c.name)].join(' ')
assert.equal(names(S.respell(song('E major', 'E', 'Abm', 'C#m', 'Eb', 'B'), 0)), 'E major E G#m C#m D# B')
assert.equal(names(S.respell(song('F major', 'F', 'Bb', 'C', 'Dm'), 0)), 'F major F Bb C Dm')
assert.equal(names(S.respell(song('C# major', 'C#', 'F#', 'Ab', 'Bbm'), 0)), 'Db major Db Gb Ab Bbm')
assert.equal(names(S.respell(song('F# minor', 'F#m', 'D', 'A', 'E'), 0)), 'F# minor F#m D A E')
assert.equal(names(S.respell(song('A minor', 'Am', 'F', 'C', 'G'), 1)), 'Bb minor Bbm Gb Db Ab')
assert.equal(names(S.respell(song('A minor', 'Am', 'F', 'C', 'G'), 0)), 'A minor Am F C G')
assert.equal(names(S.respell(song('', 'Am', 'C#'), 0)), ' Am C#')
assert.equal(S.numeral('G#m', 'E major'), 'iii')
assert.equal(S.numeral('Bb', 'F major'), 'IV')
assert.equal(S.numeral('D#', 'E major'), 'VII')
assert.equal(S.transpose('F#m', 2), 'Abm')
assert.deepEqual(S.noteNames('A'), ['A', 'C#', 'E'])
assert.deepEqual(S.noteNames('F'), ['F', 'A', 'C'])
assert.deepEqual(S.noteNames('Bbm'), ['Bb', 'Db', 'F'])
assert.deepEqual(S.noteNames('G#m'), ['G#', 'B', 'D#'])
assert.deepEqual(S.noteNames('Cm'), ['C', 'Eb', 'G'])
assert.deepEqual(S.noteNames('B'), ['B', 'D#', 'F#'])
assert.deepEqual(S.noteNames('Db'), ['Db', 'F', 'Ab'])

// Loops.
assert.deepEqual(S.progressions(['C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F'].map((name) => ({ name }))), [{ loop: ['C', 'G', 'Am', 'F'], times: 3 }])

console.log(`ok: ${checked} shapes and voicings, spelling, numerals and loops`)
