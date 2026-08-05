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
        decks: [{
          sourceDeckId: 'local-1',
          parentSourceDeckId: null,
          name: 'Biology',
          cards: [{ frontHtml: 'Q', backHtml: 'A', tags: ['chapter-1'], noteType: 'unknown', reps: 99 }],
        }],
        media: [],
      })
    ).toEqual({
      publisherId: 'install-1',
      sourceDeckId: 'local-1',
      name: 'Biology',
      decks: [{
        sourceDeckId: 'local-1',
        parentSourceDeckId: null,
        name: 'Biology',
        cards: [{ frontHtml: 'Q', backHtml: 'A', tags: ['chapter-1'], noteType: 'basic' }],
      }],
      media: [],
      cardCount: 1,
    })
  })

  it('rejects empty and oversized decks', () => {
    expect(() => normalizeGlobalDeckPublish({
      publisherId: 'a', sourceDeckId: 'b', name: 'Deck',
      decks: [{ sourceDeckId: 'b', parentSourceDeckId: null, name: 'Deck', cards: [] }], media: [],
    })).toThrow(/at least/)
    expect(() =>
      normalizeGlobalDeckPublish({
        publisherId: 'a',
        sourceDeckId: 'b',
        name: 'Deck',
        decks: [{
          sourceDeckId: 'b', parentSourceDeckId: null, name: 'Deck',
          cards: Array.from({ length: GLOBAL_DECK_LIMITS.maxCards + 1 }, () => ({ frontHtml: 'Q', backHtml: 'A' })),
        }],
        media: [],
      })
    ).toThrow(/at most/)
  })

  it('preserves subdecks and validates media metadata', () => {
    const sha256 = 'a'.repeat(64)
    const value = normalizeGlobalDeckPublish({
      publisherId: 'a', sourceDeckId: 'root', name: 'Root',
      decks: [
        { sourceDeckId: 'root', parentSourceDeckId: null, name: 'Root', cards: [] },
        { sourceDeckId: 'child', parentSourceDeckId: 'root', name: 'Child', cards: [{ frontHtml: 'Q', backHtml: 'A' }] },
      ],
      media: [{ sourceMediaId: 'media-1', sha256, mimeType: 'image/png', byteSize: 4, originalName: 'x.png' }],
    })
    expect(value.decks[1]).toMatchObject({ parentSourceDeckId: 'root', name: 'Child' })
    expect(value.media[0]).toMatchObject({ sourceMediaId: 'media-1', sha256 })
  })

  it('bounds search text and formats viewer heart state', () => {
    expect(normalizeGlobalDeckSearch(`  ${'x'.repeat(200)}  `)).toHaveLength(GLOBAL_DECK_LIMITS.maxSearchLength)
    const now = new Date('2026-08-05T12:00:00.000Z')
    expect(
      globalDeckResponse({ id: '1', name: 'Deck', cardCount: 2, publishedAt: now, updatedAt: now, hearts: [{}], _count: { hearts: 4 } })
    ).toMatchObject({ heartCount: 4, viewerHearted: true })
  })
})
