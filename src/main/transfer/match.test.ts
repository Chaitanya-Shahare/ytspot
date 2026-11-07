// Run with `npm test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { albumScore, artistNameScore, best, core, flags, fold, people, queries, score, seconds, type Candidate, type SongInfo } from './match.ts'

const song = (title: string, artists: string[], ms: number, album = ''): SongInfo => ({ title, artists, ms, album })
const cand = (title: string, artists: string, duration: string, extra: Partial<Candidate> = {}): Candidate => ({
  videoId: `${title}|${artists}|${duration}`,
  title,
  artists,
  duration,
  ...extra
})

test('fold drops accents, case and punctuation but keeps every script', () => {
  assert.equal(fold('Beyoncé — Déjà Vu!'), 'beyonce deja vu')
  assert.equal(fold("Don't Stop Me Now"), 'dont stop me now')
  assert.equal(fold('Simon & Garfunkel'), 'simon and garfunkel')
  assert.equal(fold('केसरिया'), 'केसरिया')
  assert.equal(fold('夜に駆ける'), '夜に駆ける')
})

test('core strips release notes and featured artists, not names', () => {
  assert.equal(core('Kesariya (From "Brahmastra")'), 'kesariya')
  assert.equal(core('Here Comes The Sun - Remastered 2009'), 'here comes the sun')
  assert.equal(core('Mr. Brightside - 2023 Remaster'), 'mr brightside')
  assert.equal(core('Stay (with Justin Bieber)'), 'stay')
  assert.equal(core('Peaches (feat. Daniel Caesar & Giveon)'), 'peaches')
  assert.equal(core('Rockstar feat. 21 Savage'), 'rockstar')
  assert.equal(core('Blinding Lights (Official Video)'), 'blinding lights')
  assert.equal(core("(I Can't Get No) Satisfaction"), 'i cant get no satisfaction')
  assert.equal(core('Hotel California - Live'), 'hotel california live')
  assert.equal(core('Song 2'), 'song 2')
})

test('flags tell recordings apart', () => {
  assert.deepEqual([...flags('Levitating (Remix)')], ['remix'])
  assert.deepEqual([...flags('Shape of You - Acoustic')], ['acoustic'])
  assert.deepEqual([...flags('Love Story (Taylor’s Version)')], ['taylors'])
  assert.deepEqual([...flags('Die For You - Sped Up')], ['sped'])
  assert.equal(flags('Blinding Lights').size, 0)
})

test('people splits credits and channel names', () => {
  assert.deepEqual(people('Daft Punk, Pharrell Williams & Nile Rodgers'), ['daft punk', 'pharrell williams', 'nile rodgers'])
  assert.deepEqual(people('Adele - Topic'), ['adele'])
  assert.deepEqual(people('TaylorSwiftVEVO'), ['taylorswift'])
})

test('seconds', () => {
  assert.equal(seconds('3:45'), 225)
  assert.equal(seconds('1:02:03'), 3723)
  assert.ok(Number.isNaN(seconds('')))
})

test('the same song scores high', () => {
  const s = song('Blinding Lights', ['The Weeknd'], 200040, 'After Hours')
  assert.ok(score(s, cand('Blinding Lights', 'The Weeknd', '3:20', { album: 'After Hours' })) > 0.95)
})

test('remasters, soundtracks and features still match', () => {
  assert.ok(score(song('Here Comes The Sun - Remastered 2009', ['The Beatles'], 185733), cand('Here Comes The Sun', 'The Beatles', '3:06')) > 0.9)
  assert.ok(score(song('Kesariya (From "Brahmastra")', ['Pritam', 'Arijit Singh', 'Amitabh Bhattacharya'], 268000), cand('Kesariya', 'Arijit Singh & Pritam', '4:28')) > 0.9)
  assert.ok(score(song('Peaches (feat. Daniel Caesar & Giveon)', ['Justin Bieber', 'Daniel Caesar', 'Giveon'], 198000), cand('Peaches (feat. Daniel Caesar & Giveon)', 'Justin Bieber', '3:18')) > 0.8)
})

test('duos and bands named with “&” are one artist', () => {
  assert.ok(score(song('Maneater', ['Daryl Hall & John Oates'], 273000), cand('Maneater', 'Daryl Hall & John Oates', '4:33')) >= 0.94)
  assert.ok(score(song('Could You Be Loved', ['Bob Marley & The Wailers'], 237000), cand('Could You Be Loved', 'Bob Marley & The Wailers', '3:57')) >= 0.94)
})

test('a music video by the artist matches when there is no song', () => {
  const s = song('Gangnam Style', ['PSY'], 219000)
  const v = cand('PSY - GANGNAM STYLE(강남스타일) M/V', 'officialpsy', '4:13', { video: true })
  // The video runs longer than the song; still the right one if nothing better turns up.
  assert.ok(score(s, v) >= 0.5)
  const right = cand('Gangnam Style', 'PSY', '3:39', { video: false })
  assert.equal(best(s, [v, right])?.videoId, right.videoId)
})

test('a different recording loses to the original', () => {
  const s = song('Levitating', ['Dua Lipa'], 203064)
  const remix = cand('Levitating (feat. DaBaby)', 'Dua Lipa', '3:23')
  const other = cand('Levitating (The Blessed Madonna Remix)', 'Dua Lipa', '5:13')
  const live = cand('Levitating (Live)', 'Dua Lipa', '3:30')
  assert.ok(score(s, other) < 0.62, 'remix rejected')
  assert.ok(score(s, live) < score(s, remix))
  assert.equal(best(s, [other, live, remix])?.videoId, remix.videoId)
})

test('the same title by someone else is rejected', () => {
  const s = song('Hello', ['Adele'], 295502)
  assert.equal(best(s, [cand('Hello', 'Lionel Richie', '4:11')]), null)
  assert.equal(best(s, [cand('Someone Like You', 'Adele', '4:45')]), null)
})

test('a cover with the same title and length is rejected', () => {
  const s = song('Bohemian Rhapsody - Remastered 2011', ['Queen'], 354320, 'A Night At The Opera')
  assert.equal(best(s, [cand('Bohemian Rhapsody', 'NJTP Band', '5:54')]), null)
  assert.equal(best(s, [cand('Queen Bohemian Rhapsody', 'Idol artist', '5:53')]), null)
  assert.ok(best(s, [cand('Bohemian Rhapsody', 'Queen', '5:55', { album: 'A Night At The Opera' })]))
})

test('an artist named only in the title counts', () => {
  assert.ok(best(song('Cellar', ['Silvenna'], 164000), [cand('Cellar (feat. Silvenna)', '', '2:44')]))
})

test('a short title isn’t matched by a longer one by another artist', () => {
  const s = song('Stay', ['Rihanna', 'Mikky Ekko'], 240706)
  assert.equal(best(s, [cand('Stay (with Justin Bieber)', 'The Kid LAROI & Justin Bieber', '2:22')]), null)
  assert.ok(best(s, [cand('Stay (feat. Mikky Ekko)', 'Rihanna', '4:01')]))
})

test('Taylor’s Version is kept apart from the original', () => {
  const s = song('Love Story (Taylor’s Version)', ['Taylor Swift'], 235767)
  const old = cand('Love Story', 'Taylor Swift', '3:56')
  const tv = cand("Love Story (Taylor's Version)", 'Taylor Swift', '3:56')
  assert.equal(best(s, [old, tv])?.videoId, tv.videoId)
})

test('nothing to pick from', () => {
  assert.equal(best(song('Anything', ['Anyone'], 1000), []), null)
})

test('queries search the plain title with the main artist first', () => {
  assert.deepEqual(queries(song('Kesariya (From "Brahmastra")', ['Pritam', 'Arijit Singh'], 0)), [
    'Kesariya Pritam',
    'Kesariya (From "Brahmastra") Pritam Arijit Singh'
  ])
  assert.deepEqual(queries(song('Yellow', ['Coldplay'], 0)), ['Yellow Coldplay'])
})

test('albums and artists', () => {
  assert.ok(albumScore({ title: 'Abbey Road (Remastered)', artists: ['The Beatles'] }, { title: 'Abbey Road', subtitle: 'Album • The Beatles • 1969' }) > 0.9)
  assert.ok(albumScore({ title: 'Abbey Road', artists: ['The Beatles'] }, { title: 'Abbey Road', subtitle: 'Album • Various Artists • 2004' }) < 0.7)
  assert.equal(artistNameScore('Beyoncé', 'Beyonce'), 1)
  assert.ok(artistNameScore('Arijit Singh', 'Arijit Singh Official') < 1)
  assert.ok(artistNameScore('Drake', 'Drake Bell') < 0.85)
})
