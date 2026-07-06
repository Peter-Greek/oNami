import http from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual, verify as verifySignature } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PrismaClient } from '@prisma/client'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const loadEnvFile = (filePath) => {
  if (!fs.existsSync(filePath)) return
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    const [, key, rawValue] = match
    if (process.env[key] !== undefined) continue
    process.env[key] = rawValue.trim().replace(/^"(.*)"$/, '$1')
  }
}

loadEnvFile(path.join(__dirname, '.env'))

const config = {
  port: Number(process.env.ONAMI_HOST_PORT ?? process.env.PORT ?? 41730),
  host: process.env.ONAMI_HOST_BIND ?? '127.0.0.1',
  corsOrigin: process.env.ONAMI_HOST_CORS_ORIGIN ?? '*',
  pairingTtlMs: Number(process.env.ONAMI_PAIRING_TTL_MS ?? 10 * 60 * 1000),
  tokenTtlMs: Number(process.env.ONAMI_DEVICE_TOKEN_TTL_MS ?? 7 * 24 * 60 * 60 * 1000),
  maxJsonBytes: Number(process.env.ONAMI_MAX_JSON_BYTES ?? 1024 * 1024),
  // Full-data snapshots and single media blobs are much larger than incremental events.
  maxBlobBytes: Number(process.env.ONAMI_MAX_BLOB_BYTES ?? 64 * 1024 * 1024),
  mediaDir: process.env.ONAMI_MEDIA_DIR ?? path.join(__dirname, 'media-store'),
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Run host/setup.bat or create host/.env.')
  process.exit(1)
}

fs.mkdirSync(config.mediaDir, { recursive: true })

const sanitizeSha256 = (value) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw httpError(400, 'sha256 must be a 64-character hex string.')
  }
  return value.toLowerCase()
}

const mediaBlobPath = (sha256) => path.join(config.mediaDir, sanitizeSha256(sha256))

const prisma = new PrismaClient()

const now = () => new Date()
const nowIso = () => new Date().toISOString()
const expiresAt = (ttlMs) => new Date(Date.now() + ttlMs)
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

const httpError = (status, message) => Object.assign(new Error(message), { status })

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

const upsertDevice = async ({ deviceId, name, platform, publicKey }) => {
  const existing = await prisma.device.findUnique({ where: { id: deviceId } })
  if (existing) {
    if (!safeEqual(existing.publicKey, publicKey)) {
      throw httpError(409, 'Device id already exists with a different public key.')
    }

    return prisma.device.update({
      where: { id: deviceId },
      data: { name, platform, lastSeenAt: now() },
    })
  }

  return prisma.device.create({
    data: {
      id: deviceId,
      name,
      platform,
      publicKey,
      lastSeenAt: now(),
    },
  })
}

const getPairingSessionByCode = async (code) => {
  const session = await prisma.pairingSession.findUnique({
    where: { codeHash: codeHash(code) },
  })
  if (!session) throw httpError(404, 'Pairing code not found.')
  if (session.completedAt) throw httpError(409, 'Pairing code has already been used.')
  if (session.expiresAt.getTime() <= Date.now()) throw httpError(410, 'Pairing code has expired.')
  return session
}

const completePairingIfReady = async (sessionId) => {
  return prisma.$transaction(async (tx) => {
    const session = await tx.pairingSession.findUnique({ where: { id: sessionId } })
    if (!session) return { completed: false, syncGroupId: null }

    if (session.completedAt) {
      const pairedDevice = await tx.device.findFirst({
        where: {
          id: { in: [session.initiatorDeviceId, session.joiningDeviceId].filter(Boolean) },
          syncGroupId: { not: null },
        },
        select: { syncGroupId: true },
      })
      return { completed: true, syncGroupId: pairedDevice?.syncGroupId ?? null }
    }

    if (!session.initiatorConfirmedAt || !session.joinerConfirmedAt) {
      return { completed: false, syncGroupId: null }
    }

    const [initiator, joiner] = await Promise.all([
      tx.device.findUnique({ where: { id: session.initiatorDeviceId } }),
      session.joiningDeviceId ? tx.device.findUnique({ where: { id: session.joiningDeviceId } }) : null,
    ])

    if (!initiator || !joiner) throw httpError(409, 'Both devices must be registered before pairing can complete.')

    let syncGroupId = initiator.syncGroupId || joiner.syncGroupId
    if (!syncGroupId) {
      const group = await tx.syncGroup.create({ data: {} })
      syncGroupId = group.id
    }

    await tx.device.updateMany({
      where: { id: { in: [initiator.id, joiner.id] } },
      data: { syncGroupId, revokedAt: null, lastSeenAt: now() },
    })
    await tx.pairingSession.update({
      where: { id: sessionId },
      data: { completedAt: now() },
    })

    return { completed: true, syncGroupId }
  })
}

const issueDeviceToken = async (deviceId) => {
  const token = randomBytes(32).toString('base64url')
  const expiry = expiresAt(config.tokenTtlMs)
  await prisma.deviceToken.create({
    data: {
      deviceId,
      tokenHash: tokenHash(token),
      expiresAt: expiry,
    },
  })
  return { token, expiresAt: expiry.toISOString() }
}

const verifyDeviceProof = ({ device, timestamp, signature }) => {
  if (typeof timestamp !== 'string' || typeof signature !== 'string') return false
  const timestampMs = Date.parse(timestamp)
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) return false

  const payload = Buffer.from(`${device.id}.${timestamp}`)
  const signatureBytes = Buffer.from(signature, 'base64')

  try {
    return verifySignature(null, payload, device.publicKey, signatureBytes)
  } catch {
    try {
      return verifySignature('sha256', payload, device.publicKey, signatureBytes)
    } catch {
      return false
    }
  }
}

const authenticate = async (request) => {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) throw httpError(401, 'Missing bearer token.')

  const record = await prisma.deviceToken.findUnique({
    where: { tokenHash: tokenHash(header.slice('Bearer '.length).trim()) },
    include: { device: true },
  })

  if (!record || record.expiresAt.getTime() <= Date.now()) {
    throw httpError(401, 'Invalid or expired device token.')
  }

  const { device } = record
  if (!device.syncGroupId || device.revokedAt) {
    throw httpError(403, 'Device is not an active member of a sync group.')
  }

  await prisma.device.update({
    where: { id: device.id },
    data: { lastSeenAt: now() },
  })

  return device
}

const readJson = async (request, maxBytes = config.maxJsonBytes) => {
  const chunks = []
  let size = 0

  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) throw httpError(413, 'Request body is too large.')
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
    await prisma.$queryRaw`SELECT 1`
    return send(response, 200, { ok: true, service: 'onami-host', time: nowIso() })
  }

  if (request.method === 'POST' && url.pathname === '/devices/bootstrap') {
    const body = await readJson(request)
    const device = await upsertDevice({
      deviceId: optionalString(body, 'deviceId') ?? randomUUID(),
      name: requiredString(body, 'name'),
      platform: requiredString(body, 'platform'),
      publicKey: requiredString(body, 'publicKey'),
    })
    return send(response, 200, {
      deviceId: device.id,
      syncGroupId: device.syncGroupId ?? null,
      paired: Boolean(device.syncGroupId && !device.revokedAt),
    })
  }

  if (request.method === 'POST' && url.pathname === '/pairing/start') {
    const body = await readJson(request)
    const device = await upsertDevice({
      deviceId: optionalString(body, 'deviceId') ?? randomUUID(),
      name: requiredString(body, 'name'),
      platform: requiredString(body, 'platform'),
      publicKey: requiredString(body, 'publicKey'),
    })

    await prisma.pairingSession.deleteMany({
      where: { initiatorDeviceId: device.id, completedAt: null },
    })

    const code = createPairingCode()
    const confirmationCode = createConfirmationCode()
    await prisma.pairingSession.create({
      data: {
        initiatorDeviceId: device.id,
        codeHash: codeHash(code),
        confirmationCode,
        expiresAt: expiresAt(config.pairingTtlMs),
      },
    })

    return send(response, 200, {
      deviceId: device.id,
      pairingCode: code,
      confirmationCode,
      expiresInMs: config.pairingTtlMs,
    })
  }

  if (request.method === 'POST' && url.pathname === '/pairing/join') {
    const body = await readJson(request)
    const session = await getPairingSessionByCode(requiredString(body, 'pairingCode'))
    const device = await upsertDevice({
      deviceId: optionalString(body, 'deviceId') ?? randomUUID(),
      name: requiredString(body, 'name'),
      platform: requiredString(body, 'platform'),
      publicKey: requiredString(body, 'publicKey'),
    })

    if (device.id === session.initiatorDeviceId) throw httpError(400, 'A device cannot pair with itself.')

    await prisma.pairingSession.update({
      where: { id: session.id },
      data: { joiningDeviceId: device.id },
    })

    return send(response, 200, {
      deviceId: device.id,
      confirmationCode: session.confirmationCode,
      expiresAt: session.expiresAt.toISOString(),
    })
  }

  if (request.method === 'POST' && url.pathname === '/pairing/confirm') {
    const body = await readJson(request)
    const deviceId = requiredString(body, 'deviceId')
    const session = await getPairingSessionByCode(requiredString(body, 'pairingCode'))
    const mode = optionalString(body, 'mode') ?? 'merge'
    if (!['merge', 'copy-desktop-to-phone', 'copy-phone-to-desktop'].includes(mode)) {
      throw httpError(400, 'mode must be merge, copy-desktop-to-phone, or copy-phone-to-desktop.')
    }

    if (deviceId === session.initiatorDeviceId) {
      await prisma.pairingSession.update({
        where: { id: session.id },
        data: { initiatorConfirmedAt: now(), mode: session.mode ?? mode },
      })
    } else if (deviceId === session.joiningDeviceId) {
      await prisma.pairingSession.update({
        where: { id: session.id },
        data: { joinerConfirmedAt: now(), mode: session.mode ?? mode },
      })
    } else {
      throw httpError(403, 'Device is not part of this pairing session.')
    }

    const result = await completePairingIfReady(session.id)
    return send(response, 200, {
      completed: result.completed,
      syncGroupId: result.syncGroupId,
      mode,
    })
  }

  if (request.method === 'POST' && url.pathname === '/devices/token') {
    const body = await readJson(request)
    const deviceId = requiredString(body, 'deviceId')
    const device = await prisma.device.findUnique({ where: { id: deviceId } })
    if (!device || !device.syncGroupId || device.revokedAt) throw httpError(403, 'Device is not paired.')
    if (!verifyDeviceProof({ device, timestamp: body.timestamp, signature: body.signature })) {
      throw httpError(401, 'Invalid device proof.')
    }

    return send(response, 200, await issueDeviceToken(deviceId))
  }

  if (request.method === 'POST' && url.pathname === '/sync/events') {
    const device = await authenticate(request)
    const body = await readJson(request)
    const events = Array.isArray(body.events) ? body.events : null
    if (!events) throw httpError(400, 'events must be an array.')

    const highestAcceptedSequence = await prisma.$transaction(async (tx) => {
      let highest = 0

      for (const event of events) {
        const eventId = requiredString(event, 'eventId')
        const sourceDeviceId = requiredString(event, 'sourceDeviceId')
        if (sourceDeviceId !== device.id) throw httpError(403, 'sourceDeviceId must match the authenticated device.')

        const sequence = Number(event.sequence)
        if (!Number.isInteger(sequence) || sequence <= 0) throw httpError(400, 'sequence must be a positive integer.')

        const existingById = await tx.syncEvent.findUnique({
          where: { eventId },
          select: { sequence: true },
        })
        if (existingById) {
          highest = Math.max(highest, existingById.sequence)
          continue
        }

        const existingBySequence = await tx.syncEvent.findUnique({
          where: { sourceDeviceId_sequence: { sourceDeviceId: device.id, sequence } },
          select: { eventId: true },
        })
        if (existingBySequence) throw httpError(409, 'A different event already exists for this device sequence.')

        await tx.syncEvent.create({
          data: {
            eventId,
            syncGroupId: device.syncGroupId,
            sourceDeviceId: device.id,
            sequence,
            entityType: requiredString(event, 'entityType'),
            entityId: requiredString(event, 'entityId'),
            eventType: requiredString(event, 'eventType'),
            payloadJson: event.payload ?? {},
            createdAt: optionalString(event, 'createdAt') ? new Date(event.createdAt) : now(),
          },
        })
        highest = Math.max(highest, sequence)
      }

      return highest
    })

    return send(response, 200, { accepted: events.length, highestAcceptedSequence })
  }

  if (request.method === 'GET' && url.pathname === '/sync/events') {
    const device = await authenticate(request)
    const after = Number(url.searchParams.get('after') ?? 0)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100), 1), 1000)
    const includeSelf = url.searchParams.get('includeSelf') === 'true'

    const rows = await prisma.syncEvent.findMany({
      where: {
        syncGroupId: device.syncGroupId,
        id: { gt: Number.isFinite(after) ? after : 0 },
        ...(includeSelf ? {} : { sourceDeviceId: { not: device.id } }),
      },
      orderBy: { id: 'asc' },
      take: limit,
    })

    return send(response, 200, {
      events: rows.map((row) => ({
        hostEventId: row.id,
        eventId: row.eventId,
        sourceDeviceId: row.sourceDeviceId,
        sequence: row.sequence,
        entityType: row.entityType,
        entityId: row.entityId,
        eventType: row.eventType,
        payload: row.payloadJson,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length ? rows[rows.length - 1].id : after,
    })
  }

  if (request.method === 'POST' && url.pathname === '/sync/ack') {
    const device = await authenticate(request)
    const body = await readJson(request)
    const lastEventId = Number(body.lastEventId)
    if (!Number.isInteger(lastEventId) || lastEventId < 0) {
      throw httpError(400, 'lastEventId must be a non-negative integer.')
    }

    const existing = await prisma.deviceCursor.findUnique({
      where: { syncGroupId_deviceId: { syncGroupId: device.syncGroupId, deviceId: device.id } },
    })
    await prisma.deviceCursor.upsert({
      where: { syncGroupId_deviceId: { syncGroupId: device.syncGroupId, deviceId: device.id } },
      create: { syncGroupId: device.syncGroupId, deviceId: device.id, lastEventId },
      update: { lastEventId: Math.max(existing?.lastEventId ?? 0, lastEventId) },
    })

    return send(response, 200, { ok: true })
  }

  if (request.method === 'POST' && url.pathname === '/media') {
    const device = await authenticate(request)
    const body = await readJson(request, config.maxBlobBytes)
    const sha256 = sanitizeSha256(requiredString(body, 'sha256'))
    const mimeType = requiredString(body, 'mimeType')
    const dataBase64 = requiredString(body, 'dataBase64')
    const data = Buffer.from(dataBase64, 'base64')

    if (createHash('sha256').update(data).digest('hex') !== sha256) {
      throw httpError(400, 'Uploaded media does not match its sha256.')
    }

    fs.writeFileSync(mediaBlobPath(sha256), data)
    await prisma.mediaObject.upsert({
      where: { syncGroupId_sha256: { syncGroupId: device.syncGroupId, sha256 } },
      create: {
        syncGroupId: device.syncGroupId,
        sha256,
        byteSize: data.length,
        mimeType,
        storageKey: sha256,
      },
      update: { byteSize: data.length, mimeType, storageKey: sha256 },
    })

    return send(response, 200, { sha256, byteSize: data.length })
  }

  if (request.method === 'GET' && url.pathname.startsWith('/media/')) {
    const device = await authenticate(request)
    const sha256 = sanitizeSha256(decodeURIComponent(url.pathname.slice('/media/'.length)))
    const object = await prisma.mediaObject.findUnique({
      where: { syncGroupId_sha256: { syncGroupId: device.syncGroupId, sha256 } },
    })
    const blobPath = mediaBlobPath(sha256)
    if (!object || !fs.existsSync(blobPath)) throw httpError(404, 'Media not found.')

    return send(response, 200, {
      sha256,
      mimeType: object.mimeType,
      dataBase64: fs.readFileSync(blobPath).toString('base64'),
    })
  }

  if (request.method === 'POST' && url.pathname === '/sync/snapshot') {
    const device = await authenticate(request)
    const body = await readJson(request, config.maxBlobBytes)
    const snapshot = body.snapshot
    if (!snapshot || typeof snapshot !== 'object') throw httpError(400, 'snapshot object is required.')

    await prisma.syncSnapshot.upsert({
      where: { syncGroupId: device.syncGroupId },
      create: {
        syncGroupId: device.syncGroupId,
        sourceDeviceId: device.id,
        payloadJson: snapshot,
      },
      update: { sourceDeviceId: device.id, payloadJson: snapshot },
    })

    return send(response, 200, { ok: true })
  }

  if (request.method === 'GET' && url.pathname === '/sync/snapshot') {
    const device = await authenticate(request)
    const snapshot = await prisma.syncSnapshot.findUnique({
      where: { syncGroupId: device.syncGroupId },
    })

    // A device never consumes its own snapshot.
    if (!snapshot || snapshot.sourceDeviceId === device.id) {
      return send(response, 200, { snapshot: null, sourceDeviceId: null })
    }

    return send(response, 200, {
      snapshot: snapshot.payloadJson,
      sourceDeviceId: snapshot.sourceDeviceId,
    })
  }

  if (request.method === 'POST' && url.pathname === '/sync/snapshot/ack') {
    const device = await authenticate(request)
    const snapshot = await prisma.syncSnapshot.findUnique({
      where: { syncGroupId: device.syncGroupId },
    })

    // Only a non-source device confirming receipt clears the snapshot + its media.
    if (snapshot && snapshot.sourceDeviceId !== device.id) {
      const media = Array.isArray(snapshot.payloadJson?.media) ? snapshot.payloadJson.media : []
      const hashes = [...new Set(media.map((item) => item?.sha256).filter((value) => typeof value === 'string'))]

      await prisma.$transaction([
        prisma.syncSnapshot.delete({ where: { syncGroupId: device.syncGroupId } }),
        ...(hashes.length
          ? [
              prisma.mediaObject.deleteMany({
                where: { syncGroupId: device.syncGroupId, sha256: { in: hashes } },
              }),
            ]
          : []),
      ])

      for (const sha256 of hashes) {
        try {
          fs.rmSync(mediaBlobPath(sha256), { force: true })
        } catch {
          // Best-effort blob cleanup; the DB row is already gone.
        }
      }
    }

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

const shutdown = async () => {
  server.close(async () => {
    await prisma.$disconnect()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

server.listen(config.port, config.host, () => {
  console.log(`oNami host listening on http://${config.host}:${config.port}`)
})
