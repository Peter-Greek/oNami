import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { OnamiDatabase } from './database'

const tempDirs: string[] = []
const openDatabases: OnamiDatabase[] = []

const createTestDatabase = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onami-snap-'))
  tempDirs.push(dir)
  const db = new OnamiDatabase(path.join(dir, 'onami.sqlite'), path.join(dir, 'media'))
  openDatabases.push(db)
  return db
}

afterEach(() => {
  // Close DBs before removing their files (SQLite holds a lock on Windows).
  while (openDatabases.length) {
    openDatabases.pop()!.close()
  }
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('OnamiDatabase full-snapshot hydration', () => {
  it('transfers decks, cards, review state, and review-log history to a fresh device', () => {
    const source = createTestDatabase()
    const target = createTestDatabase()

    const deck = source.createDeck({ name: 'Kanji' })
    const card = source.createCard({
      deckId: deck.id,
      noteType: 'basic',
      frontHtml: 'inu',
      backHtml: 'dog',
    })
    const reviewedAt = new Date().toISOString()
    source.upsertReviewState(card.id, {
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
    source.logReview({
      cardId: card.id,
      reviewedAt,
      rating: 'good',
      elapsedMs: 4200,
      revealMs: 1500,
      answerMs: 2700,
      previousDueAt: null,
      nextDueAt: null,
    })

    target.applySnapshot(source.buildFullSnapshot())

    expect(target.listDecks().some((entry) => entry.name === 'Kanji')).toBe(true)
    expect(target.getDeck(deck.id).cards.map((entry) => entry.id)).toContain(card.id)
    expect(target.getReviewState(card.id)?.reps).toBe(3)

    const stats = target.getStats()
    expect(stats.totalReviews).toBeGreaterThanOrEqual(1)
    expect(stats.studyTime.overallMs).toBe(4200)
    expect(stats.streakDays).toBeGreaterThanOrEqual(1)

    // Re-applying the same snapshot must not double-count the review-log history.
    target.applySnapshot(source.buildFullSnapshot())
    expect(target.getStats().studyTime.overallMs).toBe(4200)
  })

  it('round-trips a media blob by content hash', () => {
    const source = createTestDatabase()
    const target = createTestDatabase()
    const mediaTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onami-media-src-'))
    tempDirs.push(mediaTmp)

    const filePath = path.join(mediaTmp, 'sound.mp3')
    fs.writeFileSync(filePath, Buffer.from('fake-audio-bytes'))
    const media = source.upsertMediaFromFile('sound.mp3', filePath)

    const record = source.buildFullSnapshot().media.find((entry) => entry.sha256 === media.hash)
    expect(record).toBeTruthy()

    const bytes = source.readMediaBytesByHash(media.hash)
    expect(bytes).toBeTruthy()

    target.saveMediaBlob(record!, bytes!)
    expect(target.hasMediaHash(media.hash)).toBe(true)

    const storedPath = target.getMediaPath(record!.id)
    expect(storedPath && fs.existsSync(storedPath)).toBeTruthy()
    expect(fs.readFileSync(storedPath!)).toEqual(Buffer.from('fake-audio-bytes'))
  })
})
