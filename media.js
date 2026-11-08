import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { ApiError, checkedUrl, userAgent } from './config.js'
import './env.js'

const tokenLifetimeMs = 6 * 60 * 60 * 1000
let encryptionKey

function mediaKey() {
  if (encryptionKey) return encryptionKey
  const secret = process.env.MALIX_SESSION_SECRET
  if (!secret || secret.length < 32) throw new ApiError(503, 'MALIX_SESSION_SECRET belum dikonfigurasi')
  encryptionKey = createHash('sha256').update('malix-media-url-v1:').update(secret).digest()
  return encryptionKey
}

export function issueMediaToken(value) {
  const url = checkedUrl(value).href
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', mediaKey(), nonce)
  const payload = Buffer.from(JSON.stringify({ url, expires: Date.now() + tokenLifetimeMs }))
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url')
}

export function readMediaToken(token) {
  if (typeof token !== 'string' || token.length < 40 || token.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new ApiError(403, 'Token stream tidak valid')
  }
  try {
    const bytes = Buffer.from(token, 'base64url')
    const nonce = bytes.subarray(0, 12)
    const tag = bytes.subarray(12, 28)
    const encrypted = bytes.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', mediaKey(), nonce)
    decipher.setAuthTag(tag)
    const payload = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'))
    if (!Number.isFinite(payload.expires) || payload.expires < Date.now()) throw new Error('expired')
    return checkedUrl(payload.url)
  } catch {
    throw new ApiError(403, 'Token stream tidak valid atau kedaluwarsa')
  }
}

export function mediaProxyUrl(value) {
  return `/api/hls-proxy?token=${issueMediaToken(value)}`
}

export function rewritePlaylist(markup, baseUrl) {
  const nested = (reference) => {
    if (reference.startsWith('data:')) return reference
    return mediaProxyUrl(new URL(reference, baseUrl).href)
  }
  return markup.split('\n').map((line) => {
    const value = line.trim()
    if (value && !value.startsWith('#')) return nested(value)
    return line.replace(/\bURI="([^"]+)"/g, (_, uri) => `URI="${nested(uri)}"`)
  }).join('\n')
}

export async function proxyMedia(req, res) {
  const target = readMediaToken(req.query.token)
  res.setHeader('Cache-Control', 'no-store')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  res.once('close', () => { controller.abort(); clearTimeout(timeout) })
  res.once('finish', () => clearTimeout(timeout))

  const headers = {
    'User-Agent': userAgent,
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    ...(req.headers.range ? { Range: req.headers.range } : {}),
  }
  let upstream
  let resolved = target
  for (let hop = 0; hop < 5; hop++) {
    upstream = await fetch(resolved, { headers, redirect: 'manual', signal: controller.signal })
    if (upstream.status < 300 || upstream.status >= 400) break
    const location = upstream.headers.get('location')
    await upstream.body?.cancel()
    if (!location) throw new ApiError(502, 'Redirect media tidak valid')
    resolved = checkedUrl(new URL(location, resolved).href)
  }
  if (!upstream || (upstream.status >= 300 && upstream.status < 400)) throw new ApiError(502, 'Redirect media terlalu banyak')
  if (!upstream.ok) throw new ApiError(502, `Media mengembalikan HTTP ${upstream.status}`)

  const contentType = upstream.headers.get('content-type') || 'application/octet-stream'
  if (resolved.pathname.toLowerCase().includes('.m3u8') || contentType.toLowerCase().includes('mpegurl')) {
    const markup = await upstream.text()
    res.type('application/vnd.apple.mpegurl').send(rewritePlaylist(markup, resolved.href))
    return
  }

  res.status(upstream.status)
  res.setHeader('Content-Type', contentType)
  for (const header of ['content-length', 'content-range', 'accept-ranges']) {
    const value = upstream.headers.get(header)
    if (value) res.setHeader(header, value)
  }
  if (!upstream.body) {
    res.end()
    return
  }
  const body = Readable.fromWeb(upstream.body)
  body.on('error', () => res.destroy())
  body.pipe(res)
}
