import { ApiError, checkedUrl, mediaHosts, sourcePage, userAgent } from './config.js'
import { database, ensureCacheIndex } from './db.js'
import { grabUrls } from './grab.js'
import { visibleMessage, visibleUrl } from './trace.js'

const jobs = new Map()
const defaultTtlMs = 6 * 60 * 60 * 1000
const configuredTtl = Number(process.env.MALIX_STREAM_CACHE_TTL_MS)
const ttlMs = Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl : defaultTtlMs

export function normalizeMovieSource(source) {
  if (typeof source !== 'string') throw new ApiError(400, 'URL atau path diperlukan')
  const value = source.trim().replace(/^\/?movie\//i, '/')
  const target = sourcePage(value)
  const slug = target.pathname.replace(/^\/+|\/+$/g, '').toLowerCase()
  return { target: target.href, slug: /^[a-z0-9][a-z0-9-]{1,180}$/.test(slug) ? slug : null }
}

async function cachedRow(slug) {
  const result = await database().execute({
    sql: 'SELECT stream_url, created_at, updated_at FROM "cache_stream" WHERE query_film = ? COLLATE NOCASE LIMIT 1',
    args: [slug],
  })
  return result.rows[0] || null
}

async function playlistIsValid(value) {
  if (typeof value !== 'string' || !new URL(value).pathname.toLowerCase().includes('.m3u8')) return false
  let target = checkedUrl(value)
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(target, {
      headers: { 'User-Agent': userAgent, Accept: 'application/vnd.apple.mpegurl,application/x-mpegurl,*/*' },
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) return false
      target = checkedUrl(new URL(location, target).href)
      continue
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      return false
    }
    const reader = response.body.getReader()
    try {
      const { value: bytes } = await reader.read()
      const start = new TextDecoder().decode(bytes?.subarray(0, 1024) || new Uint8Array())
      return start.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')
    } finally {
      await reader.cancel().catch(() => {})
    }
  }
  return false
}

async function savePlaylist(slug, url, previousUrl) {
  await ensureCacheIndex()
  const now = new Date().toISOString()
  await database().execute({
    sql: `INSERT INTO "cache_stream" (query_film, stream_url, created_at, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(query_film COLLATE NOCASE) DO UPDATE SET
            stream_url = excluded.stream_url,
            updated_at = excluded.updated_at`,
    args: [slug, url, now, now],
  })
  return previousUrl !== url
}

async function resolveUnshared(target, slug, trace) {
  let row = null
  let validCachedUrl = null
  try {
    row = await cachedRow(slug)
    if (row?.stream_url) {
      const url = String(row.stream_url)
      const valid = await playlistIsValid(url).catch(() => false)
      if (valid) {
        validCachedUrl = url
        mediaHosts.add(new URL(url).hostname.toLowerCase())
        const lastRefresh = Date.parse(String(row.updated_at || row.created_at || ''))
        if (Number.isFinite(lastRefresh) && Date.now() - lastRefresh < ttlMs) {
          trace.record('cache.hit', { slug, url: visibleUrl(url) })
          return { urls: [url], cached: true }
        }
        trace.record('cache.expired', { slug, url: visibleUrl(url) })
      } else {
        trace.record('cache.invalid', { slug, url: visibleUrl(url) })
      }
    } else {
      trace.record('cache.miss', { slug })
    }
  } catch (error) {
    trace.record('cache.error', { operation: 'read', message: visibleMessage(error.message) })
  }

  let urls
  try {
    urls = await grabUrls(target, trace)
  } catch (error) {
    if (!validCachedUrl) throw error
    trace.record('cache.fallback', { slug, reason: visibleMessage(error.message) })
    return { urls: [validCachedUrl], cached: true }
  }

  const hls = urls.find((url) => {
    try { return new URL(url).pathname.toLowerCase().includes('.m3u8') } catch { return false }
  })
  if (hls) {
    try {
      const changed = await savePlaylist(slug, hls, row?.stream_url ? String(row.stream_url) : null)
      trace.record('cache.saved', { slug, changed, url: visibleUrl(hls) })
    } catch (error) {
      trace.record('cache.error', { operation: 'write', message: visibleMessage(error.message) })
    }
  }
  if (!urls.length && validCachedUrl) {
    trace.record('cache.fallback', { slug, reason: 'Puppeteer tidak menemukan media baru' })
    return { urls: [validCachedUrl], cached: true }
  }
  return { urls, cached: false }
}

export async function resolveStream(source, trace) {
  const { target, slug } = normalizeMovieSource(source)
  if (!slug) {
    trace.record('cache.skipped', { source: visibleUrl(target) })
    return { urls: await grabUrls(target, trace), cached: false }
  }
  if (jobs.has(slug)) {
    trace.record('cache.wait', { slug })
    return jobs.get(slug)
  }
  const job = resolveUnshared(target, slug, trace)
  jobs.set(slug, job)
  try {
    return await job
  } finally {
    jobs.delete(slug)
  }
}
