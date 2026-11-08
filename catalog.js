import puppeteer from 'puppeteer-core'
import { ApiError, chromePath, headless, sourceBase, sourcePage, userAgent } from './config.js'

const textOf = (value) => String(value || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&(?:amp|#38);/gi, '&')
  .replace(/&(?:quot|#34);/gi, '"')
  .replace(/&(?:apos|#39|#039);/gi, "'")
  .replace(/&nbsp;/gi, ' ')
  .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
  .replace(/\s+/g, ' ')
  .trim()

const attr = (tag, name) => tag?.match(new RegExp(`\\b${name}=["']([^"']+)["']`, 'i'))?.[1] || ''

export function parseMovies(markup) {
  const movies = []
  for (const [, article] of markup.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)) {
    const title = textOf(article.match(/<h3\b[^>]*class=["'][^"']*poster-title[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i)?.[1])
    const linkTag = article.match(/<a\b[^>]*itemprop=["']url["'][^>]*>/i)?.[0]
      || article.match(/<a\b[^>]*href=["'][^"']+["'][^>]*>/i)?.[0]
    const href = attr(linkTag, 'href')
    if (!title || !href) continue

    let path
    try {
      path = sourcePage(href).pathname
    } catch {
      continue
    }
    const imageTag = article.match(/<img\b[^>]*>/i)?.[0]
    const image = attr(imageTag, 'data-src') || attr(imageTag, 'src') || attr(imageTag, 'data-original')
    const poster = image ? new URL(image, sourceBase).href : ''
    const year = textOf(article.match(/<span\b[^>]*class=["'][^"']*year[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1])
    const genre = textOf(article.match(/<div\b[^>]*class=["'][^"']*genre[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]).split(',')[0] || 'Movie'
    movies.push([title, [year, genre].filter(Boolean).join(' · '), poster, path])
  }
  return movies
}

export function parseDetail(markup) {
  const data = {
    title: '',
    posterUrl: '',
    synopsis: 'Sinopsis belum tersedia.',
    director: 'Unknown',
    rating: '7.0',
    duration: '1h 30m',
  }
  const metaTags = [...markup.matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0])
  const ogTitle = attr(metaTags.find((tag) => attr(tag, 'property') === 'og:title'), 'content')
  const ogImage = attr(metaTags.find((tag) => attr(tag, 'property') === 'og:image'), 'content')
  data.title = textOf(ogTitle).replace(/^Lk21 Nonton\s+/i, '').replace(/\s+Sub Indo\s*\|.*$/i, '')
  if (ogImage) {
    try {
      const poster = new URL(ogImage, sourceBase)
      if (['http:', 'https:'].includes(poster.protocol)) data.posterUrl = poster.href
    } catch { /* Ignore invalid poster URLs. */ }
  }
  for (const [, content] of markup.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const decoded = JSON.parse(content)
      for (const item of Array.isArray(decoded) ? decoded : [decoded]) {
        if (!item || typeof item !== 'object') continue
        if (item.director) {
          const directors = Array.isArray(item.director) ? item.director : [item.director]
          const names = directors.map((person) => person?.name).filter(Boolean)
          if (names.length) data.director = names.join(', ')
        }
        if (item.aggregateRating?.ratingValue) data.rating = String(item.aggregateRating.ratingValue)
        const duration = String(item.duration || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?/)
        if (duration) data.duration = [duration[1] && `${duration[1]}h`, duration[2] && `${duration[2]}m`].filter(Boolean).join(' ')
      }
    } catch {
      // Continue with the next JSON-LD block.
    }
  }
  const synopsis = markup.match(/<div\b[^>]*class=["'][^"']*(?:synopsis|entry-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
  if (synopsis) data.synopsis = textOf(synopsis).replace(/^Sinopsis\s*:?\s*/i, '')
  return data
}

async function fetchHtml(target) {
  const response = await fetch(target, {
    headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(30000),
  })
  if (response.status === 403) return fetchHtmlInBrowser(target)
  if (!response.ok) throw new ApiError(502, `Sumber mengembalikan HTTP ${response.status}`)
  return response.text()
}

async function fetchHtmlInBrowser(target) {
  if (!chromePath) throw new ApiError(502, 'Sumber menolak permintaan dan Chrome belum dikonfigurasi')
  const browser = await puppeteer.launch({
    headless,
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  try {
    const tab = await browser.newPage()
    const response = await tab.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 })
    if (!response?.ok()) {
      throw new ApiError(502, `Sumber menolak akses dari VPS lewat Chrome (HTTP ${response?.status() || 'unknown'})`)
    }
    if (new URL(target).pathname.startsWith('/latest/')) {
      await tab.waitForSelector('.gallery-grid .poster-title', { timeout: 8000 }).catch(() => {
        throw new ApiError(502, 'Daftar film tidak tersedia di halaman sumber')
      })
    }
    return await tab.content()
  } finally {
    await browser.close()
  }
}

export async function loadMovies(page, search) {
  if (!search) {
    const markup = await fetchHtml(`${sourceBase}/latest/page/${page}`)
    return parseMovies(markup)
  }
  if (!chromePath) throw new ApiError(500, 'MALIX_CHROME_PATH belum diatur')
  const browser = await puppeteer.launch({ headless, executablePath: chromePath, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  try {
    const tab = await browser.newPage()
    const target = page === 1 ? `${sourceBase}/search?s=${encodeURIComponent(search)}` : `${sourceBase}/search/page/${page}/?s=${encodeURIComponent(search)}`
    await tab.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await tab.waitForSelector('.gallery-grid .poster-title', { timeout: 8000 }).catch(() => {})
    return parseMovies(await tab.content())
  } finally {
    await browser.close()
  }
}

export async function loadMovieDetail(path) {
  const target = sourcePage(path)
  const markup = await fetchHtml(target.href)
  return parseDetail(markup)
}
