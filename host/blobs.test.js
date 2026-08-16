import { describe, expect, it } from 'vitest'

import {
  BLOB_GRACE,
  isBlobCollectable,
  normalizeSha256,
  parseContentRange,
  planBlobCheck,
  resolveBlobPatch,
} from './blobs.js'

const HASH = 'a'.repeat(64)
const limits = { maxBlobBytes: 64 * 1024 * 1024, maxChunkBytes: 16 * 1024 * 1024 }

describe('normalizeSha256', () => {
  it('lowercases valid hashes and rejects everything else', () => {
    expect(normalizeSha256('A'.repeat(64))).toBe(HASH)
    expect(normalizeSha256('a'.repeat(63))).toBeNull()
    expect(normalizeSha256('g'.repeat(64))).toBeNull()
    expect(normalizeSha256(undefined)).toBeNull()
  })
})

describe('parseContentRange', () => {
  it('parses an upload range', () => {
    expect(parseContentRange('bytes 0-1023/4096', limits)).toEqual({
      start: 0,
      end: 1023,
      total: 4096,
      length: 1024,
    })
  })

  it('parses a final chunk that ends exactly at the total size', () => {
    expect(parseContentRange('bytes 4095-4095/4096', limits)).toMatchObject({ start: 4095, length: 1 })
  })

  it('rejects ranges that fall outside the declared total', () => {
    expect(parseContentRange('bytes 0-4096/4096', limits).invalid).toBe(true)
    expect(parseContentRange('bytes 900-800/4096', limits).invalid).toBe(true)
    expect(parseContentRange('bytes 0-10/0', limits).invalid).toBe(true)
  })

  it('rejects the Range request grammar and other malformed headers', () => {
    expect(parseContentRange('bytes=0-1023', limits).invalid).toBe(true)
    expect(parseContentRange('', limits).invalid).toBe(true)
    expect(parseContentRange(undefined, limits).invalid).toBe(true)
  })

  it('enforces blob and chunk size ceilings', () => {
    expect(parseContentRange(`bytes 0-10/${limits.maxBlobBytes + 1}`, limits).invalid).toBe(true)
    expect(parseContentRange(`bytes 0-${limits.maxChunkBytes}/${limits.maxBlobBytes}`, limits).invalid).toBe(true)
  })
})

describe('resolveBlobPatch', () => {
  const range = { start: 0, end: 999, total: 4096, length: 1000 }

  it('accepts a first chunk for an unknown blob', () => {
    expect(resolveBlobPatch({ stored: null, range })).toEqual({
      outcome: 'append',
      offset: 0,
      byteSize: 4096,
      completes: false,
    })
  })

  it('resumes an interrupted upload at the stored offset', () => {
    const stored = { sha256: HASH, byteSize: 4096, receivedBytes: 1000, complete: false }
    expect(resolveBlobPatch({ stored, range: { start: 1000, end: 4095, total: 4096, length: 3096 } })).toEqual({
      outcome: 'append',
      offset: 1000,
      byteSize: 4096,
      completes: true,
    })
  })

  it('reports the expected offset instead of failing when a client resends', () => {
    const stored = { sha256: HASH, byteSize: 4096, receivedBytes: 2048, complete: false }
    expect(resolveBlobPatch({ stored, range })).toMatchObject({ outcome: 'offset-conflict', offset: 2048 })
  })

  it('treats a chunk for an already-complete blob as a no-op', () => {
    const stored = { sha256: HASH, byteSize: 4096, receivedBytes: 4096, complete: true }
    expect(resolveBlobPatch({ stored, range })).toEqual({
      outcome: 'already-complete',
      offset: 4096,
      byteSize: 4096,
    })
  })

  it('refuses a chunk that changes the declared total size', () => {
    const stored = { sha256: HASH, byteSize: 8192, receivedBytes: 0, complete: false }
    expect(resolveBlobPatch({ stored, range })).toMatchObject({ outcome: 'size-conflict', offset: 0 })
  })

  it('rejects a first chunk that does not start at zero', () => {
    expect(resolveBlobPatch({ stored: null, range: { start: 512, end: 999, total: 4096, length: 488 } })).toMatchObject({
      outcome: 'offset-conflict',
      offset: 0,
    })
  })
})

describe('planBlobCheck', () => {
  it('separates present, partial, and missing hashes and drops duplicates', () => {
    const stored = [
      { sha256: 'b'.repeat(64), receivedBytes: 10, complete: true },
      { sha256: 'c'.repeat(64), receivedBytes: 40, complete: false },
    ]
    expect(planBlobCheck(['b'.repeat(64), 'c'.repeat(64), HASH, HASH], stored)).toEqual({
      present: ['b'.repeat(64)],
      partial: [{ sha256: 'c'.repeat(64), offset: 40 }],
      missing: [HASH],
    })
  })
})

describe('isBlobCollectable', () => {
  const now = Date.UTC(2026, 7, 15)
  const ago = (ms) => new Date(now - ms).toISOString()

  it('keeps a blob that is still referenced no matter how old it is', () => {
    expect(isBlobCollectable({ complete: true, refCount: 1, updatedAt: ago(365 * 86_400_000), now })).toBe(false)
  })

  it('collects an unreferenced blob only after its grace period', () => {
    expect(isBlobCollectable({ complete: true, refCount: 0, updatedAt: ago(60_000), now })).toBe(false)
    expect(isBlobCollectable({ complete: true, refCount: 0, updatedAt: ago(BLOB_GRACE.unreferencedMs), now })).toBe(true)
  })

  it('abandons an upload nobody has resumed, even if something references it', () => {
    expect(isBlobCollectable({ complete: false, refCount: 1, updatedAt: ago(86_400_000), now })).toBe(false)
    expect(isBlobCollectable({ complete: false, refCount: 1, updatedAt: ago(BLOB_GRACE.incompleteMs), now })).toBe(true)
  })
})
