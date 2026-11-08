import { existsSync } from 'node:fs'
import { isIP } from 'node:net'

const defaultChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export const source = new URL(process.env.MALIX_SOURCE_URL || 'https://tv12.lk21official.cc')
export const sourceBase = source.origin
export const chromePath = process.env.MALIX_CHROME_PATH || (existsSync(defaultChrome) ? defaultChrome : '')
export const headless = process.env.MALIX_HEADLESS !== '0'
export const port = Number(process.env.PORT || 3001)
export const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
export const mediaHosts = new Set((process.env.MALIX_MEDIA_HOSTS || '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean))

export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function checkedUrl(value, allowedHosts) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new ApiError(400, 'URL tidak valid')
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !host) {
    throw new ApiError(400, 'URL tidak valid')
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || isIP(host)) {
    throw new ApiError(403, 'Alamat lokal tidak diizinkan')
  }
  if (allowedHosts && !allowedHosts.has(host)) {
    throw new ApiError(403, 'Host tidak diizinkan')
  }
  return parsed
}

export function sourcePage(pathOrUrl) {
  if (typeof pathOrUrl !== 'string' || !pathOrUrl.trim()) {
    throw new ApiError(400, 'URL atau path diperlukan')
  }
  const value = pathOrUrl.trim()
  if (value.startsWith('//')) throw new ApiError(400, 'Path tidak valid')
  const resolved = value.startsWith('/') ? new URL(value, sourceBase) : checkedUrl(value)
  return checkedUrl(resolved.href, new Set([source.hostname.toLowerCase()]))
}
