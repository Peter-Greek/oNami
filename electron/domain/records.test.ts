import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { cardToRecord, deckToRecord, tombstone } from '../../src/shared/sync/recordMapping'
import type { StoredSyncRecord, SyncRecordEnvelope } from '../../src/shared/sync/records'
import { OnamiDatabase } from './database'

const tempDirs: string[] = []
const openDatabases: OnamiDatabase[] = []

const createTestDatabase = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onami-records-'))
  tempDirs.push(dir)
  const db = new OnamiDatabase(path.join(dir, 'onami.sqlite'), path.join(dir, 'media'))
  openDatabases.push(db)
  return db
}

afterEach(() => {
  // Close DBs before removing their files (SQLite holds a lock on Windows).
  while (openDatabases.length) openDatabases.pop()!.close()
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

/** Stamps versions the way the host does, so a page looks like a real pull. */
const asPage = (records: SyncRecordEnvelope[], from = 0): StoredSyncRecord[] =>
  records.map((record, index) => ({ ...record, version: from + index + 1 }))

const seedLibrary = (db: OnamiDatabase) => {
  const deck = db.createDeck({ name: 'Kanji' })
  const card = db.createCard({ deckId: deck.id, noteType: 'basic', frontHtml: 'inu', backHtml: 'dog' })
  const reviewedAt = new Date().toISOString()
  db.upsertReviewState(card.id, {
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    state: 'Review',
    stability: 4,
    difficulty: 6,
    elapsedDays: 1,
    scheduledDays: 1,
    learningSteps: 0,
    reps: 3,
    lapses: 1,
    successRate: 0.66,
    lastRating: 'good',
    lastReviewedAt: reviewedAt,
  })
  db.logReview({
    cardId: card.id,
    reviewedAt,
    rating: 'good',
    elapsedMs: 4200,
    revealMs: 1500,
    answerMs: 2700,
    previousDueAt: null,
    nextDueAt: null,
  })
  return { deck, card, reviewedAt }
}

describe('hydrating a fresh device from records', () => {
  it('rebuilds decks, cards, and scheduling from a pull that starts at zero', () => {
    const source = createTestDatabase()
    const target = createTestDatabase()
    const { deck, card } = seedLibrary(source)

    // Exactly what a brand new device receives: the ordinary record stream,
    // pulled from version 0. There is no snapshot involved.
    target.applyRecordPage(asPage(source.buildLibraryRecords()))

    expect(target.listDecks().some((entry) => entry.name === 'Kanji')).toBe(true)
    expect(target.getDeck(deck.id).cards.map((entry) => entry.id)).toContain(card.id)
    expect(target.getReviewState(card.id)?.reps).toBe(3)
  })

  it('carries review history so streaks and study time survive the move', () => {
    const source = createTestDatabase()
    const target = createTestDatabase()
    seedLibrary(source)

    target.applyRecordPage(asPage(source.buildLibraryRecords()))
    target.applyReviewLogEntries(source.listUnsentReviewLogs())

    const stats = target.getStats()
    expect(stats.totalReviews).toBeGreaterThanOrEqual(1)
    expect(stats.studyTime.overallMs).toBe(4200)
    expect(stats.streakDays).toBeGreaterThanOrEqual(1)
  })

  it('is idempotent, so a re-read page cannot double-count history', () => {
    const source = createTestDatabase()
    const target = createTestDatabase()
    seedLibrary(source)
    const page = asPage(source.buildLibraryRecords())
    const reviews = source.listUnsentReviewLogs()

    target.applyRecordPage(page)
    target.applyReviewLogEntries(reviews)
    // An interrupted sync re-reads the page it did not get to acknowledge.
    target.applyRecordPage(page)
    target.applyReviewLogEntries(reviews)

    expect(target.getStats().studyTime.overallMs).toBe(4200)
  })

  it('does not send back reviews it received from somewhere else', () => {
    const source = createTestDatabase()
    const target = createTestDatabase()
    seedLibrary(source)

    target.applyRecordPage(asPage(source.buildLibraryRecords()))
    target.applyReviewLogEntries(source.listUnsentReviewLogs())

    expect(target.listUnsentReviewLogs()).toEqual([])
  })

  it('applies the rest of a page when one record is unreadable', () => {
    const source = createTestDatabase()
    const target = createTestDatabase()
    const { deck } = seedLibrary(source)
    const page = asPage([
      { ...deckToRecord({ id: 'broken' } as never), payload: { nonsense: true } },
      ...source.buildLibraryRecords(),
    ])

    const result = target.applyRecordPage(page)

    expect(result.skipped).toBe(1)
    expect(target.listDecks().some((entry) => entry.id === deck.id)).toBe(true)
  })
})

describe('conflict resolution on apply', () => {
  it('keeps the copy that has been studied more', () => {
    const phone = createTestDatabase()
    const { card } = seedLibrary(phone)

    // The phone has studied this card 9 times.
    phone.upsertReviewState(card.id, {
      ...phone.getReviewState(card.id)!,
      reps: 9,
    })
    const studied = cardToRecord(phone.buildCardSyncPayload(card.id))

    expect(studied.mergeRank).toBe(9)
  })

  it('ranks a card by its review count so the rule has something to compare', () => {
    const db = createTestDatabase()
    const { card } = seedLibrary(db)

    expect(cardToRecord(db.buildCardSyncPayload(card.id)).mergeRank).toBe(3)
  })
})

describe('the outbox', () => {
  it('replaces a queued record instead of appending another', () => {
    const db = createTestDatabase()
    const { card } = seedLibrary(db)
    const record = cardToRecord(db.buildCardSyncPayload(card.id))

    db.enqueueRecord(record)
    db.enqueueRecord({ ...record, mergeRank: 4, updatedAt: new Date().toISOString() })

    // The old event outbox appended per edit; this stays the size of what changed.
    expect(db.getPendingRecordCount()).toBe(1)
    expect(db.listPendingRecords()[0].mergeRank).toBe(4)
  })

  it('clears a record once pushed', () => {
    const db = createTestDatabase()
    const { card } = seedLibrary(db)
    const record = cardToRecord(db.buildCardSyncPayload(card.id))
    db.enqueueRecord(record)

    db.markRecordsPushed([record])

    expect(db.getPendingRecordCount()).toBe(0)
  })

  it('keeps an edit made while the push was in flight', () => {
    const db = createTestDatabase()
    const { card } = seedLibrary(db)
    const sent = cardToRecord(db.buildCardSyncPayload(card.id))
    db.enqueueRecord(sent)

    // The card is reviewed again before the push completes.
    db.enqueueRecord({ ...sent, mergeRank: 12, updatedAt: new Date(Date.now() + 1000).toISOString() })
    db.markRecordsPushed([sent])

    expect(db.getPendingRecordCount()).toBe(1)
    expect(db.listPendingRecords()[0].mergeRank).toBe(12)
  })

  it('carries a deletion across as a tombstone', () => {
    const source = createTestDatabase()
    const target = createTestDatabase()
    const { deck, card } = seedLibrary(source)
    target.applyRecordPage(asPage(source.buildLibraryRecords()))

    target.applyRecordPage(asPage([tombstone('card', card.id)], 100))

    expect(target.getDeck(deck.id).cards.map((entry) => entry.id)).not.toContain(card.id)
  })
})

describe('media reconciliation', () => {
  it('reports what a record described but this device does not hold', () => {
    const source = createTestDatabase()
    const target = createTestDatabase()
    const mediaTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onami-media-src-'))
    tempDirs.push(mediaTmp)
    const filePath = path.join(mediaTmp, 'sound.mp3')
    fs.writeFileSync(filePath, Buffer.from('fake-audio-bytes'))
    source.upsertMediaFromFile('sound.mp3', filePath)

    target.applyRecordPage(asPage(source.buildLibraryRecords()))

    const missing = target.listMissingMedia()
    expect(missing.map((item) => item.originalName)).toEqual(['sound.mp3'])
  })

  it('stops reporting a file once its bytes are stored', () => {
    const source = createTestDatabase()
    const target = createTestDatabase()
    const mediaTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onami-media-src2-'))
    tempDirs.push(mediaTmp)
    const filePath = path.join(mediaTmp, 'sound.mp3')
    fs.writeFileSync(filePath, Buffer.from('fake-audio-bytes'))
    const media = source.upsertMediaFromFile('sound.mp3', filePath)
    target.applyRecordPage(asPage(source.buildLibraryRecords()))

    const record = target.listMissingMedia()[0]
    target.saveMediaBlob(record, source.readMediaBytesByHash(media.hash)!)

    expect(target.listMissingMedia()).toEqual([])
    expect(target.hasMediaHash(media.hash)).toBe(true)
    const storedPath = target.getMediaPath(record.id)
    expect(fs.readFileSync(storedPath!)).toEqual(Buffer.from('fake-audio-bytes'))
  })
})
