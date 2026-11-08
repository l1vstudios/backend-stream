import { WebSocket, WebSocketServer } from 'ws'
import { authorizePartyMember } from './party-access.js'

const roomPeers = new Map()

function iceServers() {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }]
  if (!process.env.MALIX_ICE_SERVERS) return servers
  let configured
  try { configured = JSON.parse(process.env.MALIX_ICE_SERVERS) } catch { return servers }
  if (!Array.isArray(configured)) return servers
  for (const server of configured.slice(0, 4)) {
    const urls = typeof server?.urls === 'string' ? [server.urls] : server?.urls
    if (!Array.isArray(urls) || !urls.length || !urls.every((url) => typeof url === 'string' && /^(stun|stuns|turn|turns):/i.test(url))) continue
    servers.push({ urls, ...(server.username ? { username: String(server.username) } : {}), ...(server.credential ? { credential: String(server.credential) } : {}) })
  }
  return servers
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

function peersFor(code) {
  let peers = roomPeers.get(code)
  if (!peers) {
    peers = new Map()
    roomPeers.set(code, peers)
  }
  return peers
}

function handleMessage(code, peer, raw) {
  let message
  try { message = JSON.parse(raw.toString()) } catch { return }
  if (!message || typeof message !== 'object') return
  const peers = roomPeers.get(code)
  if (!peers || peers.get(peer.userId) !== peer) return

  if (message.type === 'media-state') {
    if (typeof message.camera !== 'boolean' || typeof message.mic !== 'boolean') return
    peer.camera = message.camera
    peer.mic = message.mic
    for (const other of peers.values()) {
      if (other !== peer) send(other.socket, { type: 'media-state', from: peer.userId, camera: peer.camera, mic: peer.mic })
    }
    return
  }

  if (!['offer', 'answer', 'ice'].includes(message.type) || !Number.isSafeInteger(message.to) || message.to === peer.userId) return
  const target = peers.get(message.to)
  if (!target) return
  if (message.type === 'ice') {
    const candidate = message.candidate
    if (!candidate || typeof candidate.candidate !== 'string' || candidate.candidate.length > 8192) return
    send(target.socket, { type: 'ice', from: peer.userId, candidate })
    return
  }
  const description = message.description
  if (description?.type !== message.type || typeof description.sdp !== 'string' || description.sdp.length > 60000) return
  send(target.socket, { type: message.type, from: peer.userId, description })
}

function joinSocket(socket, code, user) {
  const peers = peersFor(code)
  const prior = peers.get(user.id)
  if (prior) prior.socket.close(4000, 'Dibuka di tab lain')
  const existing = [...peers.values()].filter((peer) => peer !== prior)
  const peer = { socket, userId: user.id, username: user.username, camera: false, mic: false }
  peers.set(user.id, peer)
  send(socket, { type: 'peers', iceServers: iceServers(), peers: existing.map(({ userId, username, camera, mic }) => ({ userId, username, camera, mic })) })
  for (const other of existing) send(other.socket, { type: 'peer-joined', userId: user.id, username: user.username })
  socket.on('message', (raw) => handleMessage(code, peer, raw))
  socket.on('close', () => {
    if (peers.get(user.id) !== peer) return
    peers.delete(user.id)
    for (const other of peers.values()) send(other.socket, { type: 'peer-left', userId: user.id })
    if (!peers.size) roomPeers.delete(code)
  })
}

export function disconnectRoomMedia(code, reason = 'room-ended', hostId = null) {
  const peers = roomPeers.get(code)
  if (!peers) return
  for (const peer of peers.values()) {
    if (hostId !== null && peer.userId === hostId) continue
    send(peer.socket, { type: reason })
    peer.socket.close(4001, reason)
  }
}

export function disconnectMemberMedia(code, userId, reason = 'left-room') {
  const peer = roomPeers.get(code)?.get(userId)
  if (!peer) return
  send(peer.socket, { type: reason })
  peer.socket.close(4001, reason)
}

export function attachPartySignaling(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  server.on('upgrade', async (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://localhost')
    if (url.pathname !== '/api/watch-party/socket') {
      socket.destroy()
      return
    }
    try {
      const code = url.searchParams.get('room')
      const { room, user } = await authorizePartyMember(request, code)
      if (socket.destroyed) return
      wss.handleUpgrade(request, socket, head, (client) => joinSocket(client, String(room.code), user))
    } catch (error) {
      if (!socket.destroyed) {
        socket.write(`HTTP/1.1 ${error.status || 500} ${error.status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\n\r\n`)
        socket.destroy()
      }
    }
  })
  return wss
}
