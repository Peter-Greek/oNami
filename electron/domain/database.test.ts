import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { OnamiDatabase } from './database'

const createTestDatabase = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onami-db-'))
  const db = new OnamiDatabase(path.join(dir, 'onami.sqlite'), path.join(dir, 'media'))
  return { db, dir }
}

describe('OnamiDatabase.getStats', () => {
  it('aggregates review telemetry and supports deck scoping', () => {
    const { db, dir } = createTestDatabase()

    try {
      const studyDeck = db.createDeck({ name: 'Japanese' })
      const sideDeck = db.createDeck({ name: 'Side deck' })
      const hardCard = db.createCard({
        deckId: studyDeck.id,
        noteType: 'basic',
        frontHtml: 'inu',
        backHtml: 'dog',
      })
      const steadyCard = db.createCard({
        deckId: studyDeck.id,
        noteType: 'basic',
        frontHtml: 'neko',
        backHtml: 'cat',
      })
      const otherCard = db.createCard({
        deckId: sideDeck.id,
        noteType: 'basic',
        frontHtml: 'ao',
        backHtml: 'blue',
      })

      const now = new Date()
      const yesterday = new Date(now)
      yesterday.setDate(yesterday.getDate() - 1)
      yesterday.setHours(9, 30, 0, 0)
      const todayEarly = new Date(now)
      todayEarly.setHours(Math.max(now.getHours() - 1, 0), 5, 0, 0)
      const todayLate = new Date(now)
      todayLate.setHours(Math.max(now.getHours() - 1, 0), 35, 0, 0)

      db.upsertReviewState(hardCard.id, {
        dueAt: new Date(now.getTime() - 60_000).toISOString(),
        state: 'Review',
        stability: 4,
        difficulty: 6,
        elapsedDays: 1,
        scheduledDays: 1,
        learningSteps: 0,
        reps: 3,
        lapses: 1,
        successRate: 0.45,
        lastRating: 'easy',
        lastReviewedAt: todayEarly.toISOString(),
      })
      db.upsertReviewState(steadyCard.id, {
        dueAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
        state: 'Review',
        stability: 7,
        difficulty: 3,
        elapsedDays: 3,
        scheduledDays: 4,
        learningSteps: 0,
        reps: 2,
        lapses: 0,
        successRate: 0.95,
        lastRating: 'good',
        lastReviewedAt: todayLate.toISOString(),
      })
      db.upsertReviewState(otherCard.id, {
        dueAt: new Date(now.getTime() + 12 * 60 * 60_000).toISOString(),
        state: 'Review',
        stability: 6,
        difficulty: 4,
        elapsedDays: 2,
        scheduledDays: 2,
        learningSteps: 0,
        reps: 1,
        lapses: 0,
        successRate: 1,
        lastRating: 'good',
        lastReviewedAt: todayLate.toISOString(),
      })

      db.logReview({
        cardId: hardCard.id,
        reviewedAt: yesterday.toISOString(),
        rating: 'again',
        elapsedMs: 15_000,
        revealMs: 8_000,
        answerMs: 7_000,
        previousDueAt: null,
        nextDueAt: null,
      })
      db.logReview({
        cardId: hardCard.id,
        reviewedAt: todayEarly.toISOString(),
        rating: 'easy',
        elapsedMs: 12_000,
        revealMs: 5_000,
        answerMs: 7_000,
        previousDueAt: null,
        nextDueAt: null,
      })
      db.logReview({
        cardId: steadyCard.id,
        reviewedAt: todayLate.toISOString(),
        rating: 'good',
        elapsedMs: 9_000,
        revealMs: 4_000,
        answerMs: 5_000,
        previousDueAt: null,
        nextDueAt: null,
      })
      db.logReview({
        cardId: otherCard.id,
        reviewedAt: todayLate.toISOString(),
        rating: 'good',
        elapsedMs: 6_000,
        revealMs: 3_000,
        answerMs: 3_000,
        previousDueAt: null,
        nextDueAt: null,
      })

      const scoped = db.getStats(studyDeck.id)
      expect(scoped.scopeDeckId).toBe(studyDeck.id)
      expect(scoped.scopeDeckName).toBe('Japanese')
      expect(scoped.totalDecks).toBe(1)
      expect(scoped.totalCards).toBe(2)
      expect(scoped.newCards).toBe(0)
      expect(scoped.dueCards).toBe(1)
      expect(scoped.reviewedToday).toBe(2)
      expect(scoped.totalReviews).toBe(3)
      expect(scoped.studyTime.todayMs).toBe(21_000)
      expect(scoped.studyTime.overallMs).toBe(36_000)
      expect(scoped.streakDays).toBe(2)
      expect(scoped.longestStreakDays).toBe(2)
      expect(scoped.averageAgainToEasyMs).not.toBeNull()
      expect(scoped.completion.fullyLearned).toBe(true)
      expect(scoped.hardestCards[0]?.cardId).toBe(hardCard.id)

      const overall = db.getStats()
      expect(overall.scopeDeckId).toBeNull()
      expect(overall.totalDecks).toBe(3)
      expect(overall.totalCards).toBe(3)
      expect(overall.reviewedToday).toBe(3)
      expect(overall.totalReviews).toBe(4)
      expect(overall.studyTime.todayMs).toBe(27_000)
      expect(overall.studyTime.overallMs).toBe(42_000)
    } finally {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resets scheduling to the stored baseline without wiping streak or study time history', () => {
    const { db, dir } = createTestDatabase()

    try {
      const studyDeck = db.createDeck({ name: 'Reset deck' })
      const importedCard = db.createCard({
        deckId: studyDeck.id,
        noteType: 'basic',
        frontHtml: 'mizu',
        backHtml: 'water',
      })

      const importedSeed = {
        dueAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
        state: 'Review' as const,
        stability: 5,
        difficulty: 4,
        elapsedDays: 2,
        scheduledDays: 3,
        learningSteps: 0,
        reps: 4,
        lapses: 0,
        successRate: 0.8,
        lastRating: 'good' as const,
        lastReviewedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      }
      db.upsertReviewStateSeed(importedCard.id, importedSeed)
      db.upsertReviewState(importedCard.id, {
        dueAt: new Date(Date.now() - 60_000).toISOString(),
        state: 'Relearning',
        stability: 1,
        difficulty: 8,
        elapsedDays: 0,
        scheduledDays: 0,
        learningSteps: 1,
        reps: 9,
        lapses: 3,
        successRate: 0.32,
        lastRating: 'again',
        lastReviewedAt: new Date().toISOString(),
      })

      const reviewedAt = new Date()
      reviewedAt.setHours(Math.max(reviewedAt.getHours() - 1, 0), 10, 0, 0)
      db.logReview({
        cardId: importedCard.id,
        reviewedAt: reviewedAt.toISOString(),
        rating: 'again',
        elapsedMs: 18_000,
        revealMs: 10_000,
        answerMs: 8_000,
        previousDueAt: null,
        nextDueAt: null,
      })

      const beforeReset = db.getStats(studyDeck.id)
      expect(beforeReset.totalReviews).toBe(1)
      expect(beforeReset.studyTime.todayMs).toBe(18_000)
      expect(beforeReset.hardestCards[0]?.cardId).toBe(importedCard.id)

      db.resetDeckScheduling(studyDeck.id)

      const reviewState = db.getReviewState(importedCard.id)
      expect(reviewState).toEqual(importedSeed)

      const afterReset = db.getStats(studyDeck.id)
      expect(afterReset.totalReviews).toBe(0)
      expect(afterReset.studyTime.todayMs).toBe(18_000)
      expect(afterReset.studyTime.overallMs).toBe(18_000)
      expect(afterReset.reviewedToday).toBe(1)
      expect(afterReset.streakDays).toBe(1)
      expect(afterReset.averageReviewMs).toBe(0)
      expect(afterReset.averageRevealMs).toBe(0)
      expect(afterReset.hardestCards).toHaveLength(0)
      expect(afterReset.dueCards).toBe(0)
      expect(afterReset.newCards).toBe(0)
    } finally {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('OnamiDatabase sync events', () => {
  it('queues local events and marks them pushed', () => {
    const { db, dir } = createTestDatabase()

    try {
      const deck = db.createDeck({ name: 'Sync source' })
      const event = db.enqueueSyncEvent({
        deviceId: 'desktop-device',
        entityType: 'deck',
        entityId: deck.id,
        eventType: 'deck.upsert',
        payload: db.buildDeckSyncPayload(deck.id),
      })

      expect(event.sequence).toBe(1)
      expect(db.getPendingSyncEventCount()).toBe(1)
      expect(db.listPendingSyncEvents()).toHaveLength(1)

      db.markSyncEventsPushed([event.eventId])

      expect(db.getPendingSyncEventCount()).toBe(0)
    } finally {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('applies remote deck, card, and review events once', () => {
    const source = createTestDatabase()
    const target = createTestDatabase()

    try {
      const deck = source.db.createDeck({ name: 'Remote deck' })
      const card = source.db.createCard({
        deckId: deck.id,
        noteType: 'basic',
        frontHtml: 'kaze',
        backHtml: 'wind',
        tags: ['noun'],
      })

      const deckApplied = target.db.applyRemoteSyncEvent({
        hostEventId: 1,
        eventId: 'event-deck',
        sourceDeviceId: 'phone-device',
        sequence: 1,
        entityType: 'deck',
        entityId: deck.id,
        eventType: 'deck.upsert',
        payload: source.db.buildDeckSyncPayload(deck.id),
        createdAt: new Date().toISOString(),
      })
      const cardApplied = target.db.applyRemoteSyncEvent({
        hostEventId: 2,
        eventId: 'event-card',
        sourceDeviceId: 'phone-device',
        sequence: 2,
        entityType: 'card',
        entityId: card.id,
        eventType: 'card.upsert',
        payload: source.db.buildCardSyncPayload(card.id),
        createdAt: new Date().toISOString(),
      })

      source.db.upsertReviewState(card.id, {
        dueAt: '2026-07-07T00:00:00.000Z',
        state: 'Review',
        stability: 3,
        difficulty: 5,
        elapsedDays: 1,
        scheduledDays: 1,
        learningSteps: 0,
        reps: 1,
        lapses: 0,
        successRate: 1,
        lastRating: 'good',
        lastReviewedAt: '2026-07-06T12:00:00.000Z',
      })
      const reviewApplied = target.db.applyRemoteSyncEvent({
        hostEventId: 3,
        eventId: 'event-review',
        sourceDeviceId: 'phone-device',
        sequence: 3,
        entityType: 'review',
        entityId: card.id,
        eventType: 'review.answer',
        payload: source.db.buildReviewAnswerSyncPayload({
          cardId: card.id,
          reviewedAt: '2026-07-06T12:00:00.000Z',
          rating: 'good',
          elapsedMs: 1200,
          revealMs: 500,
          answerMs: 700,
          previousDueAt: null,
          nextDueAt: '2026-07-07T00:00:00.000Z',
        }),
        createdAt: new Date().toISOString(),
      })

      expect(deckApplied).toBe(true)
      expect(cardApplied).toBe(true)
      expect(reviewApplied).toBe(true)
      expect(target.db.getDeckSummary(deck.id).name).toBe('Remote deck')
      expect(target.db.getCard(card.id).frontHtml).toBe('kaze')
      expect(target.db.getReviewState(card.id)?.reps).toBe(1)

      expect(
        target.db.applyRemoteSyncEvent({
          hostEventId: 3,
          eventId: 'event-review',
          sourceDeviceId: 'phone-device',
          sequence: 3,
          entityType: 'review',
          entityId: card.id,
          eventType: 'review.answer',
          payload: source.db.buildReviewAnswerSyncPayload({
            cardId: card.id,
            reviewedAt: '2026-07-06T12:00:00.000Z',
            rating: 'good',
            elapsedMs: 1200,
            revealMs: 500,
            answerMs: 700,
            previousDueAt: null,
            nextDueAt: '2026-07-07T00:00:00.000Z',
          }),
          createdAt: new Date().toISOString(),
        })
      ).toBe(false)
    } finally {
      source.db.close()
      target.db.close()
      fs.rmSync(source.dir, { recursive: true, force: true })
      fs.rmSync(target.dir, { recursive: true, force: true })
    }
  })
})
