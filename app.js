import express from 'express'
import { ApiError } from './config.js'
import { loadMovieDetail, loadMovies } from './catalog.js'
import { mediaProxyUrl, proxyMedia } from './media.js'
import { createTrace, visibleMessage, visibleUrl } from './trace.js'
import { authRouter, requireSession, requireUser } from './auth.js'
import { collectionRouter } from './collection.js'
import { watchPartyRouter } from './watch-party.js'
import { resolveStream } from './stream-cache.js'

export const app = express()
app.disable('x-powered-by')
app.use('/api/auth', authRouter)
app.use('/api/collection', collectionRouter)
app.use('/api/watch-party', watchPartyRouter)

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))

app.get('/api/movies', async (req, res) => {
  const page = Number(req.query.page || 1)
  if (!Number.isSafeInteger(page) || page < 1) throw new ApiError(400, 'Nomor halaman tidak valid')
  const search = typeof req.query.s === 'string' ? req.query.s.trim() : ''
  res.json({ success: true, movies: await loadMovies(page, search) })
})

app.get('/api/movie-detail', async (req, res) => {
  if (typeof req.query.path !== 'string') throw new ApiError(400, 'Path diperlukan')
  // Judul dan poster dari halaman sumber juga dipakai saat film disimpan ke koleksi.
  res.json({ success: true, data: await loadMovieDetail(req.query.path) })
})

app.get('/api/grab', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  await requireUser(req)
  const trace = createTrace('grab', process.env.MALIX_TRACE === '1')
  const source = typeof req.query.path === 'string' ? req.query.path : req.query.url
  try {
    if (typeof source !== 'string') throw new ApiError(400, 'URL atau path diperlukan')
    trace.record('api.request', { source: visibleUrl(source) })
    const { urls, cached } = await resolveStream(source, trace)
    if (!urls.length) throw new ApiError(404, 'Link film tidak ditemukan')
    trace.record('api.response', { status: 200, urls: urls.length, cached })
    const streams = urls.map((url) => ({
      url: mediaProxyUrl(url),
      type: /\.m3u8(?:$|[?#])/i.test(url) ? 'hls' : 'mp4',
    }))
    res.json({ success: true, streams, cached })
  } catch (error) {
    const status = error.status || 500
    trace.record('api.response', { status, error: visibleMessage(error.message) })
    throw error
  }
})

app.get('/api/hls-proxy', async (req, res) => {
  requireSession(req)
  await proxyMedia(req, res)
})

app.use((error, _req, res, _next) => {
  if (!error.status || error.status >= 500) console.error('MALIX API:', error)
  if (res.headersSent) return res.destroy()
  res.status(error.status || 500).json({ success: false, error: error.status ? error.message : 'Error internal server' })
})
