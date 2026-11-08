import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocket } from 'ws'

test('watch party rooms require membership, protect PINs, and keep playback host-controlled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'malix-party-test-'))
  process.env.BUNNY_DATABASE_URL = `file:${join(directory, 'test.db')}`
  process.env.BUNNY_DATABASE_AUTH_TOKEN = 'test-token'
  process.env.MALIX_SESSION_SECRET = 'test-secret-abcdefghijklmnopqrstuvwxyz-123456'
  let server
  const sockets = []
  try {
    const { database } = await import('../db.js')
    const { app } = await import('../app.js')
    const { attachPartySignaling } = await import('../party-signaling.js')
    await database().execute('CREATE TABLE "user" (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, password TEXT NOT NULL, created_at TEXT, updated_at TEXT, status TEXT NOT NULL)')
    server = app.listen(0, '127.0.0.1')
    attachPartySignaling(server)
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const socketBase = `ws://127.0.0.1:${server.address().port}`
    async function connect(code, cookie) {
      const socket = new WebSocket(`${socketBase}/api/watch-party/socket?room=${code}`, { headers: { cookie } })
      const messages = []
      socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())))
      await new Promise((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
      sockets.push(socket)
      return { socket, messages }
    }
    async function waitFor(client, predicate) {
      for (let attempt = 0; attempt < 50; attempt++) {
        const match = client.messages.find(predicate)
        if (match) return match
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.fail('Pesan WebSocket tidak diterima')
    }
    const send = (path, method, cookie, body) => fetch(`${base}/api/watch-party${path}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    async function register(username) {
      const response = await fetch(`${base}/api/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'testing1234' }),
      })
      assert.equal(response.status, 201)
      return response.headers.get('set-cookie').split(';')[0]
    }
    const host = await register('partyhost')
    const guest = await register('partyguest')
    const film = { path: '/sample-film-2026', title: 'Sample Film', metadata: '2026 · Movie', posterUrl: 'https://example.com/poster.jpg' }
    assert.equal((await send('/rooms', 'POST', null, { film, accessMode: 'public' })).status, 401)
    const created = await send('/rooms', 'POST', host, { film, accessMode: 'public' })
    assert.equal(created.status, 201)
    const { code, path } = await created.json()
    assert.match(code, /^malix-room-[a-f0-9]{8}$/)
    assert.equal(path, `/watch-party/${code}`)

    const beforeJoin = await send(`/rooms/${code}`, 'GET', guest)
    const pendingRoom = (await beforeJoin.json()).room
    assert.equal(pendingRoom.joined, false)
    assert.deepEqual(pendingRoom.participants, [])
    const unjoinedSocket = new WebSocket(`${socketBase}/api/watch-party/socket?room=${code}`, { headers: { cookie: guest } })
    const denied = await new Promise((resolve, reject) => {
      unjoinedSocket.once('unexpected-response', (_request, response) => resolve(response))
      unjoinedSocket.once('error', reject)
    })
    assert.equal(denied.statusCode, 403)
    denied.resume()
    assert.equal((await send(`/rooms/${code}/join`, 'POST', guest)).status, 200)
    const joined = await send(`/rooms/${code}`, 'GET', guest)
    const joinedRoom = (await joined.json()).room
    assert.equal(joinedRoom.joined, true)
    assert.equal(joinedRoom.film.path, film.path)
    assert.equal(joinedRoom.memberCount, 2)
    assert.deepEqual(joinedRoom.participants.map(({ username, isHost }) => ({ username, isHost })), [
      { username: 'partyhost', isHost: true },
      { username: 'partyguest', isHost: false },
    ])

    const hostSocket = await connect(code, host)
    const guestSocket = await connect(code, guest)
    const hostId = joinedRoom.participants[0].userId
    const guestId = joinedRoom.participants[1].userId
    assert.equal((await waitFor(guestSocket, (message) => message.type === 'peers')).peers[0].userId, hostId)
    assert.equal((await waitFor(hostSocket, (message) => message.type === 'peer-joined')).userId, guestId)
    guestSocket.socket.send(JSON.stringify({ type: 'media-state', camera: true, mic: false }))
    assert.deepEqual(await waitFor(hostSocket, (message) => message.type === 'media-state'), { type: 'media-state', from: guestId, camera: true, mic: false })
    guestSocket.socket.send(JSON.stringify({ type: 'offer', to: hostId, description: { type: 'offer', sdp: 'test-sdp' }, from: 999 }))
    assert.deepEqual(await waitFor(hostSocket, (message) => message.type === 'offer'), { type: 'offer', from: guestId, description: { type: 'offer', sdp: 'test-sdp' } })

    assert.equal((await send(`/rooms/${code}/playback`, 'PATCH', guest, { positionSeconds: 12, isPlaying: true })).status, 403)
    assert.equal((await send(`/rooms/${code}/playback`, 'PATCH', host, { positionSeconds: 12, isPlaying: true })).status, 200)
    const playing = (await (await send(`/rooms/${code}`, 'GET', guest)).json()).room.playback
    assert.equal(playing.isPlaying, true)
    assert.ok(playing.positionSeconds >= 12)

    assert.equal((await send(`/rooms/${code}/settings`, 'PATCH', host, { accessMode: 'pin', pin: '123456' })).status, 200)
    assert.equal((await waitFor(guestSocket, (message) => message.type === 'access-revoked')).type, 'access-revoked')
    const locked = (await (await send(`/rooms/${code}`, 'GET', guest)).json()).room
    assert.equal(locked.joined, false)
    assert.equal(locked.film, null)
    assert.equal(JSON.stringify(locked).includes('123456'), false)
    assert.equal((await send(`/rooms/${code}/join`, 'POST', guest, { pin: '000000' })).status, 403)
    assert.equal((await send(`/rooms/${code}/join`, 'POST', guest, { pin: '123456' })).status, 200)
    assert.equal((await (await send(`/rooms/${code}`, 'GET', guest)).json()).room.joined, true)
    const rejoinedSocket = await connect(code, guest)
    assert.equal((await waitFor(rejoinedSocket, (message) => message.type === 'peers')).peers[0].userId, hostId)
    assert.equal((await send(`/rooms/${code}/members/me`, 'DELETE', host)).status, 403)
    assert.equal((await send(`/rooms/${code}/members/me`, 'DELETE', guest)).status, 200)
    assert.equal((await waitFor(rejoinedSocket, (message) => message.type === 'left-room')).type, 'left-room')
    assert.equal((await waitFor(hostSocket, (message) => message.type === 'peer-left' && message.userId === guestId)).userId, guestId)
    const afterLeave = (await (await send(`/rooms/${code}`, 'GET', guest)).json()).room
    assert.equal(afterLeave.joined, false)
    assert.equal(afterLeave.memberCount, 1)
    assert.equal(afterLeave.film, null)
    const leftSocket = new WebSocket(`${socketBase}/api/watch-party/socket?room=${code}`, { headers: { cookie: guest } })
    const leftDenied = await new Promise((resolve, reject) => {
      leftSocket.once('unexpected-response', (_request, response) => resolve(response))
      leftSocket.once('error', reject)
    })
    assert.equal(leftDenied.statusCode, 403)
    leftDenied.resume()
    assert.equal((await send(`/rooms/${code}/join`, 'POST', guest, { pin: '123456' })).status, 200)
    const finalGuestSocket = await connect(code, guest)
    assert.equal((await send(`/rooms/${code}`, 'DELETE', guest)).status, 403)
    assert.equal((await send(`/rooms/${code}`, 'DELETE', host)).status, 200)
    assert.equal((await waitFor(finalGuestSocket, (message) => message.type === 'room-ended')).type, 'room-ended')
    assert.equal((await send(`/rooms/${code}`, 'GET', guest)).status, 404)
    assert.equal((await send(`/rooms/${code}`, 'GET', host)).status, 404)
  } finally {
    for (const socket of sockets) socket.terminate()
    if (server) await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
