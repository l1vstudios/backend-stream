import { ApiError } from './config.js'
import { database, ensureWatchPartyTables } from './db.js'
import { requireUser } from './auth.js'

export async function roomRow(code) {
  if (typeof code !== 'string' || !/^malix-room-[a-z0-9]{3,16}$/i.test(code)) throw new ApiError(404, 'Room tidak ditemukan')
  const result = await database().execute({
    sql: 'SELECT r.*, u.username AS creator_username FROM watch_party_room r JOIN "user" u ON u.id = r.creator_user_id WHERE r.code = ? LIMIT 1',
    args: [code.toLowerCase()],
  })
  if (!result.rows[0]) throw new ApiError(404, 'Room tidak ditemukan')
  return result.rows[0]
}

export async function isMember(room, userId) {
  if (Number(room.creator_user_id) === userId) return true
  const result = await database().execute({
    sql: 'SELECT 1 FROM watch_party_member WHERE room_id = ? AND user_id = ? LIMIT 1',
    args: [room.id, userId],
  })
  return result.rows.length > 0
}

export async function authorizePartyMember(req, code) {
  const user = await requireUser(req)
  await ensureWatchPartyTables()
  const room = await roomRow(code)
  if (!await isMember(room, user.id)) throw new ApiError(403, 'Masuk ke room sebelum menggunakan kamera atau mikrofon')
  return { room, user }
}
