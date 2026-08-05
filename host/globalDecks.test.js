import { describe, expect, it } from 'vitest'

import {
  GLOBAL_DECK_LIMITS,
  globalDeckResponse,
  normalizeGlobalDeckPublish,
  normalizeGlobalDeckSearch,
} from './globalDecks.js'

describe('global deck publishing', () => {
  it('keeps only shareable card content and normalizes note types', () => {
    expect(
      normalizeGlobalDeckPublish({
        publisherId: 'install-1',
        sourceDeckId: 'local-1',
        name: ' Biology ',
        cards: [{ frontHtml: 'Q', backHtml: 'A', tags: ['chapter-1'], noteType: 'unknown', reps: 99 }],
      })
    ).toEqual({
      publisherId: 'install-1',
      sourceDeckId: 'local-1',
      name: 'Biology',
      cards: [{ frontHtml: 'Q', backHtml: 'A', tags: ['chapter-1'], noteType: 'basic' }],
    })
  })

  it('rejects empty and oversized decks', () => {
    expect(() => normalizeGlobalDeckPublish({ publisherId: 'a', sourceDeckId: 'b', name: 'Deck', cards: [] })).toThrow(/at least/)
    expect(() =>
      normalizeGlobalDeckPublish({
        publisherId: 'a',
        sourceDeckId: 'b',
        name: 'Deck',
        cards: Array.from({ length: GLOBAL_DECK_LIMITS.maxCards + 1 }, () => ({ frontHtml: 'Q', backHtml: 'A' })),
      })
    ).toThrow(/at most/)
  })

  it('bounds search text and formats viewer heart state', () => {
    expect(normalizeGlobalDeckSearch(`  ${'x'.repeat(200)}  `)).toHaveLength(GLOBAL_DECK_LIMITS.maxSearchLength)
    const now = new Date('2026-08-05T12:00:00.000Z')
    expect(
      globalDeckResponse({ id: '1', name: 'Deck', cardCount: 2, publishedAt: now, updatedAt: now, hearts: [{}], _count: { hearts: 4 } })
    ).toMatchObject({ heartCount: 4, viewerHearted: true })
  })
})
