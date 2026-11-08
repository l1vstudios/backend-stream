import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { app } from '../app.js'
import { parseDetail, parseMovies } from '../catalog.js'
import { isMediaCandidate } from '../grab.js'
import { readMediaToken, rewritePlaylist } from '../media.js'
import { visibleMessage, visibleUrl } from '../trace.js'
import { normalizeMovieSource } from '../stream-cache.js'

let server
let baseUrl

before(async () => {
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

test('parses film poster, title and original path', () => {
  const markup = `<div class="gallery-grid"><article><a href="/candle-tomb-worm-valley-2023" itemprop="url"><img src="https://poster.example/film.jpg"><span class="year">2023</span><div class="genre">Action, Drama</div><h3 class="poster-title">Candle in the Tomb: The Worm Valley</h3></a></article></div>`
  assert.deepEqual(parseMovies(markup), [['Candle in the Tomb: The Worm Valley', '2023 · Action', 'https://poster.example/film.jpg', '/candle-tomb-worm-valley-2023']])
})

test('parses detail fields', () => {
  const markup = `<meta property="og:title" content="Lk21 Nonton Sample Film (2026) Sub Indo | Streaming"><meta property="og:image" content="https://poster.example/sample.jpg"><script type="application/ld+json">{"director":{"name":"Example Director"},"aggregateRating":{"ratingValue":"8.1"},"duration":"PT1H42M"}</script><div class="synopsis">Sinopsis: A story.</div>`
  assert.deepEqual(parseDetail(markup), { title: 'Sample Film (2026)', posterUrl: 'https://poster.example/sample.jpg', synopsis: 'A story.', director: 'Example Director', rating: '8.1', duration: '1h 42m' })
})

test('rewrites playlist resources and filters ad media', () => {
  const result = rewritePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-PART:DURATION=0.2,URI="part.ts"\nsegment.ts\n', 'https://media.example/master.m3u8')
  assert.equal(result.includes('media.example'), false)
  const tokens = [...result.matchAll(/token=([A-Za-z0-9_-]+)/g)].map((match) => match[1])
  assert.deepEqual(tokens.map((token) => readMediaToken(token).href), [
    'https://media.example/key.bin',
    'https://media.example/part.ts',
    'https://media.example/segment.ts',
  ])
  const changed = tokens[0][50] === 'a' ? 'b' : 'a'
  assert.throws(() => readMediaToken(`${tokens[0].slice(0, 50)}${changed}${tokens[0].slice(51)}`))
  assert.equal(isMediaCandidate('https://media.example/master.m3u8'), true)
  assert.equal(isMediaCandidate('https://media.example/stopjudi/3.mp4'), false)
})

test('diagnostic URLs omit query parameters', () => {
  assert.equal(visibleUrl('https://cdn.example/video.m3u8?token=secret#part'), 'https://cdn.example/video.m3u8')
  assert.equal(visibleUrl('/movie?id=secret'), '/movie')
  assert.equal(visibleUrl('about:blank'), 'about:blank')
  assert.equal(visibleMessage('Failed https://cdn.example/video.m3u8?token=secret'), 'Failed https://cdn.example/video.m3u8')
})

test('normalizes frontend movie paths to the source slug used by the stream cache', () => {
  const direct = normalizeMovieSource('/all-wishes-come-true-2026')
  const frontend = normalizeMovieSource('/movie/all-wishes-come-true-2026')
  assert.equal(direct.slug, 'all-wishes-come-true-2026')
  assert.deepEqual(frontend, direct)
})

test('health and validation endpoints return JSON', async () => {
  const health = await fetch(`${baseUrl}/api/health`)
  assert.deepEqual(await health.json(), { status: 'ok' })
  const invalidPage = await fetch(`${baseUrl}/api/movies?page=0`)
  assert.equal(invalidPage.status, 400)
  assert.equal((await invalidPage.json()).success, false)
  const invalidPath = await fetch(`${baseUrl}/api/grab?path=${encodeURIComponent('//127.0.0.1/private')}`)
  assert.equal(invalidPath.status, 401)
  const diagnostic = await fetch(`${baseUrl}/api/grab?debug=1&path=${encodeURIComponent('//127.0.0.1/private?token=secret')}`)
  assert.equal(diagnostic.status, 401)
  const diagnosticBody = await diagnostic.json()
  assert.equal(diagnosticBody.success, false)
  assert.equal(diagnosticBody.trace, undefined)
  assert.equal(JSON.stringify(diagnosticBody).includes('secret'), false)
  const invalidMedia = await fetch(`${baseUrl}/api/hls-proxy?url=${encodeURIComponent('http://127.0.0.1/private.m3u8')}`)
  assert.equal(invalidMedia.status, 401)
})
