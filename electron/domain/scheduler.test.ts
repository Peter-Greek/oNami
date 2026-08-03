import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { OnamiDatabase } from './database'
import { SchedulerService, selectCardsForMode, type StudySessionRuntime } from './scheduler'
import type { CardSummary } from '../../src/shared/types'

const card = (
  id: string,
  state: CardSummary['state'],
  dueAt: string | null = null,
  templateOrd = 0
): CardSummary => ({
  id,
  noteId: `note-${id}`,
  deckId: 'deck-1',
  deckName: 'Deck',
  templateOrd,
  frontHtml: `front ${id}`,
  backHtml: `back ${id}`,
  tags: [],
  state,
  dueAt,
  reps: state === 'New' ? 0 : 2,
  lapses: 0,
  successRate: state === 'New' ? 0 : 0.75,
  lastRating: null,
  lastReviewedAt: null,
})

describe('selectCardsForMode', () => {
  const past = new Date(Date.now() - 60_000).toISOString()
  const future = new Date(Date.now() + 24 * 60 * 60_000).toISOString()
  const cards = [
    card('new-1', 'New'),
    card('new-2', 'New'),
    card('due-1', 'Review', past),
    card('due-2', 'Learning', past),
    card('future-1', 'Review', future),
  ]

  it('keeps learn-new focused on unseen cards', () => {
    const selected = selectCardsForMode(cards, 'learn-new', { limit: 10 })
    expect(selected.map((item) => item.id)).toEqual(['new-1', 'new-2'])
  })

  it('keeps review-due focused on cards due now or earlier', () => {
    const selected = selectCardsForMode(cards, 'review-due', { limit: 10 })
    expect(selected.map((item) => item.id)).toEqual(['due-1', 'due-2'])
  })

  it('injects new cards into mixed review sessions', () => {
    const selected = selectCardsForMode(cards, 'mixed', { limit: 4, newEvery: 2 })
    expect(selected.map((item) => item.id)).toEqual(['due-1', 'due-2', 'new-1', 'new-2'])
  })

  it('groups new imported sibling cards by template before study', () => {
    const selected = selectCardsForMode(
      [
        card('note-1-front', 'New', null, 0),
        card('note-1-back', 'New', null, 1),
        card('note-2-front', 'New', null, 0),
        card('note-2-back', 'New', null, 1),
      ],
      'learn-new',
      { limit: 4 }
    )

    expect(selected.map((item) => item.id)).toEqual([
      'note-1-front',
      'note-2-front',
      'note-1-back',
      'note-2-back',
    ])
  })

  it('includes every card in a shuffled unit test even when legacy limits are supplied', () => {
    const testCards = Array.from({ length: 100 }, (_, index) => card(`card-${index}`, 'New'))
    const selected = selectCardsForMode(
      testCards,
      'unit-test',
      { limit: 10, unitTestEvery: 20 },
      () => 0
    )

    expect(selected).toHaveLength(100)
    expect(new Set(selected.map((item) => item.id))).toEqual(new Set(testCards.map((item) => item.id)))
    expect(selected.map((item) => item.id)).not.toEqual(testCards.map((item) => item.id))
  })
})

describe('SchedulerService unit tests', () => {
  it('records a perfect score after all 100 cards are answered Easy without adding reviews', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onami-perfect-unit-test-'))
    const db = new OnamiDatabase(path.join(dir, 'onami.sqlite'), path.join(dir, 'media'))

    try {
      const deck = db.createDeck({ name: 'Perfect unit test' })
      const cardIds = Array.from({ length: 100 }, (_, index) =>
        db.createCard({
          deckId: deck.id,
          noteType: 'basic',
          frontHtml: `front ${index}`,
          backHtml: `back ${index}`,
        }).id
      )
      const session: StudySessionRuntime = {
        id: 'perfect-unit-session',
        mode: 'unit-test',
        deckId: deck.id,
        cardIds,
        answered: [],
        unitTestThreshold: 0.8,
      }
      const scheduler = new SchedulerService(db)
      let result = scheduler.answer(
        { sessionId: session.id, cardId: cardIds[0], rating: 'easy' },
        session
      )

      for (const cardId of cardIds.slice(1)) {
        result = scheduler.answer({ sessionId: session.id, cardId, rating: 'easy' }, session)
      }

      expect(result).toMatchObject({ sessionComplete: true, unitScore: 1 })
      expect(db.getDeckSummary(deck.id).unitTestScore).toBe(1)
      expect(db.getStats(deck.id)).toMatchObject({ totalReviews: 0, dueCards: 0 })
    } finally {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records only Easy as correct, keeps normal review analytics unchanged, and makes Hard review-due', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onami-scheduler-'))
    const db = new OnamiDatabase(path.join(dir, 'onami.sqlite'), path.join(dir, 'media'))

    try {
      const deck = db.createDeck({ name: 'Unit test deck' })
      const easyCard = db.createCard({
        deckId: deck.id,
        noteType: 'basic',
        frontHtml: 'easy front',
        backHtml: 'easy back',
      })
      const hardCard = db.createCard({
        deckId: deck.id,
        noteType: 'basic',
        frontHtml: 'hard front',
        backHtml: 'hard back',
      })
      const session: StudySessionRuntime = {
        id: 'unit-session',
        mode: 'unit-test',
        deckId: deck.id,
        cardIds: [easyCard.id, hardCard.id],
        answered: [],
        unitTestThreshold: 0.8,
      }
      const scheduler = new SchedulerService(db)

      const first = scheduler.answer(
        { sessionId: session.id, cardId: easyCard.id, rating: 'easy' },
        session
      )
      const result = scheduler.answer(
        { sessionId: session.id, cardId: hardCard.id, rating: 'hard' },
        session
      )

      expect(first.sessionComplete).toBe(false)
      expect(result.sessionComplete).toBe(true)
      expect(result.unitScore).toBe(0.5)
      expect(db.getDeckSummary(deck.id).unitTestScore).toBe(0.5)
      expect(db.getStats(deck.id).totalReviews).toBe(0)
      expect(db.getStats(deck.id).studyTime.overallMs).toBe(0)
      expect(db.getStats(deck.id).dueCards).toBe(1)
      expect(db.getReviewState(easyCard.id)?.state).toBe('New')
      expect(db.getReviewState(hardCard.id)?.state).toBe('Learning')
      expect(Date.parse(db.getReviewState(hardCard.id)?.dueAt ?? '')).toBeLessThanOrEqual(Date.now())
      expect(
        selectCardsForMode(db.getDeck(deck.id).cards, 'review-due', { limit: 10 }).map((item) => item.id)
      ).toContain(hardCard.id)
      expect(() =>
        scheduler.answer(
          { sessionId: session.id, cardId: easyCard.id, rating: 'good' },
          { ...session, answered: [] }
        )
      ).toThrow('Unit test answers must be Hard or Easy.')
    } finally {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
