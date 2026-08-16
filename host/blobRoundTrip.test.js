/**
 * The client and the host, talking to each other for real.
 *
 * `blobs.test.js` and `blobClient.test.ts` each test one side against a stand-in
 * for the other, which cannot catch the two sides disagreeing about the wire —
 * a header name, the Content-Range grammar, whether an offset is inclusive.
 * This drives the actual shared client against the actual server over HTTP.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createBlobClient } from '../src/shared/sync/blobClient'
import { createTransport } from '../src/shared/sync/transport'

const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onami-roundtrip-'))
const TOKEN = 'round-trip-token'

const db = { blobs: new Map(), refs: new Map() }
const refKey = (sha256, scopeKind, scopeId) => `${sha256}|${scopeKind}|${scopeId}`

const prismaStub = {
  $queryRaw: async () => [{ ok: 1 }],
  $disconnect: async () => undefined,
  deviceToken: {
    findUnique: async ({ where }) =>
      where.tokenHash === createHash('sha256').update(`token:${TOKEN}`).digest('hex')
        ? {
            expiresAt: new Date(Date.now() + 60_000),
            device: { id: 'device-1', syncGroupId: 'group-1', revokedAt: null, platform: 'test' },
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
      db.blobs.set(where.sha256, existing ? { ...existing, ...update } : { updatedAt: new Date(), ...create })
    },
    update: async ({ where, data }) => {
      db.blobs.set(where.sha256, { ...db.blobs.get(where.sha256), ...data })
    },
    delete: async ({ where }) => db.blobs.delete(where.sha256),
  },
  blobRef: {
    upsert: async ({ create }) => db.refs.set(refKey(create.sha256, create.scopeKind, create.scopeId), create),
    findFirst: async ({ where }) =>
      [...db.refs.values()].find((ref) => ref.sha256 === where.sha256 && ref.scopeKind === where.scopeKind) ?? null,
    deleteMany: async () => undefined,
  },
  mediaObject: { upsert: async () => undefined, findMany: async () => [] },
}

vi.mock('@prisma/client', () => ({ PrismaClient: class { constructor() { return prismaStub } } }))

let server
let client

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://stub'
  process.env.ONAMI_MEDIA_DIR = mediaDir
  process.env.ONAMI_HOST_PORT = '0'
  process.env.ONAMI_HOST_BIND = '127.0.0.1'
  process.env.ONAMI_LOG_REQUESTS = '0'

  server = (await import('./server.js')).server
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve))

  const port = server.address().port
  client = createBlobClient({
    transport: createTransport({
      hostUrl: () => `http://127.0.0.1:${port}`,
      token: () => TOKEN,
      sleep: async () => undefined,
    }),
    // Small chunks so a modest payload still exercises the multi-chunk path.
    chunkPolicy: { minBytes: 4096, maxBytes: 4096, targetSeconds: 5 },
  })
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

/** 100 KB of non-repeating bytes, so a misplaced offset corrupts detectably. */
const payload = Buffer.from(
  Array.from({ length: 100_000 }, (_value, index) => (index * 37 + (index >> 8)) % 256)
)
const payloadHash = createHash('sha256').update(payload).digest('hex')

const descriptor = {
  sha256: payloadHash,
  byteSize: payload.length,
  mimeType: 'audio/mpeg',
  originalName: 'genki-lesson-01.mp3',
}

const readFrom = (source) => async (offset, length) => source.subarray(offset, offset + length)

describe('client and host, end to end', () => {
  it('uploads a multi-chunk file that the host accepts and verifies', async () => {
    const result = await client.upload({ blob: descriptor, read: readFrom(payload) })

    expect(result.bytesSent).toBe(payload.length)
    expect(fs.readFileSync(path.join(mediaDir, payloadHash))).toEqual(payload)
    expect(db.blobs.get(payloadHash)).toMatchObject({ complete: true, byteSize: payload.length })
  })

  it('resumes an upload the client abandoned part-way', async () => {
    const controller = new AbortController()
    let sent = 0

    // Stop the transfer mid-file, the way losing signal would.
    await expect(
      client.upload({
        blob: descriptor,
        read: readFrom(payload),
        signal: controller.signal,
        onProgress: (progress) => {
          sent = progress.transferred
          if (progress.transferred >= 20_000) controller.abort()
        },
      })
    ).rejects.toThrow()

    expect(sent).toBeGreaterThan(0)
    expect(sent).toBeLessThan(payload.length)
    const offsetAfterInterrupt = fs.statSync(path.join(mediaDir, `${payloadHash}.part`)).size

    // A fresh attempt asks the host where it stopped and continues from there.
    const reads = []
    const result = await client.upload({
      blob: descriptor,
      read: async (offset, length) => {
        reads.push(offset)
        return payload.subarray(offset, offset + length)
      },
    })

    expect(reads[0]).toBe(offsetAfterInterrupt)
    expect(result.bytesSent).toBe(payload.length - offsetAfterInterrupt)
    expect(fs.readFileSync(path.join(mediaDir, payloadHash))).toEqual(payload)
  })

  it('costs nothing to upload a file the host already holds', async () => {
    await client.upload({ blob: descriptor, read: readFrom(payload) })

    const again = await client.upload({
      blob: descriptor,
      read: async () => {
        throw new Error('Should not have read the file again.')
      },
    })

    expect(again).toEqual({ bytesSent: 0, reused: true })
  })

  it('downloads what it uploaded, byte for byte', async () => {
    await client.upload({ blob: descriptor, read: readFrom(payload) })

    const chunks = []
    await client.download({
      blob: descriptor,
      write: async (chunk, offset) => chunks.push({ chunk: Buffer.from(chunk), offset }),
    })

    expect(chunks).toHaveLength(1)
    expect(chunks[0].offset).toBe(0)
    expect(chunks[0].chunk).toEqual(payload)
  })

  it('resumes a download from what the client already saved', async () => {
    await client.upload({ blob: descriptor, read: readFrom(payload) })

    const staged = payload.subarray(0, 70_000)
    let received = null
    const result = await client.download({
      blob: descriptor,
      startOffset: staged.length,
      write: async (chunk, offset) => {
        received = { chunk: Buffer.from(chunk), offset }
      },
    })

    expect(result.bytesReceived).toBe(payload.length - staged.length)
    expect(received.offset).toBe(staged.length)
    expect(Buffer.concat([staged, received.chunk])).toEqual(payload)
  })

  it('reports present, partial, and missing against the real host', async () => {
    const partial = Buffer.from('a partially uploaded file'.repeat(500))
    const partialHash = createHash('sha256').update(partial).digest('hex')

    await client.upload({ blob: descriptor, read: readFrom(payload) })
    const controller = new AbortController()
    await client
      .upload({
        blob: { sha256: partialHash, byteSize: partial.length, mimeType: 'text/plain', originalName: 'p.txt' },
        read: readFrom(partial),
        signal: controller.signal,
        // Only after real bytes have landed, so this is genuinely partial and
        // not a transfer that never started.
        onProgress: (progress) => {
          if (progress.transferred > 0) controller.abort()
        },
      })
      .catch(() => undefined)

    const plan = await client.check([payloadHash, partialHash, 'f'.repeat(64)])

    expect(plan.present).toEqual([payloadHash])
    expect(plan.missing).toEqual(['f'.repeat(64)])
    expect(plan.partial[0]?.sha256).toBe(partialHash)
    expect(plan.partial[0]?.offset).toBeGreaterThan(0)
  })

  it('refuses bytes that do not match the name they were sent under', async () => {
    const liar = { ...descriptor, sha256: 'b'.repeat(64) }

    await expect(client.upload({ blob: liar, read: readFrom(payload) })).rejects.toThrow(
      'The uploaded bytes do not match the requested sha256.'
    )
    expect(fs.existsSync(path.join(mediaDir, `${'b'.repeat(64)}.part`))).toBe(false)
  })
})
