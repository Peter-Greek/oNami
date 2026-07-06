import http from 'node:http'
import { randomBytes, randomUUID, createHash, timingSafeEqual, verify as verifySignature } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const config = {
  port: Number(process.env.ONAMI_HOST_PORT ?? process.env.PORT ?? 41729),
  host: process.env.ONAMI_HOST_BIND ?? '127.0.0.1',
  dataDir: process.env.ONAMI_HOST_DATA_DIR ?? path.join(__dirname, 'data'),
  corsOrigin: process.env.ONAMI_HOST_CORS_ORIGIN ?? '*',
  pairingTtlMs: Number(process.env.ONAMI_PAIRING_TTL_MS ?? 10 * 60 * 1000),
  tokenTtlMs: Number(process.env.ONAMI_DEVICE_TOKEN_TTL_MS ?? 7 * 24 * 60 * 60 * 1000),
  maxJsonBytes: Number(process.env.ONAMI_MAX_JSON_BYTES ?? 1024 * 1024),
}

fs.mkdirSync(config.dataDir, { recursive: true })

const db = new Database(path.join(config.dataDir, 'onami-host.sqlite'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

const nowIso = () => new Date().toISOString()
const expiresAt = (ttlMs) => new Date(Date.now() + ttlMs).toISOString()
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const tokenHash = (token) => sha256(`token:${token}`)
const codeHash = (code) => sha256(`pairing:${normalizePairingCode(code)}`)

const createPairingCode = () => {
  const digits = String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0')
  return `${digits.slice(0, 3)}-${digits.slice(3)}`
}

const createConfirmationCode = () =>
  String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0')

const normalizePairingCode = (code) => {
  if (typeof code !== 'string') return ''
  return code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
}

const safeEqual = (a, b) => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

const requiredString = (body, key) => {
  const value = body?.[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw httpError(400, `${key} is required.`)
  }
  return value.trim()
}

const optionalString = (body, key) => {
  const value = body?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

const httpError = (status, message) => Object.assign(new Error(message), { status })

const migrate = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_groups (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      sync_group_id TEXT REFERENCES sync_groups(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      public_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS pairing_sessions (
      id TEXT PRIMARY KEY,
      initiator_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      joining_device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL UNIQUE,
      confirmation_code TEXT NOT NULL,
      mode TEXT,
      initiator_confirmed_at TEXT,
      joiner_confirmed_at TEXT,
      completed_at TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      sync_group_id TEXT NOT NULL REFERENCES sync_groups(id) ON DELETE CASCADE,
      source_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(source_device_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS device_cursors (
      sync_group_id TEXT NOT NULL REFERENCES sync_groups(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      last_event_id INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (sync_group_id, device_id)
    );

    CREATE TABLE IF NOT EXISTS media_objects (
      id TEXT PRIMARY KEY,
      sync_group_id TEXT NOT NULL REFERENCES sync_groups(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(sync_group_id, sha256)
    );

    CREATE TABLE IF NOT EXISTS device_tokens (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_devices_sync_group ON devices(sync_group_id);
    CREATE INDEX IF NOT EXISTS idx_pairing_expires ON pairing_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_sync_events_group_id ON sync_events(sync_group_id, id);
    CREATE INDEX IF NOT EXISTS idx_device_tokens_hash ON device_tokens(token_hash);
  `)
}

migrate()

const upsertDevice = ({ deviceId, name, platform, publicKey }) => {
  const existing = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId)
  const timestamp = nowIso()

  if (existing) {
    if (!safeEqual(String(existing.public_key), publicKey)) {
      throw httpError(409, 'Device id already exists with a different public key.')
    }

    db.prepare(
      `UPDATE devices
       SET name = ?, platform = ?, last_seen_at = ?
       WHERE id = ?`
    ).run(name, platform, timestamp, deviceId)
    return db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId)
  }

  db.prepare(
    `INSERT INTO devices (id, sync_group_id, name, platform, public_key, created_at, last_seen_at, revoked_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, NULL)`
  ).run(deviceId, name, platform, publicKey, timestamp, timestamp)

  return db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId)
}

const getPairingSessionByCode = (code) => {
  const session = db
    .prepare('SELECT * FROM pairing_sessions WHERE code_hash = ?')
    .get(codeHash(code))
  if (!session) throw httpError(404, 'Pairing code not found.')
  if (session.completed_at) throw httpError(409, 'Pairing code has already been used.')
  if (Date.parse(String(session.expires_at)) <= Date.now()) throw httpError(410, 'Pairing code has expired.')
  return session
}

const completePairingIfReady = (sessionId) => {
  return db.transaction(() => {
    const session = db.prepare('SELECT * FROM pairing_sessions WHERE id = ?').get(sessionId)
    if (!session?.initiator_confirmed_at || !session?.joiner_confirmed_at || session.completed_at) {
      return { completed: Boolean(session?.completed_at), syncGroupId: null }
    }

    const initiator = db.prepare('SELECT * FROM devices WHERE id = ?').get(session.initiator_device_id)
    const joiner = db.prepare('SELECT * FROM devices WHERE id = ?').get(session.joining_device_id)
    if (!initiator || !joiner) throw httpError(409, 'Both devices must be registered before pairing can complete.')

    const timestamp = nowIso()
    const syncGroupId = initiator.sync_group_id || joiner.sync_group_id || randomUUID()
    if (!initiator.sync_group_id && !joiner.sync_group_id) {
      db.prepare('INSERT INTO sync_groups (id, created_at, updated_at) VALUES (?, ?, ?)').run(
        syncGroupId,
        timestamp,
        timestamp
      )
    } else {
      db.prepare('UPDATE sync_groups SET updated_at = ? WHERE id = ?').run(timestamp, syncGroupId)
    }

    db.prepare('UPDATE devices SET sync_group_id = ?, revoked_at = NULL, last_seen_at = ? WHERE id IN (?, ?)').run(
      syncGroupId,
      timestamp,
      session.initiator_device_id,
      session.joining_device_id
    )
    db.prepare('UPDATE pairing_sessions SET completed_at = ? WHERE id = ?').run(timestamp, sessionId)

    return { completed: true, syncGroupId }
  })()
}

const issueDeviceToken = (deviceId) => {
  const token = randomBytes(32).toString('base64url')
  const timestamp = nowIso()
  const expiry = expiresAt(config.tokenTtlMs)
  db.prepare('INSERT INTO device_tokens (id, device_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(
    randomUUID(),
    deviceId,
    tokenHash(token),
    expiry,
    timestamp
  )
  return { token, expiresAt: expiry }
}

const verifyDeviceProof = ({ device, timestamp, signature }) => {
  if (typeof timestamp !== 'string' || typeof signature !== 'string') return false
  if (Math.abs(Date.now() - Date.parse(timestamp)) > 5 * 60 * 1000) return false

  const payload = Buffer.from(`${device.id}.${timestamp}`)
  const signatureBytes = Buffer.from(signature, 'base64')

  try {
    return verifySignature(null, payload, String(device.public_key), signatureBytes)
  } catch {
    try {
      return verifySignature('sha256', payload, String(device.public_key), signatureBytes)
    } catch {
      return false
    }
  }
}

const authenticate = (request) => {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) throw httpError(401, 'Missing bearer token.')

  const hash = tokenHash(header.slice('Bearer '.length).trim())
  const row = db
    .prepare(
      `SELECT d.*
       FROM device_tokens t
       JOIN devices d ON d.id = t.device_id
       WHERE t.token_hash = ? AND t.expires_at > ?`
    )
    .get(hash, nowIso())

  if (!row) throw httpError(401, 'Invalid or expired device token.')
  if (!row.sync_group_id || row.revoked_at) throw httpError(403, 'Device is not an active member of a sync group.')

  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(nowIso(), row.id)
  return row
}

const readJson = async (request) => {
  const chunks = []
  let size = 0

  for await (const chunk of request) {
    size += chunk.length
    if (size > config.maxJsonBytes) throw httpError(413, 'Request body is too large.')
    chunks.push(chunk)
  }

  if (chunks.length === 0) return {}

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw httpError(400, 'Request body must be valid JSON.')
  }
}

const send = (response, status, body) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': config.corsOrigin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
  })
  response.end(JSON.stringify(body))
}

const route = async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

  if (request.method === 'OPTIONS') return send(response, 204, {})
  if (request.method === 'GET' && url.pathname === '/health') {
    return send(response, 200, { ok: true, service: 'onami-host', time: nowIso() })
  }

  if (request.method === 'POST' && url.pathname === '/devices/bootstrap') {
    const body = await readJson(request)
    const device = upsertDevice({
      deviceId: optionalString(body, 'deviceId') ?? randomUUID(),
      name: requiredString(body, 'name'),
      platform: requiredString(body, 'platform'),
      publicKey: requiredString(body, 'publicKey'),
    })
    return send(response, 200, {
      deviceId: device.id,
      syncGroupId: device.sync_group_id ?? null,
      paired: Boolean(device.sync_group_id && !device.revoked_at),
    })
  }

  if (request.method === 'POST' && url.pathname === '/pairing/start') {
    const body = await readJson(request)
    const device = upsertDevice({
      deviceId: optionalString(body, 'deviceId') ?? randomUUID(),
      name: requiredString(body, 'name'),
      platform: requiredString(body, 'platform'),
      publicKey: requiredString(body, 'publicKey'),
    })

    db.prepare('DELETE FROM pairing_sessions WHERE initiator_device_id = ? AND completed_at IS NULL').run(device.id)

    const code = createPairingCode()
    const confirmationCode = createConfirmationCode()
    db.prepare(
      `INSERT INTO pairing_sessions
        (id, initiator_device_id, joining_device_id, code_hash, confirmation_code, mode,
         initiator_confirmed_at, joiner_confirmed_at, completed_at, expires_at, created_at)
       VALUES (?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`
    ).run(randomUUID(), device.id, codeHash(code), confirmationCode, expiresAt(config.pairingTtlMs), nowIso())

    return send(response, 200, {
      deviceId: device.id,
      pairingCode: code,
      confirmationCode,
      expiresInMs: config.pairingTtlMs,
    })
  }

  if (request.method === 'POST' && url.pathname === '/pairing/join') {
    const body = await readJson(request)
    const session = getPairingSessionByCode(requiredString(body, 'pairingCode'))
    const device = upsertDevice({
      deviceId: optionalString(body, 'deviceId') ?? randomUUID(),
      name: requiredString(body, 'name'),
      platform: requiredString(body, 'platform'),
      publicKey: requiredString(body, 'publicKey'),
    })

    if (device.id === session.initiator_device_id) throw httpError(400, 'A device cannot pair with itself.')

    db.prepare('UPDATE pairing_sessions SET joining_device_id = ? WHERE id = ?').run(device.id, session.id)

    return send(response, 200, {
      deviceId: device.id,
      confirmationCode: session.confirmation_code,
      expiresAt: session.expires_at,
    })
  }

  if (request.method === 'POST' && url.pathname === '/pairing/confirm') {
    const body = await readJson(request)
    const deviceId = requiredString(body, 'deviceId')
    const session = getPairingSessionByCode(requiredString(body, 'pairingCode'))
    const mode = optionalString(body, 'mode') ?? 'merge'
    if (!['merge', 'copy-desktop-to-phone', 'copy-phone-to-desktop'].includes(mode)) {
      throw httpError(400, 'mode must be merge, copy-desktop-to-phone, or copy-phone-to-desktop.')
    }

    if (deviceId === session.initiator_device_id) {
      db.prepare('UPDATE pairing_sessions SET initiator_confirmed_at = ?, mode = COALESCE(mode, ?) WHERE id = ?').run(
        nowIso(),
        mode,
        session.id
      )
    } else if (deviceId === session.joining_device_id) {
      db.prepare('UPDATE pairing_sessions SET joiner_confirmed_at = ?, mode = COALESCE(mode, ?) WHERE id = ?').run(
        nowIso(),
        mode,
        session.id
      )
    } else {
      throw httpError(403, 'Device is not part of this pairing session.')
    }

    const result = completePairingIfReady(session.id)
    return send(response, 200, {
      completed: result.completed,
      syncGroupId: result.syncGroupId,
      mode,
    })
  }

  if (request.method === 'POST' && url.pathname === '/devices/token') {
    const body = await readJson(request)
    const deviceId = requiredString(body, 'deviceId')
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId)
    if (!device || !device.sync_group_id || device.revoked_at) {
      throw httpError(403, 'Device is not paired.')
    }
    if (!verifyDeviceProof({ device, timestamp: body.timestamp, signature: body.signature })) {
      throw httpError(401, 'Invalid device proof.')
    }

    return send(response, 200, issueDeviceToken(deviceId))
  }

  if (request.method === 'POST' && url.pathname === '/sync/events') {
    const device = authenticate(request)
    const body = await readJson(request)
    const events = Array.isArray(body.events) ? body.events : null
    if (!events) throw httpError(400, 'events must be an array.')

    const accepted = db.transaction(() => {
      let highestAcceptedSequence = 0
      for (const event of events) {
        const eventId = requiredString(event, 'eventId')
        const sourceDeviceId = requiredString(event, 'sourceDeviceId')
        if (sourceDeviceId !== device.id) throw httpError(403, 'sourceDeviceId must match the authenticated device.')

        const sequence = Number(event.sequence)
        if (!Number.isInteger(sequence) || sequence <= 0) throw httpError(400, 'sequence must be a positive integer.')

        const existingById = db.prepare('SELECT sequence FROM sync_events WHERE event_id = ?').get(eventId)
        if (existingById) {
          highestAcceptedSequence = Math.max(highestAcceptedSequence, Number(existingById.sequence))
          continue
        }

        const existingBySequence = db
          .prepare('SELECT event_id FROM sync_events WHERE source_device_id = ? AND sequence = ?')
          .get(device.id, sequence)
        if (existingBySequence) throw httpError(409, 'A different event already exists for this device sequence.')

        db.prepare(
          `INSERT INTO sync_events
            (event_id, sync_group_id, source_device_id, sequence, entity_type, entity_id, event_type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          eventId,
          device.sync_group_id,
          device.id,
          sequence,
          requiredString(event, 'entityType'),
          requiredString(event, 'entityId'),
          requiredString(event, 'eventType'),
          JSON.stringify(event.payload ?? {}),
          optionalString(event, 'createdAt') ?? nowIso()
        )
        highestAcceptedSequence = Math.max(highestAcceptedSequence, sequence)
      }

      return highestAcceptedSequence
    })()

    return send(response, 200, { accepted: events.length, highestAcceptedSequence: accepted })
  }

  if (request.method === 'GET' && url.pathname === '/sync/events') {
    const device = authenticate(request)
    const after = Number(url.searchParams.get('after') ?? 0)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100), 1), 1000)
    const includeSelf = url.searchParams.get('includeSelf') === 'true'

    const rows = db
      .prepare(
        `SELECT *
         FROM sync_events
         WHERE sync_group_id = ?
           AND id > ?
           AND (? = 1 OR source_device_id != ?)
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(device.sync_group_id, Number.isFinite(after) ? after : 0, includeSelf ? 1 : 0, device.id, limit)

    return send(response, 200, {
      events: rows.map((row) => ({
        hostEventId: row.id,
        eventId: row.event_id,
        sourceDeviceId: row.source_device_id,
        sequence: row.sequence,
        entityType: row.entity_type,
        entityId: row.entity_id,
        eventType: row.event_type,
        payload: JSON.parse(row.payload_json),
        createdAt: row.created_at,
      })),
      nextCursor: rows.length ? rows[rows.length - 1].id : after,
    })
  }

  if (request.method === 'POST' && url.pathname === '/sync/ack') {
    const device = authenticate(request)
    const body = await readJson(request)
    const lastEventId = Number(body.lastEventId)
    if (!Number.isInteger(lastEventId) || lastEventId < 0) throw httpError(400, 'lastEventId must be a non-negative integer.')

    db.prepare(
      `INSERT INTO device_cursors (sync_group_id, device_id, last_event_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(sync_group_id, device_id) DO UPDATE SET
         last_event_id = MAX(device_cursors.last_event_id, excluded.last_event_id),
         updated_at = excluded.updated_at`
    ).run(device.sync_group_id, device.id, lastEventId, nowIso())

    return send(response, 200, { ok: true })
  }

  return send(response, 404, { error: 'Not found.' })
}

const server = http.createServer((request, response) => {
  route(request, response).catch((error) => {
    const status = Number(error.status ?? 500)
    const message = status >= 500 ? 'Internal server error.' : error.message
    if (status >= 500) console.error(error)
    send(response, status, { error: message })
  })
})

const shutdown = () => {
  server.close(() => {
    db.close()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

server.listen(config.port, config.host, () => {
  console.log(`oNami host listening on http://${config.host}:${config.port}`)
})
