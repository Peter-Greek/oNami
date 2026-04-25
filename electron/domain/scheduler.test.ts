import { describe, expect, it } from 'vitest'

import { selectCardsForMode } from './scheduler'
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
})
