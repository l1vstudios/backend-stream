import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import express from 'express'
import { ApiError } from './config.js'
import { database, ensureUserIndex } from './db.js'

const scrypt = promisify(scryptCallback)
const sessionCookie = 'malix_session'
const sessionSeconds = 7 * 24 * 60 * 60
const usernamePattern = /^[A-Za-z0-9_.-]{3,32}$/
const loginAttempts = new Map()

function sessionSecret() {
  const value = process.env.MALIX_SESSION_SECRET
  if (!value || value.length < 32) throw new ApiError(503, 'MALIX_SESSION_SECRET belum dikonfigurasi')
  return value
}

async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = await scrypt(password, salt, 64)
  return `scrypt:${salt}:${hash.toString('hex')}`
}

async function passwordMatches(password, saved) {
  const parts = String(saved || '').split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt' || !/^[a-f0-9]{32}$/i.test(parts[1]) || !/^[a-f0-9]{128}$/i.test(parts[2])) return false
  const actual = await scrypt(password, parts[1], 64)
  const expected = Buffer.from(parts[2], 'hex')
  return timingSafeEqual(actual, expected)
}

function signedSession(userId) {
  const payload = Buffer.from(JSON.stringify({ id: userId, exp: Date.now() + sessionSeconds * 1000 })).toString('base64url')
  const signature = createHmac('sha256', sessionSecret()).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function sessionFromRequest(req) {
  const cookie = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookie}=`))
  const value = cookie?.slice(sessionCookie.length + 1)
  if (!value || value.length > 2048) return null
  const [payload, signature, extra] = value.split('.')
  if (!payload || !signature || extra) return null
  const expected = createHmac('sha256', sessionSecret()).update(payload).digest()
  const actual = Buffer.from(signature, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!Number.isSafeInteger(session.id) || session.id < 1 || !Number.isFinite(session.exp) || session.exp < Date.now()) return null
    return session
  } catch {
    return null
  }
}

export function requireSession(req) {
  const session = sessionFromRequest(req)
  if (!session) throw new ApiError(401, 'Silakan masuk untuk menonton')
  return session
}

export async function requireUser(req) {
  const session = requireSession(req)
  const result = await database().execute({
    sql: 'SELECT id, username, status FROM "user" WHERE id = ? LIMIT 1',
    args: [session.id],
  })
  const row = result.rows[0]
  if (!row || row.status !== 'active') throw new ApiError(401, 'Sesi tidak valid')
  return { id: Number(row.id), username: String(row.username) }
}

function cookieAttributes(req, maxAge = sessionSeconds) {
  const secure = req.secure || req.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https'
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}

function setSession(req, res, userId) {
  res.setHeader('Set-Cookie', `${sessionCookie}=${signedSession(userId)}; ${cookieAttributes(req)}`)
}

function clearSession(req, res) {
  res.setHeader('Set-Cookie', `${sessionCookie}=; ${cookieAttributes(req, 0)}`)
}

function checkLoginLimit(req, username) {
  const key = `${req.ip || 'unknown'}:${username.toLowerCase()}`
  const now = Date.now()
  const entry = loginAttempts.get(key)
  if (entry && entry.until > now && entry.count >= 10) throw new ApiError(429, 'Terlalu banyak percobaan login. Coba lagi nanti.')
  return key
}

function recordFailedLogin(key) {
  const now = Date.now()
  const entry = loginAttempts.get(key)
  loginAttempts.set(key, entry && entry.until > now
    ? { count: entry.count + 1, until: entry.until }
    : { count: 1, until: now + 15 * 60 * 1000 })
  if (loginAttempts.size > 5000) loginAttempts.delete(loginAttempts.keys().next().value)
}

export const authRouter = express.Router()
authRouter.use(express.json({ limit: '16kb' }))
authRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  next()
})

authRouter.post('/register', async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : ''
  const password = req.body?.password
  if (!usernamePattern.test(username)) throw new ApiError(400, 'Username harus 3–32 karakter: huruf, angka, _, . atau -')
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new ApiError(400, 'Password harus 8–128 karakter')
  }

  await ensureUserIndex()
  const now = new Date().toISOString()
  const hash = await passwordHash(password)
  let result
  try {
    result = await database().execute({
      sql: 'INSERT INTO "user" (username, password, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?)',
      args: [username, hash, now, now, 'active'],
    })
  } catch (error) {
    if (/SQLITE_CONSTRAINT/i.test(String(error.code || error.message))) throw new ApiError(409, 'Username sudah dipakai')
    throw error
  }
  const user = { id: Number(result.lastInsertRowid), username }
  setSession(req, res, user.id)
  res.status(201).json({ success: true, user })
})

authRouter.post('/login', async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : ''
  const password = req.body?.password
  if (!username || typeof password !== 'string') throw new ApiError(400, 'Username dan password diperlukan')
  const key = checkLoginLimit(req, username)
  const result = await database().execute({
    sql: 'SELECT id, username, password, status FROM "user" WHERE username = ? COLLATE NOCASE LIMIT 1',
    args: [username],
  })
  const row = result.rows[0]
  const valid = row && await passwordMatches(password, row.password)
  if (!valid) {
    recordFailedLogin(key)
    throw new ApiError(401, 'Username atau password salah')
  }
  if (row.status !== 'active') throw new ApiError(403, 'Akun tidak aktif')
  loginAttempts.delete(key)
  const user = { id: Number(row.id), username: String(row.username) }
  setSession(req, res, user.id)
  res.json({ success: true, user })
})

authRouter.get('/me', async (req, res) => {
  res.json({ success: true, user: await requireUser(req) })
})

authRouter.post('/logout', (req, res) => {
  clearSession(req, res)
  res.json({ success: true })
})
