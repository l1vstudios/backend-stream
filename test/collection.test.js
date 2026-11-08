import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('collections are saved once and scoped to the signed-in user', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'malix-collection-test-'))
  process.env.BUNNY_DATABASE_URL = `file:${join(directory, 'test.db')}`
  process.env.BUNNY_DATABASE_AUTH_TOKEN = 'test-token'
  process.env.MALIX_SESSION_SECRET = 'test-secret-abcdefghijklmnopqrstuvwxyz-123456'
  let server
  try {
    const { database } = await import('../db.js')
    const { app } = await import('../app.js')
    await database().execute('CREATE TABLE "user" (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, password TEXT NOT NULL, created_at TEXT, updated_at TEXT, status TEXT NOT NULL)')
    server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${server.address().port}`

    async function register(username) {
      const response = await fetch(`${base}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'testing1234' }),
      })
      assert.equal(response.status, 201)
      return response.headers.get('set-cookie').split(';')[0]
    }

    const firstCookie = await register('firstuser')
    const secondCookie = await register('seconduser')
    const headers = { cookie: firstCookie, 'Content-Type': 'application/json' }
    const anonymousGrab = await fetch(`${base}/api/grab?path=/sample-film-2026`)
    assert.equal(anonymousGrab.status, 401)
    const anonymousMedia = await fetch(`${base}/api/hls-proxy?token=invalid`)
    assert.equal(anonymousMedia.status, 401)
    const signedInvalidPath = await fetch(`${base}/api/grab?path=${encodeURIComponent('//127.0.0.1/private')}`, { headers })
    assert.equal(signedInvalidPath.status, 400)
    const signedInvalidMedia = await fetch(`${base}/api/hls-proxy?token=invalid`, { headers })
    assert.equal(signedInvalidMedia.status, 403)
    const film = { path: '/sample-film-2026', title: 'Sample Film', metadata: '2026 · Movie', posterUrl: 'https://example.com/poster.jpg' }
    for (let i = 0; i < 2; i++) {
      const save = await fetch(`${base}/api/collection`, { method: 'POST', headers, body: JSON.stringify(film) })
      assert.equal(save.status, 200)
    }
    const firstList = await fetch(`${base}/api/collection`, { headers })
    assert.deepEqual((await firstList.json()).films.map(({ path, title, posterUrl }) => ({ path, title, posterUrl })), [
      { path: film.path, title: film.title, posterUrl: film.posterUrl },
    ])
    const secondList = await fetch(`${base}/api/collection`, { headers: { cookie: secondCookie } })
    assert.deepEqual((await secondList.json()).films, [])
    const status = await fetch(`${base}/api/collection/status?path=${film.path}`, { headers })
    assert.equal((await status.json()).saved, true)
    const remove = await fetch(`${base}/api/collection?path=${film.path}`, { method: 'DELETE', headers })
    assert.equal(remove.status, 200)
    const afterRemove = await fetch(`${base}/api/collection`, { headers })
    assert.deepEqual((await afterRemove.json()).films, [])
    const noSession = await fetch(`${base}/api/collection`)
    assert.equal(noSession.status, 401)
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
