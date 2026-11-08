import { randomUUID } from 'node:crypto'

const maxEvents = 250
const maxNetworkEvents = 180

export function visibleUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'about:') return url.href
    if (!['http:', 'https:'].includes(url.protocol)) return `${url.protocol}[omitted]`
    return `${url.origin}${url.pathname}`.slice(0, 220)
  } catch {
    return String(value || '').split(/[?#]/, 1)[0].slice(0, 220)
  }
}

export function visibleMessage(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s"'<>]+/g, (url) => visibleUrl(url))
    .slice(0, 240)
}

export function createTrace(operation, verbose = false) {
  const id = randomUUID().slice(0, 8)
  const started = Date.now()
  const events = []
  const counts = { requests: 0, responses: 0, blocked: 0, failed: 0, candidates: 0 }
  let omitted = 0
  let networkEvents = 0

  function record(type, details = {}, network = false) {
    const event = { ms: Date.now() - started, type, ...details }
    if (events.length < maxEvents && (!network || networkEvents < maxNetworkEvents)) {
      events.push(event)
      if (network) networkEvents++
    }
    else omitted++
    if (!network || verbose) console.info(`[${operation} ${id} +${event.ms}ms] ${type}`, details)
  }

  function snapshot() {
    return { id, elapsedMs: Date.now() - started, counts: { ...counts }, omitted, events: [...events] }
  }

  return { record, snapshot, counts }
}
