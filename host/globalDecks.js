const NOTE_TYPES = new Set(['basic', 'cloze', 'imported'])

export const GLOBAL_DECK_LIMITS = {
  maxCards: 5000,
  maxNameLength: 120,
  maxHtmlLength: 100_000,
  maxTagsPerCard: 100,
  maxTagLength: 200,
  maxSearchLength: 120,
}

const badRequest = (message) => Object.assign(new Error(message), { status: 400 })

const requiredText = (value, label, maxLength) => {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${label} is required.`)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw badRequest(`${label} is too long.`)
  return normalized
}

export const normalizeGlobalDeckCards = (value) => {
  if (!Array.isArray(value) || value.length === 0) throw badRequest('cards must contain at least one card.')
  if (value.length > GLOBAL_DECK_LIMITS.maxCards) {
    throw badRequest(`A global deck may contain at most ${GLOBAL_DECK_LIMITS.maxCards} cards.`)
  }

  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw badRequest(`cards[${index}] must be an object.`)
    }
    const frontHtml = typeof raw.frontHtml === 'string' ? raw.frontHtml : ''
    const backHtml = typeof raw.backHtml === 'string' ? raw.backHtml : ''
    if (!frontHtml.trim() && !backHtml.trim()) throw badRequest(`cards[${index}] has no content.`)
    if (frontHtml.length > GLOBAL_DECK_LIMITS.maxHtmlLength || backHtml.length > GLOBAL_DECK_LIMITS.maxHtmlLength) {
      throw badRequest(`cards[${index}] is too large.`)
    }
    const tags = Array.isArray(raw.tags)
      ? raw.tags
          .filter((tag) => typeof tag === 'string')
          .slice(0, GLOBAL_DECK_LIMITS.maxTagsPerCard)
          .map((tag) => tag.slice(0, GLOBAL_DECK_LIMITS.maxTagLength))
      : []
    return {
      frontHtml,
      backHtml,
      tags,
      noteType: NOTE_TYPES.has(raw.noteType) ? raw.noteType : 'basic',
    }
  })
}

export const normalizeGlobalDeckPublish = (body) => ({
  publisherId: requiredText(body?.publisherId, 'publisherId', 200),
  sourceDeckId: requiredText(body?.sourceDeckId, 'sourceDeckId', 200),
  name: requiredText(body?.name, 'name', GLOBAL_DECK_LIMITS.maxNameLength),
  cards: normalizeGlobalDeckCards(body?.cards),
})

export const normalizeGlobalDeckSearch = (value) =>
  typeof value === 'string' ? value.trim().slice(0, GLOBAL_DECK_LIMITS.maxSearchLength) : ''

export const globalDeckResponse = (row) => ({
  id: row.id,
  name: row.name,
  cardCount: row.cardCount,
  heartCount: row._count?.hearts ?? 0,
  viewerHearted: Array.isArray(row.hearts) && row.hearts.length > 0,
  publishedAt: row.publishedAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  ...(row.cardsJson === undefined ? {} : { cards: row.cardsJson }),
})
