import { describe, expect, it } from 'vitest'

import {
  type SyncRecordEnvelope,
  collectBlobRefs,
  dedupeRecordBatch,
  nextCursorFrom,
  resolveRecordConflict,
  validateRecordEnvelope,
} from './records'

const record = (overrides: Partial<SyncRecordEnvelope> = {}): SyncRecordEnvelope => ({
  kind: 'card',
  recordId: 'card-1',
  updatedAt: '2026-08-15T12:00:00.000Z',
  deleted: false,
  mergeRank: 0,
  payload: {},
  blobRefs: [],
  ...overrides,
})

describe('resolveRecordConflict', () => {
  it('accepts anything when nothing is stored', () => {
    expect(resolveRecordConflict(null, record())).toBe('accept')
  })

  it('lets the device that has studied more win, whatever its clock says', () => {
    // The phone studied this card 50 times but its clock is an hour behind the
    // desktop, which has only ever seen it 12 times.
    const desktop = record({ mergeRank: 12, updatedAt: '2026-08-15T13:00:00.000Z' })
    const phone = record({ mergeRank: 50, updatedAt: '2026-08-15T12:00:00.000Z' })

    expect(resolveRecordConflict(desktop, phone)).toBe('accept')
    expect(resolveRecordConflict(phone, desktop)).toBe('keep-existing')
  })

  it('falls back to time when both have studied equally', () => {
    const earlier = record({ mergeRank: 7, updatedAt: '2026-08-15T12:00:00.000Z' })
    const later = record({ mergeRank: 7, updatedAt: '2026-08-15T12:00:01.000Z' })

    expect(resolveRecordConflict(earlier, later)).toBe('accept')
    expect(resolveRecordConflict(later, earlier)).toBe('keep-existing')
  })

  it('treats an identical rewrite as a no-op, so a retried push is safe', () => {
    expect(resolveRecordConflict(record({ mergeRank: 3 }), record({ mergeRank: 3 }))).toBe('keep-existing')
  })

  it('lets a newer deletion through even for a heavily studied card', () => {
    const studied = record({ mergeRank: 500, updatedAt: '2026-08-15T12:00:00.000Z' })
    const removal = record({ mergeRank: 0, deleted: true, updatedAt: '2026-08-15T12:00:01.000Z' })

    expect(resolveRecordConflict(studied, removal)).toBe('accept')
  })

  it('does not resurrect a card with a write older than its deletion', () => {
    const removal = record({ deleted: true, updatedAt: '2026-08-15T13:00:00.000Z' })
    const stale = record({ mergeRank: 99, updatedAt: '2026-08-15T12:00:00.000Z' })

    expect(resolveRecordConflict(removal, stale)).toBe('keep-existing')
  })

  it('does let a genuinely newer write undo a deletion', () => {
    const removal = record({ deleted: true, updatedAt: '2026-08-15T12:00:00.000Z' })
    const readded = record({ updatedAt: '2026-08-15T14:00:00.000Z' })

    expect(resolveRecordConflict(removal, readded)).toBe('accept')
  })

  it('treats an unreadable timestamp as the oldest possible', () => {
    const good = record({ updatedAt: '2026-08-15T12:00:00.000Z' })
    const broken = record({ updatedAt: 'not a date' })

    expect(resolveRecordConflict(good, broken)).toBe('keep-existing')
  })
})

describe('validateRecordEnvelope', () => {
  it('accepts a well-formed record', () => {
    expect(validateRecordEnvelope(record())).toBeNull()
    expect(validateRecordEnvelope(record({ blobRefs: ['a'.repeat(64)] }))).toBeNull()
  })

  it('rejects an unsupported kind', () => {
    expect(validateRecordEnvelope(record({ kind: 'settings' as never }))).toMatchObject({
      reason: 'kind is not supported.',
    })
  })

  it('rejects a missing or oversized id', () => {
    expect(validateRecordEnvelope(record({ recordId: '  ' }))?.reason).toBe('recordId is required.')
    expect(validateRecordEnvelope(record({ recordId: 'x'.repeat(201) }))?.reason).toBe('recordId is too long.')
  })

  it('rejects an unusable timestamp or rank', () => {
    expect(validateRecordEnvelope(record({ updatedAt: 'soon' }))?.reason).toBe('updatedAt must be a valid timestamp.')
    expect(validateRecordEnvelope(record({ mergeRank: -1 }))?.reason).toBe('mergeRank must be a non-negative integer.')
    expect(validateRecordEnvelope(record({ mergeRank: 1.5 }))?.reason).toBe('mergeRank must be a non-negative integer.')
  })

  it('rejects blob references that are not content hashes', () => {
    expect(validateRecordEnvelope(record({ blobRefs: ['nope'] }))?.reason).toBe('blobRefs must be sha256 hashes.')
    expect(validateRecordEnvelope(record({ blobRefs: 'a'.repeat(64) as never }))?.reason).toBe(
      'blobRefs must be an array.'
    )
  })

  it('reports which record in a batch was bad', () => {
    expect(validateRecordEnvelope(null, 4)).toEqual({ index: 4, reason: 'record must be an object.' })
  })
})

describe('dedupeRecordBatch', () => {
  it('keeps one write per record, independent of queue order', () => {
    const low = record({ mergeRank: 1, updatedAt: '2026-08-15T12:00:00.000Z' })
    const high = record({ mergeRank: 9, updatedAt: '2026-08-15T12:00:00.000Z' })

    expect(dedupeRecordBatch([low, high])).toEqual([high])
    expect(dedupeRecordBatch([high, low])).toEqual([high])
  })

  it('leaves different records alone', () => {
    const batch = [record({ recordId: 'a' }), record({ recordId: 'b' }), record({ kind: 'deck', recordId: 'a' })]
    expect(dedupeRecordBatch(batch)).toHaveLength(3)
  })
})

describe('nextCursorFrom', () => {
  it('advances to the highest version in the page', () => {
    const page = [
      { ...record(), version: 7 },
      { ...record(), version: 12 },
      { ...record(), version: 9 },
    ]
    expect(nextCursorFrom(page, 3)).toBe(12)
  })

  it('keeps the current cursor for an empty page', () => {
    expect(nextCursorFrom([], 42)).toBe(42)
  })
})

describe('collectBlobRefs', () => {
  it('gathers every hash a page needs, once each', () => {
    const a = 'a'.repeat(64)
    const b = 'b'.repeat(64)
    const page = [
      { blobRefs: [a, b], deleted: false },
      { blobRefs: [a], deleted: false },
    ]

    expect(collectBlobRefs(page).sort()).toEqual([a, b])
  })

  it('ignores files a deleted record used to reference', () => {
    expect(collectBlobRefs([{ blobRefs: ['a'.repeat(64)], deleted: true }])).toEqual([])
  })

  it('normalises case so the same file is not fetched twice', () => {
    const page = [
      { blobRefs: ['A'.repeat(64)], deleted: false },
      { blobRefs: ['a'.repeat(64)], deleted: false },
    ]
    expect(collectBlobRefs(page)).toEqual(['a'.repeat(64)])
  })
})
