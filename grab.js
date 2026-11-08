import puppeteer from 'puppeteer-core'
import { setTimeout as delay } from 'node:timers/promises'
import { ApiError, chromePath, headless, mediaHosts, sourcePage, userAgent } from './config.js'
import { createTrace, visibleMessage, visibleUrl } from './trace.js'

const blockedRequests = ['doubleclick', 'googleads', 'dadadidi', 'mahjonged', 'slotirn', 'popads', 'adservice', 'analytics', 'tracker', 'banner', 'iklan', 'judi']
const blockedMedia = ['trailer', 'promo', 'ad_', 'preview', 'judi', 'iklan', 'gambling']

export function isMediaCandidate(url, mimeType = '') {
  const lower = String(url || '').toLowerCase()
  if (!lower.startsWith('http') || blockedMedia.some((word) => lower.includes(word))) return false
  return lower.includes('.m3u8') || lower.includes('.mp4') || String(mimeType).toLowerCase().includes('mpegurl')
}

export async function grabUrls(pathOrUrl, trace = createTrace('grab', process.env.MALIX_TRACE === '1')) {
  const target = sourcePage(pathOrUrl)
  if (!chromePath) throw new ApiError(500, 'MALIX_CHROME_PATH belum diatur')
  trace.record('browser.launch', { target: visibleUrl(target.href), headless })
  const browser = await puppeteer.launch({
    headless,
    executablePath: chromePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1920,1080',
    ],
  })

  try {
    const page = await browser.newPage()
    trace.record('browser.ready')
    await page.setUserAgent(userAgent)
    const candidates = new Set()
    const capture = (url, mimeType, source) => {
      if (!isMediaCandidate(url, mimeType) || candidates.has(url)) return
      candidates.add(url)
      trace.counts.candidates++
      trace.record('media.candidate', { url: visibleUrl(url), mimeType: mimeType || '', source })
    }

    page.on('framenavigated', (frame) => {
      trace.record('frame.navigate', { url: visibleUrl(frame.url()) }, true)
    })
    page.on('requestfailed', (request) => {
      trace.counts.failed++
      trace.record('network.failed', {
        url: visibleUrl(request.url()),
        resourceType: request.resourceType(),
        error: request.failure()?.errorText || 'unknown',
      }, true)
    })
    page.on('pageerror', (error) => trace.record('page.error', { message: visibleMessage(error.message) }))
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type())) {
        trace.record('page.console', { level: message.type(), message: visibleMessage(message.text()) }, true)
      }
    })
    await page.evaluateOnNewDocument(() => {
      window.open = () => null
      try { localStorage.clear(); sessionStorage.clear() } catch {}
    })
    page.on('popup', (popup) => {
      trace.record('popup.closed', { url: visibleUrl(popup.url()) }, true)
      popup.close().catch(() => {})
    })
    await page.setRequestInterception(true)
    page.on('request', (request) => {
      if (request.isInterceptResolutionHandled()) return
      trace.counts.requests++
      const lower = request.url().toLowerCase()
      const details = { url: visibleUrl(request.url()), resourceType: request.resourceType() }
      if (blockedRequests.some((word) => lower.includes(word))) {
        trace.counts.blocked++
        trace.record('network.blocked', details, true)
        request.abort().catch(() => {})
      } else {
        if (['document', 'xhr', 'fetch', 'media'].includes(request.resourceType())) trace.record('network.request', details, true)
        request.continue().catch(() => {})
      }
    })
    page.on('response', (response) => {
      trace.counts.responses++
      const resourceType = response.request().resourceType()
      if (['document', 'xhr', 'fetch', 'media'].includes(resourceType) || response.status() >= 400) {
        trace.record('network.response', {
          url: visibleUrl(response.url()),
          status: response.status(),
          resourceType,
          contentType: response.headers()['content-type'] || '',
          contentLength: response.headers()['content-length'] || '',
        }, true)
      }
      capture(response.url(), response.headers()['content-type'], 'page.response')
    })

    const cdp = await page.createCDPSession()
    await cdp.send('Network.enable')
    cdp.on('Network.responseReceived', ({ response }) => capture(response.url, response.mimeType, 'cdp.response'))

    trace.record('navigation.start', { url: visibleUrl(target.href) })
    const navigation = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 45000 })
    trace.record('navigation.done', {
      status: navigation?.status() || 0,
      title: (await page.title()).slice(0, 160),
      frames: page.frames().length,
    })
    await delay(3000)

    const p2p = await page.$('a[data-server="p2p"]')
    if (!p2p) throw new ApiError(502, 'Player P2P tidak tersedia pada halaman ini')
    const alreadyActive = await p2p.evaluate((element) => element.classList.contains('active'))
    if (!alreadyActive) await p2p.click({ delay: 80 })
    trace.record('player.selected', { frame: visibleUrl(page.url()), label: 'P2P', alreadyActive })
    await delay(4000)

    const verificationFrame = async () => {
      for (const frame of page.frames()) {
        try {
          const visible = await frame.$eval('.captcha-gate__play', (element) => {
            const rect = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
          })
          if (visible) return visibleUrl(frame.url())
        } catch {}
      }
      return ''
    }

    for (const frame of page.frames()) {
      try {
        await frame.evaluate(() => {
        const style = document.createElement('style')
        style.textContent = '#uyeouyeo, .message-box, a[target="_blank"].visible { display: none !important; }'
        document.head.appendChild(style)
        let started = false
        const tick = () => {
          for (const element of document.querySelectorAll('div, span, img, p')) {
            const text = (element.textContent || '').toUpperCase()
            if ((text.includes('JUDI ONLINE') || text.includes('MEMERANGI JUDI')) && element.children.length === 0) element.remove()
          }
          const buttons = Array.from(document.querySelectorAll('button, div, span, a'))
          const startButton = buttons.find((element) => (element.textContent || '').trim().toUpperCase() === 'DARI AWAL')
          if (startButton && !started) {
            started = true
            startButton.click()
          }
          for (const video of document.querySelectorAll('video')) {
            if (video.src?.includes('judi')) video.pause()
            else if (video.paused) {
              video.muted = true
              video.play().catch(() => {})
            }
          }
        }
        tick()
        setInterval(tick, 500)
        })
      } catch {}
    }

    for (const frame of page.frames()) {
      if (!/\/iframe3\/p2p\/|playcdn\./i.test(frame.url())) continue
      try {
        await frame.click('body', { delay: 80 })
        trace.record('player.click', { label: 'P2P iframe', selector: 'body', frame: visibleUrl(frame.url()) })
      } catch (error) {
        trace.record('player.click.failed', { label: 'P2P iframe', frame: visibleUrl(frame.url()), error: visibleMessage(error.message) })
      }
    }

    await delay(1000)
    const pendingFrame = await verificationFrame()
    if (pendingFrame) {
      trace.record('verification.pending', {
        frame: pendingFrame,
        message: headless
          ? 'Player meminta verifikasi manusia; jalankan Chrome dengan MALIX_HEADLESS=0.'
          : 'Player meminta verifikasi manusia; klik Play secara manual di jendela Chrome.',
      })
    }
    for (let i = 0; candidates.size === 0 && i < (headless ? 20 : 60); i++) await delay(1000)

    for (const frame of page.frames()) {
      try {
        const src = await frame.evaluate(() => document.querySelector('video')?.src || '')
        capture(src, '', 'video.src')
      } catch {}
    }

    const urls = [...candidates]
    if (!urls.length && await verificationFrame()) {
      throw new ApiError(409, headless
        ? 'Player meminta verifikasi manusia. Jalankan backend dengan MALIX_HEADLESS=0 lalu klik Play di Chrome.'
        : 'Player masih meminta verifikasi manusia. Klik Play secara manual di jendela Chrome saat proses grab berjalan.')
    }
    for (const url of urls) mediaHosts.add(new URL(url).hostname.toLowerCase())
    trace.record('result', { urls: urls.length, frames: page.frames().length, counts: { ...trace.counts } })
    return urls
  } catch (error) {
    trace.record('browser.error', { message: visibleMessage(error.message) })
    throw error
  } finally {
    await browser.close()
    trace.record('browser.closed')
  }
}
