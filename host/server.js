import http from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual, verify as verifySignature } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { PrismaClient } from '@prisma/client'

import {
  BLOB_GRACE,
  isBlobCollectable,
  normalizeSha256,
  parseContentRange,
  planBlobCheck,
  resolveBlobPatch,
} from './blobs.js'
import {
  dedupeRecordBatch,
  nextCursorFrom,
  resolveRecordConflict,
  validateRecordEnvelope,
} from '../src/shared/sync/records.js'
import { parseByteRange, resolveAndroidDownload } from './downloads.js'
import { loadEnvFile } from './env.js'
import { sweepBlobs } from './gc.js'
import { selectPairingSnapshotDirection } from './pairing.js'
import {
  canDeviceReceiveSnapshot,
  decodeSyncSnapshot,
  encodeSyncSnapshot,
  listAvailableSnapshotMedia,
} from './syncSnapshots.js'
import {
  GLOBAL_DECK_LIMITS,
  globalDeckResponse,
  normalizeGlobalDeckPublish,
  normalizeGlobalDeckSearch,
} from './globalDecks.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

loadEnvFile(path.join(__dirname, '.env'))

const config = {
  port: Number(process.env.ONAMI_HOST_PORT ?? process.env.PORT ?? 41730),
  host: process.env.ONAMI_HOST_BIND ?? '127.0.0.1',
  corsOrigin: process.env.ONAMI_HOST_CORS_ORIGIN ?? '*',
  pairingTtlMs: Number(process.env.ONAMI_PAIRING_TTL_MS ?? 10 * 60 * 1000),
  tokenTtlMs: Number(process.env.ONAMI_DEVICE_TOKEN_TTL_MS ?? 7 * 24 * 60 * 60 * 1000),
  maxJsonBytes: Number(process.env.ONAMI_MAX_JSON_BYTES ?? 1024 * 1024),
  maxGlobalDeckJsonBytes: Number(process.env.ONAMI_MAX_GLOBAL_DECK_JSON_BYTES ?? 8 * 1024 * 1024),
  // A record push carries card HTML, so it needs more headroom than a plain
  // control-plane call but far less than a media blob.
  maxRecordsJsonBytes: Number(process.env.ONAMI_MAX_RECORDS_JSON_BYTES ?? 16 * 1024 * 1024),
  // Full-data snapshots and single media blobs are much larger than incremental events.
  maxBlobBytes: Number(process.env.ONAMI_MAX_BLOB_BYTES ?? 64 * 1024 * 1024),
  // One resumable upload chunk. Large enough to be efficient, small enough that
  // a dropped connection costs little work.
  maxChunkBytes: Number(process.env.ONAMI_MAX_BLOB_CHUNK_BYTES ?? 16 * 1024 * 1024),
  blobSweepIntervalMs: Number(process.env.ONAMI_BLOB_SWEEP_INTERVAL_MS ?? 60 * 60 * 1000),
  // Off by default so the first reclaim on an existing host is a deliberate,
  // reviewed run of gc.js rather than a surprise at startup.
  blobSweepEnabled: process.env.ONAMI_BLOB_SWEEP_ENABLED === '1',
  logRequests: process.env.ONAMI_LOG_REQUESTS !== '0',
  mediaDir: process.env.ONAMI_MEDIA_DIR ?? path.join(__dirname, 'media-store'),
  androidReleaseDir: process.env.ONAMI_ANDROID_RELEASE_DIR ?? path.join(__dirname, '..', 'release', 'android'),
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Run host/setup.bat or create host/.env.')
  process.exit(1)
}

fs.mkdirSync(config.mediaDir, { recursive: true })

const sanitizeSha256 = (value) => {
  const normalized = normalizeSha256(value)
  if (!normalized) throw httpError(400, 'sha256 must be a 64-character hex string.')
  return normalized
}

const mediaBlobPath = (sha256) => path.join(config.mediaDir, sanitizeSha256(sha256))

/** Where a resumable upload accumulates before its hash is verified. */
const blobPartPath = (sha256) => `${mediaBlobPath(sha256)}.part`

const prisma = new PrismaClient()

const hashFile = (filePath) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })

/**
 * Streams a request body onto the end of a file. On any failure the file is
 * truncated back to where it started, so a half-written chunk never becomes a
 * phantom offset the client would then skip past.
 */
const appendRequestBody = async (request, filePath, expectedLength) => {
  const startSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
  let written = 0

  try {
    await new Promise((resolve, reject) => {
      const target = fs.createWriteStream(filePath, { flags: 'a' })
      request.on('data', (chunk) => {
        written += chunk.length
        if (written > expectedLength) {
          request.destroy()
          reject(httpError(400, 'The request body is longer than its Content-Range declares.'))
        }
      })
      pipeline(request, target, (error) => (error ? reject(error) : resolve()))
    })
  } catch (error) {
    fs.truncateSync(filePath, startSize)
    throw error
  }

  if (written !== expectedLength) {
    fs.truncateSync(filePath, startSize)
    throw httpError(400, 'The request body is shorter than its Content-Range declares.')
  }

  return written
}

/**
 * Serializes work per blob hash. The host runs as a single PM2 fork, so an
 * in-process lock is enough to stop two concurrent chunks for the same file
 * from interleaving their appends.
 */
const blobLocks = new Map()

const withBlobLock = async (sha256, run) => {
  const previous = blobLocks.get(sha256) ?? Promise.resolve()
  const current = previous.then(run, run)
  blobLocks.set(
    sha256,
    current.then(
      () => {
        if (blobLocks.get(sha256) === current) blobLocks.delete(sha256)
      },
      () => {
        if (blobLocks.get(sha256) === current) blobLocks.delete(sha256)
      }
    )
  )
  return current
}

/**
 * Reconciles a `blobs` row against what is actually on disk. Files written by
 * the legacy `POST /media` route have no row at all, so disk presence — not the
 * database — decides whether a blob is complete.
 */
const reconcileBlobState = (sha256, row) => {
  const finalPath = mediaBlobPath(sha256)
  if (fs.existsSync(finalPath)) {
    const byteSize = fs.statSync(finalPath).size
    return {
      sha256,
      byteSize: row?.byteSize ?? byteSize,
      receivedBytes: byteSize,
      mimeType: row?.mimeType ?? 'application/octet-stream',
      complete: true,
    }
  }

  const partPath = blobPartPath(sha256)
  const receivedBytes = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0
  if (!row && receivedBytes === 0) return null

  return {
    sha256,
    byteSize: row?.byteSize ?? 0,
    receivedBytes,
    mimeType: row?.mimeType ?? 'application/octet-stream',
    complete: false,
  }
}

const loadBlobState = async (sha256) =>
  reconcileBlobState(sha256, await prisma.blob.findUnique({ where: { sha256 } }))

/** Records that something still needs this blob. Idempotent. */
const addBlobRef = (sha256, scopeKind, scopeId) =>
  prisma.blobRef.upsert({
    where: { sha256_scopeKind_scopeId: { sha256, scopeKind, scopeId } },
    update: {},
    create: { sha256, scopeKind, scopeId },
  })

const now = () => new Date()
const nowIso = () => new Date().toISOString()
const expiresAt = (ttlMs) => new Date(Date.now() + ttlMs)
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const tokenHash = (token) => sha256(`token:${token}`)
const codeHash = (code) => sha256(`pairing:${normalizePairingCode(code)}`)

const shouldLogRoute = (pathname) =>
  config.logRequests &&
  (pathname.startsWith('/sync/') ||
    pathname.startsWith('/pairing/') ||
    pathname.startsWith('/devices/') ||
    pathname.startsWith('/media') ||
    pathname.startsWith('/blob') ||
    pathname.startsWith('/global-decks'))

const createRequestContext = (request) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  return {
    requestId: randomUUID(),
    method: request.method,
    path: url.pathname,
    startedAt: Date.now(),
    fields: {},
    shouldLog: shouldLogRoute(url.pathname),
  }
}

const addLogFields = (context, fields) => {
  Object.assign(context.fields, fields)
}

const logRequest = (context, level, event, fields = {}) => {
  if (!context.shouldLog) return
  const entry = {
    time: nowIso(),
    level,
    event,
    requestId: context.requestId,
    method: context.method,
    path: context.path,
    durationMs: Date.now() - context.startedAt,
    ...context.fields,
    ...fields,
  }
  const line = JSON.stringify(entry)
  if (level === 'error') console.error(line)
  else console.log(line)
}

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const requiredUuid = (body, key) => {
  const value = requiredString(body, key)
  if (!UUID_PATTERN.test(value)) throw httpError(400, `${key} must be a UUID.`)
  return value
}

const optionalDate = (body, key) => {
  const value = optionalString(body, key)
  if (!value) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw httpError(400, `${key} must be a valid timestamp.`)
  return date
}

/** Bounds one push so a huge library arrives as pages, each of which resumes. */
const MAX_RECORDS_PER_PUSH = 500

const allowedEntityTypes = new Set(['deck', 'card', 'review'])
const allowedEventTypes = new Set(['deck.upsert', 'deck.delete', 'card.upsert', 'card.delete', 'review.answer'])

const requiredKnownString = (body, key, allowed) => {
  const value = requiredString(body, key)
  if (!allowed.has(value)) throw httpError(400, `${key} is not supported.`)
  return value
}

const optionalObject = (body, key) => {
  const value = body?.[key]
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw httpError(400, `${key} must be an object.`)
  return value
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

const getPairingSessionByCode = async (code, options = {}) => {
  const session = await prisma.pairingSession.findUnique({
    where: { codeHash: codeHash(code) },
  })
  if (!session) throw httpError(404, 'Pairing code not found.')
  if (session.completedAt && !options.allowCompleted) throw httpError(409, 'Pairing code has already been used.')
  if (session.expiresAt.getTime() <= Date.now()) throw httpError(410, 'Pairing code has expired.')
  return session
}

const completePairingIfReady = async (sessionId) => {
  return prisma.$transaction(async (tx) => {
    const session = await tx.pairingSession.findUnique({ where: { id: sessionId } })
    if (!session) {
      return {
        completed: false,
        syncGroupId: null,
        mode: 'merge',
        snapshotSourceDeviceId: null,
        snapshotTargetDeviceId: null,
      }
    }

    const [initiator, joiner] = await Promise.all([
      tx.device.findUnique({ where: { id: session.initiatorDeviceId } }),
      session.joiningDeviceId ? tx.device.findUnique({ where: { id: session.joiningDeviceId } }) : null,
    ])
    const mode = session.mode ?? 'merge'
    const direction = selectPairingSnapshotDirection({ mode, initiator, joiner })
    const result = (completed, syncGroupId) => ({ completed, syncGroupId, mode, ...direction })

    if (session.completedAt) {
      return result(true, initiator?.syncGroupId ?? joiner?.syncGroupId ?? null)
    }

    if (!session.initiatorConfirmedAt || !session.joinerConfirmedAt) {
      return result(false, null)
    }

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

    return result(true, syncGroupId)
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

const corsHeaders = {
  'access-control-allow-origin': config.corsOrigin,
  'access-control-allow-methods': 'GET,HEAD,POST,PATCH,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,content-range,upload-offset',
  // The Android build runs in a WebView, so resumable uploads only work if the
  // page is allowed to read the offset headers back off the response.
  'access-control-expose-headers': 'upload-offset,upload-complete,content-range,accept-ranges',
}

const send = (response, status, body) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...corsHeaders,
  })
  response.end(JSON.stringify(body))
}

/** Streams stored blob bytes, honouring `Range` so downloads resume too. */
const sendBlobBytes = (request, response, filePath, mimeType, sha256) => {
  const stat = fs.statSync(filePath)
  const range = parseByteRange(request.headers.range, stat.size)
  const baseHeaders = {
    'content-type': mimeType || 'application/octet-stream',
    'accept-ranges': 'bytes',
    // Content-addressed bytes can never change, so they are safe to cache hard.
    'cache-control': 'public, max-age=31536000, immutable',
    etag: `"sha256-${sha256}"`,
    'x-content-type-options': 'nosniff',
    ...corsHeaders,
  }

  if (range?.invalid) {
    response.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${stat.size}`, 'content-length': 0 })
    return response.end()
  }

  const start = range?.start ?? 0
  const end = range?.end ?? stat.size - 1
  response.writeHead(range ? 206 : 200, {
    ...baseHeaders,
    'content-length': Math.max(end - start + 1, 0),
    ...(range ? { 'content-range': `bytes ${start}-${end}/${stat.size}` } : {}),
  })
  if (request.method === 'HEAD') return response.end()

  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, range ? { start, end } : undefined)
    pipeline(stream, response, (error) => {
      if (error && !response.destroyed) response.destroy(error)
      resolve()
    })
  })
}

const sendDownload = (request, response, filePath, contentType, downloadName, etag = null) => {
  if (!fs.existsSync(filePath)) {
    return send(response, 404, { error: 'The Android build is not available yet.' })
  }

  const stat = fs.statSync(filePath)
  const range = parseByteRange(request.headers.range, stat.size)
  const baseHeaders = {
    'content-type': contentType,
    'content-disposition': `attachment; filename="${downloadName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    'cache-control': 'private, no-store, no-cache, must-revalidate, max-age=0',
    pragma: 'no-cache',
    expires: '0',
    'accept-ranges': 'bytes',
    'last-modified': stat.mtime.toUTCString(),
    'x-content-type-options': 'nosniff',
    connection: 'close',
    'access-control-allow-origin': config.corsOrigin,
    ...(etag ? { etag } : {}),
  }

  response.shouldKeepAlive = false
  if (range?.invalid) {
    response.writeHead(416, {
      ...baseHeaders,
      'content-range': `bytes */${stat.size}`,
      'content-length': 0,
    })
    return response.end()
  }

  const start = range?.start ?? 0
  const end = range?.end ?? stat.size - 1
  const contentLength = Math.max(end - start + 1, 0)
  response.writeHead(range ? 206 : 200, {
    ...baseHeaders,
    'content-length': contentLength,
    ...(range ? { 'content-range': `bytes ${start}-${end}/${stat.size}` } : {}),
  })
  if (request.method === 'HEAD') return response.end()

  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, range ? { start, end } : undefined)
    pipeline(stream, response, (error) => {
      if (error && !response.destroyed) response.destroy(error)
      resolve()
    })
  })
}

const route = async (request, response, context) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  logRequest(context, 'info', 'request.start')

  if (request.method === 'OPTIONS') return send(response, 204, {})
  if (request.method === 'GET' && url.pathname === '/health') {
    await prisma.$queryRaw`SELECT 1`
    return send(response, 200, { ok: true, service: 'onami-host', time: nowIso() })
  }
  const androidDownload = resolveAndroidDownload(url.pathname, config.androidReleaseDir)
  if ((request.method === 'GET' || request.method === 'HEAD') && androidDownload) {
    if (androidDownload.stale) {
      return send(response, 410, {
        error: 'That Android build has been replaced.',
        currentDownloadUrl: androidDownload.currentVersion
          ? `/downloads/onami-${androidDownload.currentVersion}.apk?v=${androidDownload.currentVersion}`
          : '/downloads/onami-latest.apk',
      })
    }
    return sendDownload(
      request,
      response,
      androidDownload.filePath,
      'application/vnd.android.package-archive',
      androidDownload.downloadName,
      androidDownload.etag,
    )
  }
  if (request.method === 'GET' && url.pathname === '/downloads/android.json') {
    return sendDownload(
      request,
      response,
      path.join(config.androidReleaseDir, 'android.json'),
      'application/json; charset=utf-8',
      'oNami-android.json',
    )
  }

  if (request.method === 'GET' && url.pathname === '/global-decks') {
    const search = normalizeGlobalDeckSearch(url.searchParams.get('search'))
    const installationId = normalizeGlobalDeckSearch(url.searchParams.get('installationId'))
    const decks = await prisma.globalDeck.findMany({
      where: search ? { name: { contains: search, mode: 'insensitive' } } : undefined,
      include: {
        ...(installationId
          ? { hearts: { where: { installationId }, select: { installationId: true } } }
          : {}),
        _count: { select: { hearts: true } },
      },
      orderBy: [{ hearts: { _count: 'desc' } }, { updatedAt: 'desc' }],
      take: 100,
    })
    return send(response, 200, { decks: decks.map((deck) => globalDeckResponse(deck)) })
  }

  if (request.method === 'POST' && url.pathname === '/global-decks/media/check') {
    const body = await readJson(request)
    if (!Array.isArray(body.media)) throw httpError(400, 'media must be an array.')
    if (body.media.length > GLOBAL_DECK_LIMITS.maxMedia) throw httpError(400, 'Too many media files.')
    const hashes = [...new Set(body.media.map((item) => sanitizeSha256(item?.sha256)))]
    const missingSha256 = hashes.filter((hash) => !fs.existsSync(mediaBlobPath(hash)))
    return send(response, 200, { missingSha256 })
  }

  const globalMediaMatch = url.pathname.match(/^\/global-decks\/media\/([a-f0-9]{64})$/i)
  if (request.method === 'POST' && globalMediaMatch) {
    const sha256 = sanitizeSha256(globalMediaMatch[1])
    const body = await readJson(request, config.maxBlobBytes)
    const mimeType = requiredString(body, 'mimeType')
    const dataBase64 = requiredString(body, 'dataBase64')
    const data = Buffer.from(dataBase64, 'base64')
    if (data.length <= 0 || data.length > GLOBAL_DECK_LIMITS.maxMediaBytes) {
      throw httpError(413, 'Global deck media is too large.')
    }
    if (createHash('sha256').update(data).digest('hex') !== sha256) {
      throw httpError(400, 'Uploaded global deck media does not match its sha256.')
    }
    const blobPath = mediaBlobPath(sha256)
    const reused = fs.existsSync(blobPath)
    if (!reused) fs.writeFileSync(blobPath, data)
    return send(response, 200, { sha256, byteSize: data.length, mimeType, reused })
  }

  if (request.method === 'GET' && globalMediaMatch) {
    const sha256 = sanitizeSha256(globalMediaMatch[1])
    const media = await prisma.globalDeckMedia.findFirst({ where: { sha256 } })
    const blobPath = mediaBlobPath(sha256)
    if (!media || !fs.existsSync(blobPath)) throw httpError(404, 'Global deck media not found.')
    return send(response, 200, {
      sha256,
      mimeType: media.mimeType,
      dataBase64: fs.readFileSync(blobPath).toString('base64'),
    })
  }

  const globalDeckHeartMatch = url.pathname.match(/^\/global-decks\/([0-9a-f-]+)\/heart$/i)
  if (request.method === 'POST' && globalDeckHeartMatch) {
    const deckId = globalDeckHeartMatch[1]
    if (!UUID_PATTERN.test(deckId)) throw httpError(400, 'Global deck id must be a UUID.')
    const body = await readJson(request)
    const installationId = requiredString(body, 'installationId')
    if (installationId.length > 200) throw httpError(400, 'installationId is too long.')
    if (typeof body.hearted !== 'boolean') throw httpError(400, 'hearted must be a boolean.')

    const result = await prisma.$transaction(async (tx) => {
      const deck = await tx.globalDeck.findUnique({ where: { id: deckId }, select: { id: true } })
      if (!deck) throw httpError(404, 'Global deck not found.')
      if (body.hearted) {
        await tx.globalDeckHeart.upsert({
          where: { deckId_installationId: { deckId, installationId } },
          update: {},
          create: { deckId, installationId },
        })
      } else {
        await tx.globalDeckHeart.deleteMany({ where: { deckId, installationId } })
      }
      return tx.globalDeckHeart.count({ where: { deckId } })
    })
    return send(response, 200, {
      id: deckId,
      heartCount: result,
      hearted: body.hearted,
      viewerHearted: body.hearted,
    })
  }

  const globalDeckMatch = url.pathname.match(/^\/global-decks\/([0-9a-f-]+)$/i)
  if (request.method === 'GET' && globalDeckMatch) {
    const deckId = globalDeckMatch[1]
    if (!UUID_PATTERN.test(deckId)) throw httpError(400, 'Global deck id must be a UUID.')
    const installationId = normalizeGlobalDeckSearch(url.searchParams.get('installationId'))
    const deck = await prisma.globalDeck.findUnique({
      where: { id: deckId },
      include: {
        ...(installationId
          ? { hearts: { where: { installationId }, select: { installationId: true } } }
          : {}),
        _count: { select: { hearts: true } },
        media: true,
      },
    })
    if (!deck) throw httpError(404, 'Global deck not found.')
    return send(response, 200, { deck: globalDeckResponse(deck, true) })
  }

  if (request.method === 'POST' && url.pathname === '/global-decks') {
    const input = normalizeGlobalDeckPublish(await readJson(request, config.maxGlobalDeckJsonBytes))
    for (const media of input.media) {
      const blobPath = mediaBlobPath(media.sha256)
      if (!fs.existsSync(blobPath) || fs.statSync(blobPath).size !== media.byteSize) {
        throw httpError(409, `Media ${media.originalName} must be uploaded before publishing.`)
      }
    }
    const deck = await prisma.$transaction(async (tx) => {
      const saved = await tx.globalDeck.upsert({
        where: {
          publisherId_sourceDeckId: {
            publisherId: input.publisherId,
            sourceDeckId: input.sourceDeckId,
          },
        },
        update: {
          name: input.name,
          cardsJson: { decks: input.decks },
          cardCount: input.cardCount,
          publishedAt: now(),
        },
        create: {
          publisherId: input.publisherId,
          sourceDeckId: input.sourceDeckId,
          name: input.name,
          cardsJson: { decks: input.decks },
          cardCount: input.cardCount,
        },
      })
      await tx.globalDeckMedia.deleteMany({ where: { deckId: saved.id } })
      if (input.media.length > 0) {
        await tx.globalDeckMedia.createMany({
          data: input.media.map((media) => ({ deckId: saved.id, ...media })),
        })
      }
      return tx.globalDeck.findUniqueOrThrow({
        where: { id: saved.id },
        include: {
          hearts: { where: { installationId: input.publisherId }, select: { installationId: true } },
          _count: { select: { hearts: true } },
          media: true,
        },
      })
    })

    // Re-point this deck's blob references at exactly the media it publishes
    // now, so media dropped by a re-publish becomes collectable.
    await prisma.blobRef.deleteMany({ where: { scopeKind: 'published-deck', scopeId: deck.id } })
    for (const media of input.media) {
      await prisma.blob.upsert({
        where: { sha256: media.sha256 },
        create: {
          sha256: media.sha256,
          byteSize: media.byteSize,
          receivedBytes: media.byteSize,
          mimeType: media.mimeType,
          complete: true,
        },
        update: {},
      })
      await addBlobRef(media.sha256, 'published-deck', deck.id)
    }

    return send(response, 200, { deck: globalDeckResponse(deck, true) })
  }

  if (request.method === 'POST' && url.pathname === '/devices/bootstrap') {
    const body = await readJson(request)
    const device = await upsertDevice({
      deviceId: optionalString(body, 'deviceId') ?? randomUUID(),
      name: requiredString(body, 'name'),
      platform: requiredString(body, 'platform'),
      publicKey: requiredString(body, 'publicKey'),
    })
    addLogFields(context, { deviceId: device.id, syncGroupId: device.syncGroupId ?? null })
    logRequest(context, 'info', 'devices.bootstrap', {
      paired: Boolean(device.syncGroupId && !device.revokedAt),
      platform: device.platform,
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
    addLogFields(context, { deviceId: device.id, syncGroupId: device.syncGroupId ?? null })
    logRequest(context, 'info', 'pairing.start', {
      expiresInMs: config.pairingTtlMs,
      platform: device.platform,
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
    addLogFields(context, { deviceId: device.id, syncGroupId: device.syncGroupId ?? null })
    logRequest(context, 'info', 'pairing.join', {
      initiatorDeviceId: session.initiatorDeviceId,
      joiningDeviceId: device.id,
      platform: device.platform,
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
    const session = await getPairingSessionByCode(requiredString(body, 'pairingCode'), { allowCompleted: true })
    const mode = optionalString(body, 'mode') ?? 'merge'
    if (!['merge', 'copy-desktop-to-phone', 'copy-phone-to-desktop'].includes(mode)) {
      throw httpError(400, 'mode must be merge, copy-desktop-to-phone, or copy-phone-to-desktop.')
    }

    if (deviceId !== session.initiatorDeviceId && deviceId !== session.joiningDeviceId) {
      throw httpError(403, 'Device is not part of this pairing session.')
    }

    if (session.completedAt) {
      const result = await completePairingIfReady(session.id)
      addLogFields(context, { deviceId, syncGroupId: result.syncGroupId })
      logRequest(context, 'info', 'pairing.confirm', {
        completed: result.completed,
        alreadyCompleted: true,
        mode: result.mode,
        initiatorDeviceId: session.initiatorDeviceId,
        joiningDeviceId: session.joiningDeviceId,
        snapshotSourceDeviceId: result.snapshotSourceDeviceId,
        snapshotTargetDeviceId: result.snapshotTargetDeviceId,
      })
      return send(response, 200, result)
    }

    if (deviceId === session.initiatorDeviceId) {
      await prisma.pairingSession.update({
        where: { id: session.id },
        // The starter chooses the transfer direction. A joiner may confirm
        // first, but must not accidentally lock the session to its default.
        data: { initiatorConfirmedAt: now(), mode },
      })
    } else if (deviceId === session.joiningDeviceId) {
      await prisma.pairingSession.update({
        where: { id: session.id },
        data: { joinerConfirmedAt: now() },
      })
    }

    const result = await completePairingIfReady(session.id)
    addLogFields(context, { deviceId, syncGroupId: result.syncGroupId })
    logRequest(context, 'info', 'pairing.confirm', {
      completed: result.completed,
      mode: result.mode,
      initiatorDeviceId: session.initiatorDeviceId,
      joiningDeviceId: session.joiningDeviceId,
      snapshotSourceDeviceId: result.snapshotSourceDeviceId,
      snapshotTargetDeviceId: result.snapshotTargetDeviceId,
    })
    return send(response, 200, result)
  }

  if (request.method === 'POST' && url.pathname === '/devices/token') {
    const body = await readJson(request)
    const deviceId = requiredString(body, 'deviceId')
    const device = await prisma.device.findUnique({ where: { id: deviceId } })
    if (!device || !device.syncGroupId || device.revokedAt) throw httpError(403, 'Device is not paired.')
    if (!verifyDeviceProof({ device, timestamp: body.timestamp, signature: body.signature })) {
      throw httpError(401, 'Invalid device proof.')
    }

    addLogFields(context, { deviceId: device.id, syncGroupId: device.syncGroupId })
    logRequest(context, 'info', 'devices.token', { tokenTtlMs: config.tokenTtlMs })
    return send(response, 200, await issueDeviceToken(deviceId))
  }

  if (request.method === 'POST' && url.pathname === '/sync/events') {
    const device = await authenticate(request)
    addLogFields(context, { deviceId: device.id, syncGroupId: device.syncGroupId })
    const body = await readJson(request)
    const events = Array.isArray(body.events) ? body.events : null
    if (!events) throw httpError(400, 'events must be an array.')

    const highestAcceptedSequence = await prisma.$transaction(async (tx) => {
      let highest = 0

      for (const event of events) {
        const eventId = requiredUuid(event, 'eventId')
        const sourceDeviceId = requiredUuid(event, 'sourceDeviceId')
        if (sourceDeviceId !== device.id) throw httpError(403, 'sourceDeviceId must match the authenticated device.')

        const sequence = Number(event.sequence)
        if (!Number.isInteger(sequence) || sequence <= 0) throw httpError(400, 'sequence must be a positive integer.')
        const createdAt = optionalDate(event, 'createdAt') ?? now()

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
            entityType: requiredKnownString(event, 'entityType', allowedEntityTypes),
            entityId: requiredString(event, 'entityId'),
            eventType: requiredKnownString(event, 'eventType', allowedEventTypes),
            payloadJson: optionalObject(event, 'payload'),
            createdAt,
          },
        })
        highest = Math.max(highest, sequence)
      }

      return highest
    })

    logRequest(context, 'info', 'sync.events.push', {
      accepted: events.length,
      highestAcceptedSequence,
    })
    return send(response, 200, { accepted: events.length, highestAcceptedSequence })
  }

  if (request.method === 'GET' && url.pathname === '/sync/events') {
    const device = await authenticate(request)
    addLogFields(context, { deviceId: device.id, syncGroupId: device.syncGroupId })
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
    const nextCursor = rows.length ? rows[rows.length - 1].id : after
    logRequest(context, 'info', 'sync.events.pull', {
      after,
      limit,
      includeSelf,
      returned: rows.length,
      nextCursor,
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
      nextCursor,
    })
  }

  if (request.method === 'POST' && url.pathname === '/sync/ack') {
    const device = await authenticate(request)
    addLogFields(context, { deviceId: device.id, syncGroupId: device.syncGroupId })
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

    logRequest(context, 'info', 'sync.ack', { lastEventId })
    return send(response, 200, { ok: true })
  }

  // ---- Records ----
  //
  // One keyed row per deck, card, and media reference. Replaces both the
  // append-only event log and the one-time snapshot handoff: a brand new device
  // pulls from version 0 through the same endpoint an established device uses.

  if (request.method === 'POST' && url.pathname === '/records') {
    const device = await authenticate(request)
    addLogFields(context, { deviceId: device.id, syncGroupId: device.syncGroupId })
    const body = await readJson(request, config.maxRecordsJsonBytes)
    if (!Array.isArray(body.records)) throw httpError(400, 'records must be an array.')
    if (body.records.length > MAX_RECORDS_PER_PUSH) {
      throw httpError(400, `A push may contain at most ${MAX_RECORDS_PER_PUSH} records.`)
    }

    for (const [index, candidate] of body.records.entries()) {
      const problem = validateRecordEnvelope(candidate, index)
      if (problem) throw httpError(400, `records[${problem.index}]: ${problem.reason}`)
    }

    // Collapsed first so one push cannot contain two writes to the same record.
    const incoming = dedupeRecordBatch(body.records)
    let accepted = 0
    let superseded = 0

    for (const record of incoming) {
      const where = {
        syncGroupId_kind_recordId: {
          syncGroupId: device.syncGroupId,
          kind: record.kind,
          recordId: record.recordId,
        },
      }
      const existing = await prisma.syncRecord.findUnique({
        where,
        select: { updatedAt: true, mergeRank: true, deleted: true },
      })

      // The merge rule is enforced here, not only on the client, so a device
      // running an old build cannot overwrite newer study from another device.
      if (
        resolveRecordConflict(
          existing
            ? {
                updatedAt: existing.updatedAt.toISOString(),
                mergeRank: existing.mergeRank,
                deleted: existing.deleted,
              }
            : null,
          record
        ) === 'keep-existing'
      ) {
        superseded += 1
        continue
      }

      const data = {
        updatedAt: new Date(record.updatedAt),
        deleted: record.deleted,
        mergeRank: record.mergeRank,
        payloadJson: record.payload ?? {},
        blobRefs: (record.blobRefs ?? []).map((hash) => hash.toLowerCase()),
      }
      // Replaced rather than updated in place so the row takes a fresh sequence
      // value. Every accepted write must get a higher version than anything
      // already pulled, or a device that synced before this change would never
      // be told about it. Versions must also be unique: if two records shared
      // one, a page boundary landing between them would skip the second
      // forever.
      await prisma.$transaction([
        prisma.syncRecord.deleteMany({
          where: { syncGroupId: device.syncGroupId, kind: record.kind, recordId: record.recordId },
        }),
        prisma.syncRecord.create({
          data: { syncGroupId: device.syncGroupId, kind: record.kind, recordId: record.recordId, ...data },
        }),
      ])
      accepted += 1

      for (const hash of data.blobRefs) {
        await addBlobRef(hash, 'sync-group', device.syncGroupId).catch(() => undefined)
      }
    }

    const highest = await prisma.syncRecord.aggregate({
      where: { syncGroupId: device.syncGroupId },
      _max: { version: true },
    })
    const nextCursor = Number(highest._max.version ?? 0)

    logRequest(context, 'info', 'records.push', {
      received: body.records.length,
      accepted,
      superseded,
      nextCursor,
    })
    return send(response, 200, { accepted, superseded, nextCursor })
  }

  if (request.method === 'GET' && url.pathname === '/records') {
    const device = await authenticate(request)
    addLogFields(context, { deviceId: device.id, syncGroupId: device.syncGroupId })
    const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 500), 1), 1000)

    const rows = await prisma.syncRecord.findMany({
      where: { syncGroupId: device.syncGroupId, version: { gt: since } },
      orderBy: { version: 'asc' },
      take: limit,
    })

    const records = rows.map((row) => ({
      kind: row.kind,
      recordId: row.recordId,
      version: Number(row.version),
      updatedAt: row.updatedAt.toISOString(),
      deleted: row.deleted,
      mergeRank: row.mergeRank,
      payload: row.payloadJson,
      blobRefs: row.blobRefs,
    }))

    logRequest(context, 'info', 'records.pull', { since, limit, returned: records.length })
    return send(response, 200, {
      records,
      nextCursor: nextCursorFrom(records, since),
    })
  }

  if (request.method === 'POST' && url.pathname === '/review-log') {
    const device = await authenticate(request)
    addLogFields(context, { deviceId: device.id, syncGroupId: device.syncGroupId })
    const body = await readJson(request, config.maxRecordsJsonBytes)
    if (!Array.isArray(body.entries)) throw httpError(400, 'entries must be an array.')
    if (body.entries.length > MAX_RECORDS_PER_PUSH) {
      throw httpError(400, `A push may contain at most ${MAX_RECORDS_PER_PUSH} entries.`)
    }

    let accepted = 0
    for (const entry of body.entries) {
      const entryId = requiredString(entry, 'id')
      const cardId = requiredString(entry, 'cardId')
      const reviewedAt = optionalDate(entry, 'reviewedAt')
      if (!reviewedAt) throw httpError(400, 'reviewedAt must be a valid timestamp.')

      // Reviews are immutable, so a re-push of one already stored is a no-op
      // rather than a duplicate. That makes retrying a batch free.
      const result = await prisma.reviewLogEntry.createMany({
        data: [{ syncGroupId: device.syncGroupId, entryId, cardId, reviewedAt, payloadJson: entry }],
        skipDuplicates: true,
      })
      accepted += result.count
    }

    logRequest(context, 'info', 'reviewLog.push', { received: body.entries.length, accepted })
    return send(response, 200, { accepted })
  }

  if (request.method === 'GET' && url.pathname === '/review-log') {
    const device = await authenticate(request)
    addLogFields(context, { deviceId: device.id, syncGroupId: device.syncGroupId })
    const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 500), 1), 2000)

    const rows = await prisma.reviewLogEntry.findMany({
      where: { syncGroupId: device.syncGroupId, version: { gt: since } },
      orderBy: { version: 'asc' },
      take: limit,
    })
    const entries = rows.map((row) => ({ ...row.payloadJson, version: Number(row.version) }))

    logRequest(context, 'info', 'reviewLog.pull', { since, limit, returned: entries.length })
    return send(response, 200, {
      entries,
      nextCursor: entries.reduce((highest, entry) => Math.max(highest, entry.version), since),
    })
  }

  // ---- Content-addressed blob store ----
  //
  // Replaces the base64 `/media` and `/global-decks/media` routes. Uploads
  // resume from a byte offset, downloads honour Range, and storage is reclaimed
  // by reference counting instead of a client acknowledgement.

  if (request.method === 'POST' && url.pathname === '/blobs/check') {
    const device = await authenticate(request)
    addLogFields(context, { deviceId: device.id, syncGroupId: device.syncGroupId })
    const body = await readJson(request)
    if (!Array.isArray(body.sha256)) throw httpError(400, 'sha256 must be an array of hashes.')
    if (body.sha256.length > 5000) throw httpError(400, 'Too many hashes in one check.')

    const hashes = [...new Set(body.sha256.map((value) => sanitizeSha256(value)))]
    const rows = await prisma.blob.findMany({ where: { sha256: { in: hashes } } })
    const rowsByHash = new Map(rows.map((row) => [row.sha256, row]))
    const stored = hashes
      .map((sha256) => reconcileBlobState(sha256, rowsByHash.get(sha256) ?? null))
      .filter((state) => state !== null)

    const plan = planBlobCheck(hashes, stored)
    logRequest(context, 'info', 'blobs.check', {
      requested: hashes.length,
      present: plan.present.length,
      partial: plan.partial.length,
      missing: plan.missing.length,
    })
    return send(response, 200, plan)
  }

  const blobMatch = url.pathname.match(/^\/blob\/([a-f0-9]{64})$/i)

  if (request.method === 'HEAD' && blobMatch) {
    await authenticate(request)
    const sha256 = sanitizeSha256(blobMatch[1])
    const stored = await loadBlobState(sha256)
    if (!stored) {
      response.writeHead(404, { 'upload-offset': '0', 'content-length': 0, ...corsHeaders })
      return response.end()
    }
    response.writeHead(200, {
      'upload-offset': String(stored.receivedBytes),
      'upload-complete': stored.complete ? '?1' : '?0',
      'content-length': 0,
      ...corsHeaders,
    })
    return response.end()
  }

  if (request.method === 'PATCH' && blobMatch) {
    const device = await authenticate(request)
    addLogFields(context, { deviceId: device.id, syncGroupId: device.syncGroupId })
    const sha256 = sanitizeSha256(blobMatch[1])
    const range = parseContentRange(request.headers['content-range'], config)
    if (range.invalid) throw httpError(400, range.message)

    const result = await withBlobLock(sha256, async () => {
      const stored = await loadBlobState(sha256)
      const decision = resolveBlobPatch({ stored, range })

      if (decision.outcome === 'already-complete') {
        // A retry after a lost response. Drain the body and answer success so
        // the client can move on rather than re-uploading the whole file.
        request.resume()
        await addBlobRef(sha256, 'sync-group', device.syncGroupId)
        return { status: 200, sha256, offset: decision.offset, complete: true, reused: true }
      }

      if (decision.outcome !== 'append') {
        request.resume()
        return {
          status: 409,
          sha256,
          offset: decision.offset,
          complete: false,
          error: decision.message,
        }
      }

      await prisma.blob.upsert({
        where: { sha256 },
        create: {
          sha256,
          byteSize: range.total,
          receivedBytes: range.start,
          mimeType: optionalString(request.headers, 'content-type') ?? 'application/octet-stream',
        },
        update: {},
      })

      const partPath = blobPartPath(sha256)
      await appendRequestBody(request, partPath, range.length)
      const receivedBytes = fs.statSync(partPath).size

      if (!decision.completes) {
        await prisma.blob.update({ where: { sha256 }, data: { receivedBytes } })
        return { status: 200, sha256, offset: receivedBytes, complete: false }
      }

      const actualHash = await hashFile(partPath)
      if (actualHash !== sha256) {
        // The assembled bytes are not what was promised. Drop everything so the
        // client restarts this one blob rather than serving corrupt content.
        fs.rmSync(partPath, { force: true })
        await prisma.blob.delete({ where: { sha256 } }).catch(() => undefined)
        throw httpError(400, 'The uploaded bytes do not match the requested sha256.')
      }

      fs.renameSync(partPath, mediaBlobPath(sha256))
      const mimeType = optionalString(request.headers, 'content-type') ?? 'application/octet-stream'
      await prisma.blob.update({
        where: { sha256 },
        data: { receivedBytes, byteSize: receivedBytes, complete: true },
      })
      await addBlobRef(sha256, 'sync-group', device.syncGroupId)

      // Mirror into the legacy table so a device still on the previous build
      // can fetch this file through `GET /media/:sha256`. Without this, an
      // updated desktop and an un-updated phone cannot exchange media.
      await prisma.mediaObject.upsert({
        where: { syncGroupId_sha256: { syncGroupId: device.syncGroupId, sha256 } },
        create: {
          syncGroupId: device.syncGroupId,
          sha256,
          byteSize: receivedBytes,
          mimeType,
          storageKey: sha256,
        },
        update: { byteSize: receivedBytes, mimeType, storageKey: sha256 },
      })

      return { status: 200, sha256, offset: receivedBytes, complete: true }
    })

    logRequest(context, 'info', 'blob.patch', {
      sha256: sha256.slice(0, 12),
      status: result.status,
      offset: result.offset,
      complete: result.complete,
      chunkBytes: range.length,
    })
    const { status, ...payload } = result
    return send(response, status, payload)
  }

  if (request.method === 'GET' && blobMatch) {
    const sha256 = sanitizeSha256(blobMatch[1])
    const stored = await loadBlobState(sha256)
    if (!stored?.complete) throw httpError(404, 'Blob not found.')

    // Published deck media is public; anything else needs a paired device. A
    // hash is unguessable, but sync media should not become fetchable just
    // because someone learned its digest.
    const publiclyReadable = await prisma.blobRef.findFirst({
      where: { sha256, scopeKind: 'published-deck' },
      select: { sha256: true },
    })
    if (!publiclyReadable) await authenticate(request)

    logRequest(context, 'info', 'blob.get', {
      sha256: sha256.slice(0, 12),
      byteSize: stored.byteSize,
      ranged: Boolean(request.headers.range),
    })
    return sendBlobBytes(request, response, mediaBlobPath(sha256), stored.mimeType, sha256)
  }

  if (request.method === 'POST' && url.pathname === '/media') {
    const device = await authenticate(request)
    addLogFields(context, { deviceId: device.id, syncGroupId: device.syncGroupId })
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
    // Mirror into the blob store so this upload is reference-counted like any
    // other, and is reclaimed if its sync group goes away.
    await prisma.blob.upsert({
      where: { sha256 },
      create: { sha256, byteSize: data.length, receivedBytes: data.length, mimeType, complete: true },
      update: { byteSize: data.length, receivedBytes: data.length, mimeType, complete: true },
    })
    await addBlobRef(sha256, 'sync-group', device.syncGroupId)

    logRequest(context, 'info', 'media.upload', {
      sha256: sha256.slice(0, 12),
      byteSize: data.length,
      mimeType,
    })
    return send(response, 200, { sha256, byteSize: data.length })
  }

  if (request.method === 'GET' && url.pathname.startsWith('/media/')) {
    const device = await authenticate(request)
    addLogFields(context, { deviceId: device.id, syncGroupId: device.syncGroupId })
    const sha256 = sanitizeSha256(decodeURIComponent(url.pathname.slice('/media/'.length)))
    const object = await prisma.mediaObject.findUnique({
      where: { syncGroupId_sha256: { syncGroupId: device.syncGroupId, sha256 } },
    })
    const blobPath = mediaBlobPath(sha256)
    if (!object || !fs.existsSync(blobPath)) throw httpError(404, 'Media not found.')

    logRequest(context, 'info', 'media.download', {
      sha256: sha256.slice(0, 12),
      byteSize: object.byteSize,
      mimeType: object.mimeType,
    })
    return send(response, 200, {
      sha256,
      mimeType: object.mimeType,
      dataBase64: fs.readFileSync(blobPath).toString('base64'),
    })
  }

  if (request.method === 'POST' && url.pathname === '/sync/snapshot') {
    const device = await authenticate(request)
    addLogFields(context, { deviceId: device.id, syncGroupId: device.syncGroupId })
    const body = await readJson(request, config.maxBlobBytes)
    const snapshot = body.snapshot
    if (!snapshot || typeof snapshot !== 'object') throw httpError(400, 'snapshot object is required.')
    const targetDeviceId = optionalString(body, 'targetDeviceId')
    const uploadComplete = typeof body.uploadComplete === 'boolean' ? body.uploadComplete : true
    if (targetDeviceId) {
      const target = await prisma.device.findUnique({ where: { id: targetDeviceId } })
      if (!target || target.syncGroupId !== device.syncGroupId || target.revokedAt) {
        throw httpError(400, 'Snapshot target must be an active device in the same sync group.')
      }
      if (target.id === device.id) throw httpError(400, 'Snapshot source and target must be different devices.')
    }
    const payloadJson = encodeSyncSnapshot(snapshot, targetDeviceId, uploadComplete)

    await prisma.syncSnapshot.upsert({
      where: { syncGroupId: device.syncGroupId },
      create: {
        syncGroupId: device.syncGroupId,
        sourceDeviceId: device.id,
        payloadJson,
      },
      update: { sourceDeviceId: device.id, payloadJson },
    })

    logRequest(context, 'info', 'sync.snapshot.upload', {
      decks: Array.isArray(snapshot.decks) ? snapshot.decks.length : 0,
      cards: Array.isArray(snapshot.cards) ? snapshot.cards.length : 0,
      reviewLogs: Array.isArray(snapshot.reviewLogs) ? snapshot.reviewLogs.length : 0,
      media: Array.isArray(snapshot.media) ? snapshot.media.length : 0,
      sourceDeviceId: device.id,
      targetDeviceId,
      uploadComplete,
    })
    return send(response, 200, { ok: true })
  }

  if (request.method === 'GET' && url.pathname === '/sync/snapshot') {
    const device = await authenticate(request)
    addLogFields(context, { deviceId: device.id, syncGroupId: device.syncGroupId })
    const snapshot = await prisma.syncSnapshot.findUnique({
      where: { syncGroupId: device.syncGroupId },
    })

    const decoded = snapshot ? decodeSyncSnapshot(snapshot.payloadJson) : null
    if (
      !snapshot ||
      !decoded ||
      !canDeviceReceiveSnapshot({
        sourceDeviceId: snapshot.sourceDeviceId,
        targetDeviceId: decoded.targetDeviceId,
        deviceId: device.id,
      })
    ) {
      logRequest(context, 'info', 'sync.snapshot.pull', {
        found: false,
        sourceDeviceId: snapshot?.sourceDeviceId ?? null,
        targetDeviceId: decoded?.targetDeviceId ?? null,
      })
      return send(response, 200, { snapshot: null, sourceDeviceId: null })
    }

    logRequest(context, 'info', 'sync.snapshot.pull', {
      found: true,
      sourceDeviceId: snapshot.sourceDeviceId,
      targetDeviceId: decoded.targetDeviceId,
      uploadComplete: decoded.uploadComplete,
      decks: Array.isArray(decoded.snapshot?.decks) ? decoded.snapshot.decks.length : 0,
      cards: Array.isArray(decoded.snapshot?.cards) ? decoded.snapshot.cards.length : 0,
      reviewLogs: Array.isArray(decoded.snapshot?.reviewLogs) ? decoded.snapshot.reviewLogs.length : 0,
      media: Array.isArray(decoded.snapshot?.media) ? decoded.snapshot.media.length : 0,
    })
    const manifestMedia = Array.isArray(decoded.snapshot?.media) ? decoded.snapshot.media : []
    const manifestHashes = manifestMedia
      .map((item) => item?.sha256)
      .filter((value) => typeof value === 'string')
    const storedMedia = await prisma.mediaObject.findMany({
      where: {
        syncGroupId: device.syncGroupId,
        ...(manifestHashes.length > 0 ? { sha256: { in: manifestHashes } } : {}),
      },
      select: { sha256: true },
    })
    const availableMediaSha256 = listAvailableSnapshotMedia(
      manifestMedia,
      storedMedia.map((item) => item.sha256)
    )
    return send(response, 200, {
      snapshot: decoded.snapshot,
      sourceDeviceId: snapshot.sourceDeviceId,
      uploadComplete: decoded.uploadComplete,
      availableMediaSha256,
    })
  }

  if (request.method === 'POST' && url.pathname === '/sync/snapshot/ack') {
    const device = await authenticate(request)
    addLogFields(context, { deviceId: device.id, syncGroupId: device.syncGroupId })
    const snapshot = await prisma.syncSnapshot.findUnique({
      where: { syncGroupId: device.syncGroupId },
    })

    const decoded = snapshot ? decodeSyncSnapshot(snapshot.payloadJson) : null
    // Only the intended target can clear a targeted snapshot. This prevents an
    // already-paired third device from consuming a new phone's full handoff.
    if (
      snapshot &&
      decoded &&
      decoded.uploadComplete &&
      canDeviceReceiveSnapshot({
        sourceDeviceId: snapshot.sourceDeviceId,
        targetDeviceId: decoded.targetDeviceId,
        deviceId: device.id,
      })
    ) {
      const media = Array.isArray(decoded.snapshot?.media) ? decoded.snapshot.media : []
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
          const [syncReferences, globalReferences] = await Promise.all([
            prisma.mediaObject.count({ where: { sha256 } }),
            prisma.globalDeckMedia.count({ where: { sha256 } }),
          ])
          if (syncReferences === 0 && globalReferences === 0) fs.rmSync(mediaBlobPath(sha256), { force: true })
        } catch {
          // Best-effort blob cleanup; the DB row is already gone.
        }
      }
      logRequest(context, 'info', 'sync.snapshot.ack', {
        cleared: true,
        sourceDeviceId: snapshot.sourceDeviceId,
        targetDeviceId: decoded.targetDeviceId,
        uploadComplete: decoded.uploadComplete,
        mediaDeleted: hashes.length,
      })
    } else {
      logRequest(context, 'info', 'sync.snapshot.ack', {
        cleared: false,
        sourceDeviceId: snapshot?.sourceDeviceId ?? null,
        targetDeviceId: decoded?.targetDeviceId ?? null,
        uploadComplete: decoded?.uploadComplete ?? null,
      })
    }

    return send(response, 200, { ok: true })
  }

  return send(response, 404, { error: 'Not found.' })
}

export const server = http.createServer((request, response) => {
  const context = createRequestContext(request)
  response.setHeader('x-request-id', context.requestId)
  route(request, response, context).catch((error) => {
    const status = Number(error.status ?? 500)
    const message = status >= 500 ? 'Internal server error.' : error.message
    logRequest(context, 'error', 'request.error', {
      status,
      error: message,
      errorDetail: error.message,
    })
    if (status >= 500) console.error(error)
    send(response, status, { error: message })
  })
})

// Storage reclaim is opt-in so the first run on an existing host is a reviewed
// `node host/gc.js` rather than a surprise at startup.
let blobSweepTimer = null
if (config.blobSweepEnabled) {
  const runSweep = async () => {
    try {
      const summary = await sweepBlobs({ prisma, mediaDir: config.mediaDir, apply: true })
      if (summary.deleted > 0) {
        console.log(JSON.stringify({ time: nowIso(), level: 'info', event: 'blobs.sweep', ...summary }))
      }
    } catch (error) {
      console.error(JSON.stringify({ time: nowIso(), level: 'error', event: 'blobs.sweep', error: error.message }))
    }
  }
  blobSweepTimer = setInterval(runSweep, config.blobSweepIntervalMs)
  blobSweepTimer.unref?.()
}

const shutdown = async () => {
  if (blobSweepTimer) clearInterval(blobSweepTimer)
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
