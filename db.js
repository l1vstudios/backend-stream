import { createClient } from '@libsql/client'
import { ApiError } from './config.js'
import './env.js'

let client
let userIndexPromise
let cacheIndexPromise
let collectionTablePromise
let watchPartyTablesPromise

export function database() {
  if (client) return client
  const url = process.env.BUNNY_DATABASE_URL
  const authToken = process.env.BUNNY_DATABASE_AUTH_TOKEN
  if (!url || !authToken) throw new ApiError(503, 'Koneksi malixdb belum dikonfigurasi')
  client = createClient({ url, authToken })
  return client
}

export function ensureUserIndex() {
  userIndexPromise ??= database().execute(
    'CREATE UNIQUE INDEX IF NOT EXISTS user_username_unique ON "user" (username COLLATE NOCASE)',
  ).catch((error) => {
    userIndexPromise = undefined
    throw error
  })
  return userIndexPromise
}

export function ensureCacheIndex() {
  cacheIndexPromise ??= database().execute(
    'CREATE UNIQUE INDEX IF NOT EXISTS cache_stream_query_film_unique ON "cache_stream" (query_film COLLATE NOCASE)',
  ).catch((error) => {
    cacheIndexPromise = undefined
    throw error
  })
  return cacheIndexPromise
}

export function ensureCollectionTable() {
  collectionTablePromise ??= database().execute(`
    CREATE TABLE IF NOT EXISTS collection_film (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      film_path TEXT NOT NULL,
      title TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '',
      poster_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, film_path)
    )
  `).then(() => database().execute(
    'CREATE INDEX IF NOT EXISTS collection_film_user_created ON collection_film (user_id, created_at DESC)',
  )).catch((error) => {
    collectionTablePromise = undefined
    throw error
  })
  return collectionTablePromise
}

export function ensureWatchPartyTables() {
  watchPartyTablesPromise ??= (async () => {
    await database().execute(`
      CREATE TABLE IF NOT EXISTS watch_party_room (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        creator_user_id INTEGER NOT NULL REFERENCES "user"(id),
        film_path TEXT NOT NULL,
        title TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '',
        poster_url TEXT NOT NULL DEFAULT '',
        access_mode TEXT NOT NULL CHECK (access_mode IN ('public', 'pin')),
        pin_hash TEXT,
        position_seconds REAL NOT NULL DEFAULT 0,
        is_playing INTEGER NOT NULL DEFAULT 0,
        playback_updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    await database().execute(`
      CREATE TABLE IF NOT EXISTS watch_party_member (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL REFERENCES watch_party_room(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        joined_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE (room_id, user_id)
      )
    `)
    await database().execute('CREATE INDEX IF NOT EXISTS watch_party_member_room_seen ON watch_party_member (room_id, last_seen_at)')
  })().catch((error) => {
    watchPartyTablesPromise = undefined
    throw error
  })
  return watchPartyTablesPromise
}
