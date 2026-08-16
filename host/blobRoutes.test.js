/**
 * End-to-end tests for the blob endpoints over real HTTP.
 *
 * The point of the blob store is that an interrupted transfer continues where
 * it stopped, so these drive the actual server with a stubbed database rather
 * than testing the decision helpers a second time.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onami-blob-routes-'))

const TOKEN = 'test-device-token'
const SYNC_GROUP_ID = 'group-1'

/** In-memory stand-in for the tables the blob routes touch. */
const db = {
  blobs: new Map(),
  refs: new Map(),
  mediaObjects: new Map(),
}

const refKey = (sha256, scopeKind, scopeId) => `${sha256}|${scopeKind}|${scopeId}`

const prismaStub = {
  $queryRaw: async () => [{ '?column?': 1 }],
  $disconnect: async () => undefined,
  deviceToken: {
    findUnique: async ({ where }) =>
      where.tokenHash === createHash('sha256').update(`token:${TOKEN}`).digest('hex')
        ? {
            expiresAt: new Date(Date.now() + 60_000),
            device: { id: 'device-1', syncGroupId: SYNC_GROUP_ID, revokedAt: null, platform: 'test' },
          }
        : null,
  },
  device: { update: async () => undefined },
  blob: {
    findUnique: async ({ where }) => db.blobs.get(where.sha256) ?? null,
    findMany: async ({ where }) =>
      [...db.blobs.values()].filter((blob) => !where?.sha256?.in || where.sha256.in.includes(blob.sha256)),
    upsert: async ({ where, create, update }) => {
      const existing = db.blobs.get(where.sha256)
      const next = existing ? { ...existing, ...update } : { updatedAt: new Date(), ...create }
      db.blobs.set(where.sha256, next)
      return next
    },
    update: async ({ where, data }) => {
      const next = { ...db.blobs.get(where.sha256), ...data, updatedAt: new Date() }
      db.blobs.set(where.sha256, next)
      return next
    },
    delete: async ({ where }) => {
      db.blobs.delete(where.sha256)
    },
  },
  blobRef: {
    upsert: async ({ create }) => {
      db.refs.set(refKey(create.sha256, create.scopeKind, create.scopeId), create)
    },
    findFirst: async ({ where }) =>
      [...db.refs.values()].find(
        (ref) => ref.sha256 === where.sha256 && ref.scopeKind === where.scopeKind
      ) ?? null,
    deleteMany: async () => undefined,
  },
  mediaObject: {
    upsert: async ({ where, create }) => {
      db.mediaObjects.set(`${where.syncGroupId_sha256.syncGroupId}|${where.syncGroupId_sha256.sha256}`, create)
    },
    findMany: async () => [...db.mediaObjects.values()],
  },
}

vi.mock('@prisma/client', () => ({ PrismaClient: class { constructor() { return prismaStub } } }))

let baseUrl = ''
let server

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://stub'
  process.env.ONAMI_MEDIA_DIR = mediaDir
  process.env.ONAMI_HOST_PORT = '0'
  process.env.ONAMI_HOST_BIND = '127.0.0.1'
  process.env.ONAMI_LOG_REQUESTS = '0'

  const module = await import('./server.js')
  server = module.server
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(mediaDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.blobs.clear()
  db.refs.clear()
  for (const entry of fs.readdirSync(mediaDir)) fs.rmSync(path.join(mediaDir, entry), { force: true })
})

const authorized = { authorization: `Bearer ${TOKEN}` }

const patchChunk = (sha256, body, start, total, headers = {}) =>
  fetch(`${baseUrl}/blob/${sha256}`, {
    method: 'PATCH',
    headers: {
      ...authorized,
      'content-type': 'audio/mpeg',
      'content-range': `bytes ${start}-${start + body.length - 1}/${total}`,
      ...headers,
    },
    body,
  })

const payload = Buffer.from('the quick brown fox jumps over the lazy dog, repeatedly and at length')
const payloadHash = createHash('sha256').update(payload).digest('hex')

describe('resumable blob upload', () => {
  it('reports no offset for a blob the host has never seen', async () => {
    const response = await fetch(`${baseUrl}/blob/${payloadHash}`, { method: 'HEAD', headers: authorized })
    expect(response.status).toBe(404)
    expect(response.headers.get('upload-offset')).toBe('0')
  })

  it('stores a whole blob in one chunk and marks it complete', async () => {
    const response = await patchChunk(payloadHash, payload, 0, payload.length)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ sha256: payloadHash, offset: payload.length, complete: true })
    expect(fs.readFileSync(path.join(mediaDir, payloadHash))).toEqual(payload)
  })

  it('resumes an interrupted upload from the offset the host reports', async () => {
    const firstHalf = payload.subarray(0, 20)
    const secondHalf = payload.subarray(20)

    const first = await patchChunk(payloadHash, firstHalf, 0, payload.length)
    expect(await first.json()).toMatchObject({ offset: 20, complete: false })

    // What a client does after a crash: ask where to continue, then continue.
    const head = await fetch(`${baseUrl}/blob/${payloadHash}`, { method: 'HEAD', headers: authorized })
    expect(head.headers.get('upload-offset')).toBe('20')
    expect(head.headers.get('upload-complete')).toBe('?0')

    const second = await patchChunk(payloadHash, secondHalf, 20, payload.length)
    expect(await second.json()).toMatchObject({ offset: payload.length, complete: true })
    expect(fs.readFileSync(path.join(mediaDir, payloadHash))).toEqual(payload)
  })

  it('answers a duplicate chunk with the offset to use instead of failing', async () => {
    await patchChunk(payloadHash, payload.subarray(0, 20), 0, payload.length)
    const repeat = await patchChunk(payloadHash, payload.subarray(0, 20), 0, payload.length)

    expect(repeat.status).toBe(409)
    expect(await repeat.json()).toMatchObject({ offset: 20, complete: false })
  })

  it('treats a chunk for an already-complete blob as success', async () => {
    await patchChunk(payloadHash, payload, 0, payload.length)
    const repeat = await patchChunk(payloadHash, payload, 0, payload.length)

    expect(repeat.status).toBe(200)
    expect(await repeat.json()).toMatchObject({ complete: true, reused: true })
  })

  it('rejects bytes that do not hash to the requested name and keeps nothing', async () => {
    const lie = Buffer.from('not the promised content')
    const response = await patchChunk(payloadHash, lie, 0, lie.length)

    expect(response.status).toBe(400)
    expect(fs.existsSync(path.join(mediaDir, payloadHash))).toBe(false)
    expect(fs.existsSync(path.join(mediaDir, `${payloadHash}.part`))).toBe(false)
  })

  it('rejects a body whose length disagrees with its Content-Range', async () => {
    const response = await fetch(`${baseUrl}/blob/${payloadHash}`, {
      method: 'PATCH',
      headers: { ...authorized, 'content-range': `bytes 0-99/${payload.length}` },
      body: payload,
    })

    expect(response.status).toBe(400)
    expect(fs.existsSync(path.join(mediaDir, `${payloadHash}.part`))).toBe(false)
  })

  it('stays reachable through the legacy media route for un-updated devices', async () => {
    await patchChunk(payloadHash, payload, 0, payload.length)

    // A device still on the previous build asks for this file the old way.
    expect(db.mediaObjects.get(`${SYNC_GROUP_ID}|${payloadHash}`)).toMatchObject({
      sha256: payloadHash,
      byteSize: payload.length,
      mimeType: 'audio/mpeg',
    })
  })

  it('refuses an upload without a device token', async () => {
    const response = await fetch(`${baseUrl}/blob/${payloadHash}`, {
      method: 'PATCH',
      headers: { 'content-range': `bytes 0-${payload.length - 1}/${payload.length}` },
      body: payload,
    })

    expect(response.status).toBe(401)
  })
})

describe('blob download', () => {
  beforeEach(async () => {
    await patchChunk(payloadHash, payload, 0, payload.length)
  })

  it('serves the stored bytes with a strong validator', async () => {
    const response = await fetch(`${baseUrl}/blob/${payloadHash}`, { headers: authorized })

    expect(response.status).toBe(200)
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('etag')).toBe(`"sha256-${payloadHash}"`)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(payload)
  })

  it('serves a byte range so an interrupted download resumes', async () => {
    const response = await fetch(`${baseUrl}/blob/${payloadHash}`, {
      headers: { ...authorized, range: 'bytes=20-' },
    })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes 20-${payload.length - 1}/${payload.length}`)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(payload.subarray(20))
  })

  it('keeps sync media private but serves published deck media to anyone', async () => {
    expect((await fetch(`${baseUrl}/blob/${payloadHash}`)).status).toBe(401)

    db.refs.set(refKey(payloadHash, 'published-deck', 'deck-1'), {
      sha256: payloadHash,
      scopeKind: 'published-deck',
      scopeId: 'deck-1',
    })

    expect((await fetch(`${baseUrl}/blob/${payloadHash}`)).status).toBe(200)
  })

  it('does not serve a blob that is still uploading', async () => {
    const other = Buffer.from('a partially uploaded file body')
    const otherHash = createHash('sha256').update(other).digest('hex')
    await patchChunk(otherHash, other.subarray(0, 5), 0, other.length)

    expect((await fetch(`${baseUrl}/blob/${otherHash}`, { headers: authorized })).status).toBe(404)
  })
})

describe('blob check', () => {
  it('splits hashes into present, partial, and missing', async () => {
    const partial = Buffer.from('a partially uploaded file body')
    const partialHash = createHash('sha256').update(partial).digest('hex')

    await patchChunk(payloadHash, payload, 0, payload.length)
    await patchChunk(partialHash, partial.subarray(0, 6), 0, partial.length)

    const response = await fetch(`${baseUrl}/blobs/check`, {
      method: 'POST',
      headers: { ...authorized, 'content-type': 'application/json' },
      body: JSON.stringify({ sha256: [payloadHash, partialHash, 'f'.repeat(64)] }),
    })

    expect(await response.json()).toEqual({
      present: [payloadHash],
      partial: [{ sha256: partialHash, offset: 6 }],
      missing: ['f'.repeat(64)],
    })
  })
})
