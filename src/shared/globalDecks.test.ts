import { describe, expect, it, vi, afterEach } from 'vitest'

import {
  buildGlobalDeckListPath,
  createGlobalDecksClient,
  toGlobalDeckCard,
  toGlobalDeckDetail,
  toGlobalDeckHeartResult,
  toGlobalDeckSummary,
} from './globalDecks'

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const jsonResponse = (body: unknown, ok = true, status = 200) =>
  ({
    ok,
    status,
    text: async () => JSON.stringify(body),
  }) as Response

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('toGlobalDeckSummary', () => {
  it('reads a well-formed row', () => {
    expect(
      toGlobalDeckSummary({
        id: 'deck-1',
        name: 'Kanji N5',
        cardCount: 120,
        heartCount: 7,
        viewerHearted: true,
        publishedAt: '2026-01-02T03:04:05.000Z',
        updatedAt: '2026-02-02T03:04:05.000Z',
      })
    ).toEqual({
      id: 'deck-1',
      name: 'Kanji N5',
      cardCount: 120,
      heartCount: 7,
      viewerHearted: true,
      publishedAt: '2026-01-02T03:04:05.000Z',
      updatedAt: '2026-02-02T03:04:05.000Z',
    })
  })

  it('rejects rows without an id or name', () => {
    expect(toGlobalDeckSummary({ name: 'No id' })).toBeNull()
    expect(toGlobalDeckSummary({ id: 'deck-1', name: '   ' })).toBeNull()
    expect(toGlobalDeckSummary(null)).toBeNull()
  })

  it('defaults counts and falls back to publishedAt for updatedAt', () => {
    const summary = toGlobalDeckSummary({
      id: 'deck-1',
      name: 'Deck',
      cardCount: 'many',
      heartCount: -4,
      publishedAt: '2026-01-02T03:04:05.000Z',
    })
    expect(summary).toMatchObject({
      cardCount: 0,
      heartCount: 0,
      viewerHearted: false,
      updatedAt: '2026-01-02T03:04:05.000Z',
    })
  })
})

describe('toGlobalDeckCard', () => {
  it('keeps content and coerces the note type', () => {
    expect(toGlobalDeckCard({ frontHtml: 'q', backHtml: 'a', tags: ['x', 2], noteType: 'cloze' })).toEqual({
      frontHtml: 'q',
      backHtml: 'a',
      tags: ['x'],
      noteType: 'cloze',
    })
    expect(toGlobalDeckCard({ frontHtml: 'q', backHtml: 'a', noteType: 'weird' })).toMatchObject({
      noteType: 'basic',
      tags: [],
    })
  })

  it('drops cards with no content at all', () => {
    expect(toGlobalDeckCard({ frontHtml: '  ', backHtml: '' })).toBeNull()
  })
})

describe('toGlobalDeckDetail', () => {
  it('drops malformed cards and counts what actually arrived', () => {
    const detail = toGlobalDeckDetail({
      id: 'deck-1',
      name: 'Deck',
      cardCount: 9,
      publishedAt: '2026-01-02T03:04:05.000Z',
      cards: [{ frontHtml: 'q', backHtml: 'a' }, null, { frontHtml: '', backHtml: '' }],
    })
    expect(detail?.cards).toHaveLength(1)
    expect(detail?.cardCount).toBe(1)
  })
})

describe('toGlobalDeckHeartResult', () => {
  it('falls back to the requested state when the host says nothing', () => {
    expect(toGlobalDeckHeartResult({}, { id: 'deck-1', hearted: true })).toEqual({
      id: 'deck-1',
      heartCount: 0,
      viewerHearted: true,
    })
  })
})

describe('buildGlobalDeckListPath', () => {
  it('always sends the heart sort and the installation id', () => {
    expect(buildGlobalDeckListPath('  kanji ', 'install-1')).toBe(
      '/global-decks?search=kanji&sort=hearts&installationId=install-1'
    )
  })
})

describe('createGlobalDecksClient', () => {
  it('lists decks in host order and skips unusable rows', async () => {
    const fetchMock = vi.fn<FetchFn>(async () =>
      jsonResponse({
        decks: [
          { id: 'b', name: 'Second', heartCount: 3, publishedAt: '2026-01-01T00:00:00.000Z' },
          { id: '', name: 'Broken' },
          { id: 'a', name: 'First', heartCount: 9, publishedAt: '2026-01-01T00:00:00.000Z' },
        ],
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const client = createGlobalDecksClient({ installationId: () => 'install-1' })
    const decks = await client.list('kanji')

    expect(decks.map((deck) => deck.id)).toEqual(['b', 'a'])
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/global-decks?search=kanji&sort=hearts&installationId=install-1'
    )
  })

  it('publishes card content only, under the installation id', async () => {
    const fetchMock = vi.fn<FetchFn>(async () =>
      jsonResponse({ id: 'deck-1', name: 'Deck', cardCount: 1, publishedAt: '2026-01-01T00:00:00.000Z' })
    )
    vi.stubGlobal('fetch', fetchMock)

    const client = createGlobalDecksClient({ installationId: () => 'install-1' })
    await client.publish({
      sourceDeckId: 'local-1',
      name: 'Deck',
      cards: [{ frontHtml: 'q', backHtml: 'a', tags: [], noteType: 'basic' }],
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body).toEqual({
      publisherId: 'install-1',
      sourceDeckId: 'local-1',
      name: 'Deck',
      cards: [{ frontHtml: 'q', backHtml: 'a', tags: [], noteType: 'basic' }],
    })
  })

  it('surfaces the host error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Deck name taken.' }, false, 409)))

    const client = createGlobalDecksClient({ installationId: () => 'install-1' })
    await expect(client.heart('deck-1', true)).rejects.toThrow('Deck name taken.')
  })
})
