import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import express from 'express'
import { ApiError } from './config.js'
import { collectionPath } from './collection.js'
import { database, ensureWatchPartyTables } from './db.js'
import { requireUser } from './auth.js'
import { roomRow, isMember } from './party-access.js'
import { disconnectMemberMedia, disconnectRoomMedia } from './party-signaling.js'

const scrypt = promisify(scryptCallback)
const pinAttempts = new Map()
const pinPattern = /^\d{6}$/

export const watchPartyRouter = express.Router()
watchPartyRouter.use(express.json({ limit: '16kb' }))
watchPartyRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  next()
})

function filmFields(body) {
  const path = collectionPath(body?.film?.path)
  const title = typeof body?.film?.title === 'string' ? body.film.title.trim() : ''
  const metadata = typeof body?.film?.metadata === 'string' ? body.film.metadata.trim() : ''
  const posterUrl = typeof body?.film?.posterUrl === 'string' ? body.film.posterUrl.trim() : ''
  if (!title || title.length > 300 || metadata.length > 200 || posterUrl.length > 2048) {
    throw new ApiError(400, 'Data film tidak valid')
  }
  if (posterUrl) {
    let poster
    try { poster = new URL(posterUrl) } catch { throw new ApiError(400, 'URL poster tidak valid') }
    if (!['http:', 'https:'].includes(poster.protocol)) throw new ApiError(400, 'URL poster tidak valid')
  }
  return { path, title, metadata, posterUrl }
}

function accessFields(body) {
  const accessMode = body?.accessMode
  if (!['public', 'pin'].includes(accessMode)) throw new ApiError(400, 'Tipe akses room tidak valid')
  const pin = accessMode === 'pin' ? String(body?.pin || '') : ''
  if (accessMode === 'pin' && !pinPattern.test(pin)) throw new ApiError(400, 'PIN harus terdiri dari 6 angka')
  return { accessMode, pin }
}

async function hashPin(pin) {
  if (!pin) return null
  const salt = randomBytes(16).toString('hex')
  const hash = await scrypt(pin, salt, 32)
  return `${salt}:${hash.toString('hex')}`
}

async function pinMatches(pin, saved) {
  const [salt, hex] = String(saved || '').split(':')
  if (!pinPattern.test(pin) || !/^[a-f0-9]{32}$/i.test(salt || '') || !/^[a-f0-9]{64}$/i.test(hex || '')) return false
  const actual = await scrypt(pin, salt, 32)
  const expected = Buffer.from(hex, 'hex')
  return timingSafeEqual(actual, expected)
}

function recordWrongPin(key) {
  const now = Date.now()
  const previous = pinAttempts.get(key)
  pinAttempts.set(key, previous && previous.until > now
    ? { count: previous.count + 1, until: previous.until }
    : { count: 1, until: now + 15 * 60 * 1000 })
  if (pinAttempts.size > 5000) pinAttempts.delete(pinAttempts.keys().next().value)
}

function playbackFrom(row) {
  const position = Number(row.position_seconds) || 0
  const elapsed = row.is_playing ? Math.max(0, (Date.now() - Date.parse(String(row.playback_updated_at))) / 1000) : 0
  return { positionSeconds: Math.max(0, position + elapsed), isPlaying: Boolean(row.is_playing) }
}

watchPartyRouter.post('/rooms', async (req, res) => {
  const user = await requireUser(req)
  const film = filmFields(req.body)
  const { accessMode, pin } = accessFields(req.body)
  await ensureWatchPartyTables()
  const now = new Date().toISOString()
  let code
  for (let attempt = 0; attempt < 3; attempt++) {
    code = `malix-room-${randomBytes(4).toString('hex')}`
    try {
      await database().execute({
        sql: `INSERT INTO watch_party_room
          (code, creator_user_id, film_path, title, metadata, poster_url, access_mode, pin_hash,
           position_seconds, is_playing, playback_updated_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
        args: [code, user.id, film.path, film.title, film.metadata, film.posterUrl, accessMode, await hashPin(pin), now, now, now],
      })
      res.status(201).json({ success: true, code, path: `/watch-party/${code}` })
      return
    } catch (error) {
      if (!/SQLITE_CONSTRAINT/i.test(String(error.code || error.message))) throw error
    }
  }
  throw new ApiError(503, 'Gagal membuat room, coba lagi')
})

watchPartyRouter.get('/rooms/:code', async (req, res) => {
  const user = await requireUser(req)
  await ensureWatchPartyTables()
  const room = await roomRow(req.params.code)
  const host = Number(room.creator_user_id) === user.id
  const joined = await isMember(room, user.id)
  if (joined && !host) {
    await database().execute({
      sql: 'UPDATE watch_party_member SET last_seen_at = ? WHERE room_id = ? AND user_id = ?',
      args: [new Date().toISOString(), room.id, user.id],
    })
  }
  const activeSince = new Date(Date.now() - 45_000).toISOString()
  const activeMembers = await database().execute({
    sql: `SELECT m.user_id, u.username
      FROM watch_party_member m JOIN "user" u ON u.id = m.user_id
      WHERE m.room_id = ? AND m.last_seen_at >= ? ORDER BY m.joined_at ASC`,
    args: [room.id, activeSince],
  })
  const participants = [
    { userId: Number(room.creator_user_id), username: String(room.creator_username), isHost: true },
    ...activeMembers.rows.map((member) => ({
      userId: Number(member.user_id), username: String(member.username), isHost: false,
    })),
  ]
  res.json({
    success: true,
    room: {
      code: String(room.code),
      accessMode: String(room.access_mode),
      creator: String(room.creator_username),
      isHost: host,
      joined,
      memberCount: participants.length,
      participants: joined ? participants : [],
      film: joined ? {
        path: String(room.film_path), title: String(room.title),
        metadata: String(room.metadata), posterUrl: String(room.poster_url),
      } : null,
      playback: joined ? playbackFrom(room) : null,
    },
  })
})

watchPartyRouter.post('/rooms/:code/join', async (req, res) => {
  const user = await requireUser(req)
  await ensureWatchPartyTables()
  const room = await roomRow(req.params.code)
  if (Number(room.creator_user_id) === user.id || await isMember(room, user.id)) {
    res.json({ success: true, joined: true })
    return
  }
  if (room.access_mode === 'pin') {
    const key = `${room.code}:${user.id}:${req.ip}`
    const attempts = pinAttempts.get(key)
    if (attempts && attempts.until > Date.now() && attempts.count >= 5) throw new ApiError(429, 'Terlalu banyak percobaan PIN. Coba lagi nanti.')
    if (!await pinMatches(String(req.body?.pin || ''), room.pin_hash)) {
      recordWrongPin(key)
      throw new ApiError(403, 'PIN room salah')
    }
    pinAttempts.delete(key)
  }
  const now = new Date().toISOString()
  await database().execute({
    sql: `INSERT INTO watch_party_member (room_id, user_id, joined_at, last_seen_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(room_id, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    args: [room.id, user.id, now, now],
  })
  res.json({ success: true, joined: true })
})

watchPartyRouter.delete('/rooms/:code/members/me', async (req, res) => {
  const user = await requireUser(req)
  await ensureWatchPartyTables()
  const room = await roomRow(req.params.code)
  if (Number(room.creator_user_id) === user.id) throw new ApiError(403, 'Host harus mengakhiri room')
  await database().execute({
    sql: 'DELETE FROM watch_party_member WHERE room_id = ? AND user_id = ?',
    args: [room.id, user.id],
  })
  disconnectMemberMedia(String(room.code), user.id)
  res.json({ success: true })
})

watchPartyRouter.patch('/rooms/:code/playback', async (req, res) => {
  const user = await requireUser(req)
  await ensureWatchPartyTables()
  const room = await roomRow(req.params.code)
  if (Number(room.creator_user_id) !== user.id) throw new ApiError(403, 'Hanya host yang dapat mengontrol pemutaran')
  const position = Number(req.body?.positionSeconds)
  const isPlaying = req.body?.isPlaying
  if (!Number.isFinite(position) || position < 0 || position > 86_400 || typeof isPlaying !== 'boolean') {
    throw new ApiError(400, 'Posisi pemutaran tidak valid')
  }
  const now = new Date().toISOString()
  await database().execute({
    sql: 'UPDATE watch_party_room SET position_seconds = ?, is_playing = ?, playback_updated_at = ?, updated_at = ? WHERE id = ?',
    args: [Math.round(position * 10) / 10, isPlaying ? 1 : 0, now, now, room.id],
  })
  res.json({ success: true, playback: { positionSeconds: position, isPlaying } })
})

watchPartyRouter.patch('/rooms/:code/settings', async (req, res) => {
  const user = await requireUser(req)
  await ensureWatchPartyTables()
  const room = await roomRow(req.params.code)
  if (Number(room.creator_user_id) !== user.id) throw new ApiError(403, 'Hanya host yang dapat mengubah akses room')
  const { accessMode, pin } = accessFields(req.body)
  await database().execute({
    sql: 'UPDATE watch_party_room SET access_mode = ?, pin_hash = ?, updated_at = ? WHERE id = ?',
    args: [accessMode, await hashPin(pin), new Date().toISOString(), room.id],
  })
  if (accessMode === 'pin') {
    await database().execute({ sql: 'DELETE FROM watch_party_member WHERE room_id = ?', args: [room.id] })
    disconnectRoomMedia(String(room.code), 'access-revoked', user.id)
  }
  res.json({ success: true, accessMode })
})

watchPartyRouter.delete('/rooms/:code', async (req, res) => {
  const user = await requireUser(req)
  await ensureWatchPartyTables()
  const room = await roomRow(req.params.code)
  if (Number(room.creator_user_id) !== user.id) throw new ApiError(403, 'Hanya host yang dapat mengakhiri room')
  await database().batch([
    { sql: 'DELETE FROM watch_party_member WHERE room_id = ?', args: [room.id] },
    { sql: 'DELETE FROM watch_party_room WHERE id = ? AND creator_user_id = ?', args: [room.id, user.id] },
  ], 'write')
  disconnectRoomMedia(String(room.code))
  res.json({ success: true })
})
