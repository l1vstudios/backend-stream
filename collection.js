import express from 'express'
import { ApiError } from './config.js'
import { database, ensureCollectionTable } from './db.js'
import { requireUser } from './auth.js'

export const collectionRouter = express.Router()

collectionRouter.use(express.json({ limit: '16kb' }))
collectionRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  next()
})

export function collectionPath(value) {
  if (typeof value !== 'string') throw new ApiError(400, 'Path film tidak valid')
  const path = value.trim().replace(/^\/movie\//, '/')
  if (!/^\/[a-z0-9][a-z0-9-]{0,199}$/i.test(path)) throw new ApiError(400, 'Path film tidak valid')
  return path.toLowerCase()
}

function collectionFields(body) {
  const filmPath = collectionPath(body?.path)
  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  const metadata = typeof body?.metadata === 'string' ? body.metadata.trim() : ''
  const posterUrl = typeof body?.posterUrl === 'string' ? body.posterUrl.trim() : ''
  if (!title || title.length > 300 || metadata.length > 200 || posterUrl.length > 2048) {
    throw new ApiError(400, 'Data film tidak valid')
  }
  if (posterUrl) {
    let url
    try { url = new URL(posterUrl) } catch { throw new ApiError(400, 'URL poster tidak valid') }
    if (!['http:', 'https:'].includes(url.protocol)) throw new ApiError(400, 'URL poster tidak valid')
  }
  return { filmPath, title, metadata, posterUrl }
}

collectionRouter.get('/', async (req, res) => {
  const user = await requireUser(req)
  await ensureCollectionTable()
  const result = await database().execute({
    sql: 'SELECT film_path, title, metadata, poster_url, created_at FROM collection_film WHERE user_id = ? ORDER BY created_at DESC, id DESC',
    args: [user.id],
  })
  res.json({ success: true, films: result.rows.map((row) => ({
    path: String(row.film_path),
    title: String(row.title),
    metadata: String(row.metadata),
    posterUrl: String(row.poster_url),
    savedAt: String(row.created_at),
  })) })
})

collectionRouter.get('/status', async (req, res) => {
  const user = await requireUser(req)
  const path = collectionPath(req.query.path)
  await ensureCollectionTable()
  const result = await database().execute({
    sql: 'SELECT 1 FROM collection_film WHERE user_id = ? AND film_path = ? LIMIT 1',
    args: [user.id, path],
  })
  res.json({ success: true, saved: result.rows.length > 0 })
})

collectionRouter.post('/', async (req, res) => {
  const user = await requireUser(req)
  const { filmPath, title, metadata, posterUrl } = collectionFields(req.body)
  await ensureCollectionTable()
  const now = new Date().toISOString()
  await database().execute({
    sql: `INSERT INTO collection_film (user_id, film_path, title, metadata, poster_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, film_path) DO UPDATE SET
        title = excluded.title, metadata = excluded.metadata,
        poster_url = excluded.poster_url, updated_at = excluded.updated_at`,
    args: [user.id, filmPath, title, metadata, posterUrl, now, now],
  })
  res.json({ success: true, saved: true })
})

collectionRouter.delete('/', async (req, res) => {
  const user = await requireUser(req)
  const path = collectionPath(req.query.path)
  await ensureCollectionTable()
  await database().execute({
    sql: 'DELETE FROM collection_film WHERE user_id = ? AND film_path = ?',
    args: [user.id, path],
  })
  res.json({ success: true, saved: false })
})
