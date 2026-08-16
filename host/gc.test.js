import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BLOB_GRACE } from './blobs.js'
import { backfillBlobs, sweepBlobs } from './gc.js'

const temporaryDirectories = []

const createMediaDir = (files) => {
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onami-gc-'))
  temporaryDirectories.push(mediaDir)
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(mediaDir, name), contents)
  }
  return mediaDir
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/** Enough of the Prisma surface for the two functions under test. */
const createPrismaStub = ({ blobs = [], refs = [], globalDeckMedia = [], mediaObjects = [], snapshots = [] }) => {
  const state = { blobs: [...blobs], refs: [...refs], mediaObjects: [...mediaObjects] }
  const refKey = (ref) => `${ref.sha256}|${ref.scopeKind}|${ref.scopeId}`

  return {
    state,
    blob: {
      findMany: async ({ select }) =>
        state.blobs.map((blob) => ({
          ...blob,
          ...(select?._count
            ? { _count: { refs: state.refs.filter((ref) => ref.sha256 === blob.sha256).length } }
            : {}),
        })),
      findUnique: async ({ where }) => state.blobs.find((blob) => blob.sha256 === where.sha256) ?? null,
      create: async ({ data }) => {
        state.blobs.push({ updatedAt: new Date(), ...data })
        return data
      },
      delete: async ({ where }) => {
        state.blobs = state.blobs.filter((blob) => blob.sha256 !== where.sha256)
      },
    },
    blobRef: {
      upsert: async ({ create }) => {
        if (!state.refs.some((ref) => refKey(ref) === refKey(create))) state.refs.push(create)
      },
    },
    globalDeckMedia: { findMany: async () => globalDeckMedia },
    mediaObject: {
      findMany: async () => state.mediaObjects,
      deleteMany: async ({ where }) => {
        state.mediaObjects = state.mediaObjects.filter((media) => media.sha256 !== where.sha256)
      },
    },
    syncSnapshot: { findMany: async () => snapshots },
  }
}

const hash = (character) => character.repeat(64)
const daysAgo = (days) => new Date(Date.now() - days * 86_400_000)

describe('backfillBlobs', () => {
  it('gives every file a row, and references only what is genuinely live', async () => {
    const published = hash('a')
    const strandedSync = hash('b')
    const liveSync = hash('c')
    const mediaDir = createMediaDir({
      [published]: 'published bytes',
      [strandedSync]: 'stranded bytes',
      [liveSync]: 'live bytes',
      [`${hash('d')}.part`]: 'partial upload',
      'not-a-hash.txt': 'ignored',
    })

    const prisma = createPrismaStub({
      globalDeckMedia: [{ deckId: 'deck-1', sha256: published, mimeType: 'audio/mpeg', byteSize: 15 }],
      mediaObjects: [
        { sha256: strandedSync, mimeType: 'audio/mpeg', byteSize: 14 },
        { sha256: liveSync, mimeType: 'audio/mpeg', byteSize: 10 },
      ],
      snapshots: [{ syncGroupId: 'group-1', payloadJson: { media: [{ sha256: liveSync }] } }],
    })

    const summary = await backfillBlobs({ prisma, mediaDir })

    expect(summary.files).toBe(3)
    expect(summary.rowsCreated).toBe(3)
    expect(prisma.state.refs).toEqual([
      { sha256: published, scopeKind: 'published-deck', scopeId: 'deck-1' },
      { sha256: liveSync, scopeKind: 'sync-group', scopeId: 'group-1' },
    ])
  })

  it('carries the known mime type onto the created row', async () => {
    const sha256 = hash('a')
    const mediaDir = createMediaDir({ [sha256]: 'bytes' })
    const prisma = createPrismaStub({
      globalDeckMedia: [{ deckId: 'deck-1', sha256, mimeType: 'image/png', byteSize: 5 }],
    })

    await backfillBlobs({ prisma, mediaDir })

    expect(prisma.state.blobs[0]).toMatchObject({ sha256, mimeType: 'image/png', byteSize: 5, complete: true })
  })

  it('does not reference a published file that is missing from disk', async () => {
    const mediaDir = createMediaDir({})
    const prisma = createPrismaStub({
      globalDeckMedia: [{ deckId: 'deck-1', sha256: hash('a'), mimeType: 'image/png', byteSize: 5 }],
    })

    const summary = await backfillBlobs({ prisma, mediaDir })

    expect(summary.missingFiles).toBe(1)
    expect(prisma.state.refs).toEqual([])
  })
})

describe('sweepBlobs', () => {
  const referenced = hash('a')
  const stranded = hash('b')
  const recentlyOrphaned = hash('c')
  const abandonedUpload = hash('d')

  const scenario = () => {
    const mediaDir = createMediaDir({
      [referenced]: 'keep me',
      [stranded]: 'reclaim me',
      [recentlyOrphaned]: 'too soon',
      [`${abandonedUpload}.part`]: 'half a file',
    })
    const prisma = createPrismaStub({
      blobs: [
        { sha256: referenced, byteSize: 7, complete: true, updatedAt: daysAgo(30) },
        { sha256: stranded, byteSize: 10, complete: true, updatedAt: daysAgo(30) },
        { sha256: recentlyOrphaned, byteSize: 8, complete: true, updatedAt: new Date() },
        { sha256: abandonedUpload, byteSize: 100, complete: false, updatedAt: daysAgo(30) },
      ],
      refs: [{ sha256: referenced, scopeKind: 'published-deck', scopeId: 'deck-1' }],
      mediaObjects: [{ sha256: stranded, mimeType: 'audio/mpeg', byteSize: 10 }],
    })
    return { mediaDir, prisma }
  }

  it('reports without touching anything by default', async () => {
    const { mediaDir, prisma } = scenario()

    const summary = await sweepBlobs({ prisma, mediaDir })

    expect(summary).toMatchObject({ scanned: 4, collectable: 2, bytes: 110, deleted: 0, applied: false })
    expect(fs.existsSync(path.join(mediaDir, stranded))).toBe(true)
    expect(prisma.state.blobs).toHaveLength(4)
  })

  it('deletes only unreferenced blobs and abandoned uploads when applied', async () => {
    const { mediaDir, prisma } = scenario()

    const summary = await sweepBlobs({ prisma, mediaDir, apply: true })

    expect(summary).toMatchObject({ collectable: 2, deleted: 2, applied: true })
    expect(fs.existsSync(path.join(mediaDir, referenced))).toBe(true)
    expect(fs.existsSync(path.join(mediaDir, recentlyOrphaned))).toBe(true)
    expect(fs.existsSync(path.join(mediaDir, stranded))).toBe(false)
    expect(fs.existsSync(path.join(mediaDir, `${abandonedUpload}.part`))).toBe(false)
    expect(prisma.state.blobs.map((blob) => blob.sha256)).toEqual([referenced, recentlyOrphaned])
  })

  it('clears the legacy media row that pointed at the reclaimed bytes', async () => {
    const { mediaDir, prisma } = scenario()

    await sweepBlobs({ prisma, mediaDir, apply: true })

    expect(prisma.state.mediaObjects).toEqual([])
  })

  it('keeps an orphan until its grace period has passed', async () => {
    const { mediaDir, prisma } = scenario()
    const justInsideGrace = Date.now() + BLOB_GRACE.unreferencedMs - 1000

    const summary = await sweepBlobs({ prisma, mediaDir, now: justInsideGrace, apply: false })

    expect(summary.collectable).toBe(2)
    expect(await sweepBlobs({ prisma, mediaDir, now: 0 })).toMatchObject({ collectable: 0 })
  })
})
