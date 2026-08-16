/**
 * The records endpoints, driven over real HTTP.
 *
 * These cover the two properties the whole model rests on: a device pulling
 * from version 0 gets the entire library through the same endpoint everyone
 * else uses (so hydration needs no snapshot), and the host refuses a write that
 * would undo newer study.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onami-records-'))
const TOKEN = 'records-token'
const GROUP = 'group-1'

/** In-memory stand-ins, with the sequence semantics the real columns have. */
const db = { records: new Map(), reviewLog: new Map(), refs: new Map() }
let versionSequence = 0

const key = (kind, recordId) => `${GROUP}|${kind}|${recordId}`

const prismaStub = {
  $queryRaw: async () => [{ ok: 1 }],
  $disconnect: async () => undefined,
  $transaction: async (operations) => {
    const results = []
    for (const operation of operations) results.push(await operation)
    return results
  },
  deviceToken: {
    findUnique: async ({ where }) =>
      where.tokenHash === createHash('sha256').update(`token:${TOKEN}`).digest('hex')
        ? {
            expiresAt: new Date(Date.now() + 60_000),
            device: { id: 'device-1', syncGroupId: GROUP, revokedAt: null, platform: 'test' },
          }
        : null,
  },
  device: { update: async () => undefined },
  syncRecord: {
    findUnique: async ({ where }) => {
      const id = where.syncGroupId_kind_recordId
      return db.records.get(key(id.kind, id.recordId)) ?? null
    },
    findMany: async ({ where, take }) =>
      [...db.records.values()]
        .filter((row) => row.syncGroupId === where.syncGroupId && Number(row.version) > Number(where.version.gt))
        .sort((left, right) => Number(left.version) - Number(right.version))
        .slice(0, take),
    deleteMany: async ({ where }) => {
      db.records.delete(key(where.kind, where.recordId))
    },
    create: async ({ data }) => {
      versionSequence += 1
      const row = { ...data, version: versionSequence }
      db.records.set(key(data.kind, data.recordId), row)
      return row
    },
    aggregate: async () => ({
      _max: { version: [...db.records.values()].reduce((high, row) => Math.max(high, Number(row.version)), 0) },
    }),
  },
  reviewLogEntry: {
    createMany: async ({ data, skipDuplicates }) => {
      let count = 0
      for (const entry of data) {
        const entryKey = `${entry.syncGroupId}|${entry.entryId}`
        if (skipDuplicates && db.reviewLog.has(entryKey)) continue
        versionSequence += 1
        db.reviewLog.set(entryKey, { ...entry, version: versionSequence })
        count += 1
      }
      return { count }
    },
    findMany: async ({ where, take }) =>
      [...db.reviewLog.values()]
        .filter((row) => row.syncGroupId === where.syncGroupId && Number(row.version) > Number(where.version.gt))
        .sort((left, right) => Number(left.version) - Number(right.version))
        .slice(0, take),
  },
  blob: { findUnique: async () => null, upsert: async () => undefined },
  blobRef: {
    upsert: async ({ create }) => db.refs.set(`${create.sha256}|${create.scopeId}`, create),
    findFirst: async () => null,
    deleteMany: async () => undefined,
  },
  mediaObject: { upsert: async () => undefined, findMany: async () => [] },
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

  server = (await import('./server.js')).server
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(mediaDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.records.clear()
  db.reviewLog.clear()
  db.refs.clear()
  versionSequence = 0
})

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

const push = (records) =>
  fetch(`${baseUrl}/records`, { method: 'POST', headers: auth, body: JSON.stringify({ records }) })

const pull = (since = 0, limit = 500) =>
  fetch(`${baseUrl}/records?since=${since}&limit=${limit}`, { headers: auth })

const card = (recordId, overrides = {}) => ({
  kind: 'card',
  recordId,
  updatedAt: '2026-08-15T12:00:00.000Z',
  deleted: false,
  mergeRank: 0,
  payload: { frontHtml: 'q', backHtml: 'a' },
  blobRefs: [],
  ...overrides,
})

describe('pushing records', () => {
  it('stores a batch and reports the cursor it reached', async () => {
    const response = await push([card('card-1'), card('card-2'), { ...card('deck-1'), kind: 'deck' }])

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ accepted: 3, superseded: 0, nextCursor: 3 })
  })

  it('replaces a record rather than appending, so the store stays library-sized', async () => {
    await push([card('card-1')])
    await push([card('card-1', { mergeRank: 1, updatedAt: '2026-08-15T13:00:00.000Z' })])

    const { records } = await (await pull(0)).json()
    expect(records).toHaveLength(1)
    expect(records[0].mergeRank).toBe(1)
  })

  it('gives a replaced record a higher version so devices see it again', async () => {
    await push([card('card-1'), card('card-2')])
    const before = await (await pull(0)).json()

    await push([card('card-1', { mergeRank: 5, updatedAt: '2026-08-15T13:00:00.000Z' })])

    // A device that had already caught up is told about exactly the one change.
    const after = await (await pull(before.nextCursor)).json()
    expect(after.records).toHaveLength(1)
    expect(after.records[0].recordId).toBe('card-1')
  })

  it('refuses a write that would undo newer study', async () => {
    // The phone has studied this card 50 times.
    await push([card('card-1', { mergeRank: 50, updatedAt: '2026-08-15T12:00:00.000Z' })])

    // A desktop that has been closed for a week pushes its stale copy, with a
    // later clock but far fewer reviews.
    const response = await push([card('card-1', { mergeRank: 12, updatedAt: '2026-08-15T18:00:00.000Z' })])

    expect(await response.json()).toMatchObject({ accepted: 0, superseded: 1 })
    const { records } = await (await pull(0)).json()
    expect(records[0].mergeRank).toBe(50)
  })

  it('still lets a deletion through for a heavily studied card', async () => {
    await push([card('card-1', { mergeRank: 500 })])

    await push([card('card-1', { deleted: true, mergeRank: 0, updatedAt: '2026-08-15T13:00:00.000Z' })])

    const { records } = await (await pull(0)).json()
    expect(records[0].deleted).toBe(true)
  })

  it('treats re-pushing an identical batch as a no-op', async () => {
    await push([card('card-1')])
    const repeat = await push([card('card-1')])

    expect(await repeat.json()).toMatchObject({ accepted: 0, superseded: 1 })
  })

  it('collapses two writes to the same record inside one push', async () => {
    const response = await push([
      card('card-1', { mergeRank: 1 }),
      card('card-1', { mergeRank: 9, updatedAt: '2026-08-15T14:00:00.000Z' }),
    ])

    expect(await response.json()).toMatchObject({ accepted: 1 })
    const { records } = await (await pull(0)).json()
    expect(records[0].mergeRank).toBe(9)
  })

  it('registers the media a record needs so the host keeps those files', async () => {
    const hash = 'a'.repeat(64)
    await push([card('card-1', { blobRefs: [hash.toUpperCase()] })])

    expect(db.refs.get(`${hash}|${GROUP}`)).toMatchObject({ sha256: hash, scopeKind: 'sync-group' })
  })

  it('rejects a malformed record and names which one', async () => {
    const response = await push([card('card-1'), { ...card('card-2'), mergeRank: -3 }])

    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('records[1]: mergeRank must be a non-negative integer.')
  })

  it('refuses an unauthenticated push', async () => {
    const response = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ records: [] }),
    })
    expect(response.status).toBe(401)
  })
})

describe('pulling records', () => {
  it('gives a brand new device the whole library from version zero', async () => {
    await push([card('card-1'), card('card-2'), { ...card('deck-1'), kind: 'deck' }])

    // This is the same call an established device makes; only `since` differs.
    const { records, nextCursor } = await (await pull(0)).json()

    expect(records.map((row) => row.recordId).sort()).toEqual(['card-1', 'card-2', 'deck-1'])
    expect(nextCursor).toBe(3)
  })

  it('pages, and each page resumes exactly where the last stopped', async () => {
    await push(Array.from({ length: 7 }, (_value, index) => card(`card-${index}`)))

    const seen = []
    let cursor = 0
    for (let page = 0; page < 5; page += 1) {
      const body = await (await pull(cursor, 3)).json()
      if (body.records.length === 0) break
      seen.push(...body.records.map((row) => row.recordId))
      cursor = body.nextCursor
    }

    // Every record exactly once: no gaps at a page boundary, no repeats.
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
  })

  it('returns nothing to a device that is already caught up', async () => {
    await push([card('card-1')])
    const { nextCursor } = await (await pull(0)).json()

    const body = await (await pull(nextCursor)).json()

    expect(body.records).toEqual([])
    expect(body.nextCursor).toBe(nextCursor)
  })

  it('reports deletions so other devices can remove them too', async () => {
    await push([card('card-1')])
    const { nextCursor } = await (await pull(0)).json()
    await push([card('card-1', { deleted: true, updatedAt: '2026-08-15T13:00:00.000Z' })])

    const { records } = await (await pull(nextCursor)).json()
    expect(records[0]).toMatchObject({ recordId: 'card-1', deleted: true })
  })
})

describe('review log', () => {
  const entry = (id, overrides = {}) => ({
    id,
    cardId: 'card-1',
    reviewedAt: '2026-08-15T12:00:00.000Z',
    rating: 3,
    elapsedMs: 4000,
    revealMs: 1200,
    answerMs: 800,
    previousDueAt: null,
    nextDueAt: '2026-08-18T12:00:00.000Z',
    ...overrides,
  })

  const pushLog = (entries) =>
    fetch(`${baseUrl}/review-log`, { method: 'POST', headers: auth, body: JSON.stringify({ entries }) })

  it('appends reviews and reads them back in order', async () => {
    await pushLog([entry('r1'), entry('r2')])

    const body = await (await fetch(`${baseUrl}/review-log?since=0`, { headers: auth })).json()

    expect(body.entries.map((row) => row.id)).toEqual(['r1', 'r2'])
    expect(body.nextCursor).toBe(2)
  })

  it('ignores a review it already has, so retrying a batch is free', async () => {
    await pushLog([entry('r1')])
    const repeat = await pushLog([entry('r1'), entry('r2')])

    expect(await repeat.json()).toMatchObject({ accepted: 1 })
    const body = await (await fetch(`${baseUrl}/review-log?since=0`, { headers: auth })).json()
    expect(body.entries).toHaveLength(2)
  })

  it('rejects an entry with no usable timestamp', async () => {
    const response = await pushLog([entry('r1', { reviewedAt: 'yesterday' })])
    expect(response.status).toBe(400)
  })
})
