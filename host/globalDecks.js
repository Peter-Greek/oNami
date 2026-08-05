const NOTE_TYPES = new Set(['basic', 'cloze', 'imported'])

export const GLOBAL_DECK_LIMITS = {
  maxCards: 5000,
  maxNameLength: 120,
  maxHtmlLength: 100_000,
  maxTagsPerCard: 100,
  maxTagLength: 200,
  maxSearchLength: 120,
  maxMedia: 2000,
  maxMediaBytes: 32 * 1024 * 1024,
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
  ...normalizeGlobalDeckEnvelope(body),
})

const normalizeGlobalDeckEnvelope = (body) => {
  const publisherId = requiredText(body?.publisherId, 'publisherId', 200)
  const sourceDeckId = requiredText(body?.sourceDeckId, 'sourceDeckId', 200)
  const name = requiredText(body?.name, 'name', GLOBAL_DECK_LIMITS.maxNameLength)
  if (!Array.isArray(body?.decks) || body.decks.length === 0) throw badRequest('decks must contain a root deck.')
  const seenDeckIds = new Set()
  const decks = body.decks.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest(`decks[${index}] must be an object.`)
    const id = requiredText(raw.sourceDeckId, `decks[${index}].sourceDeckId`, 200)
    if (seenDeckIds.has(id)) throw badRequest(`Duplicate source deck id: ${id}.`)
    seenDeckIds.add(id)
    return {
      sourceDeckId: id,
      parentSourceDeckId: typeof raw.parentSourceDeckId === 'string' && raw.parentSourceDeckId.trim()
        ? raw.parentSourceDeckId.trim()
        : null,
      name: requiredText(raw.name, `decks[${index}].name`, GLOBAL_DECK_LIMITS.maxNameLength),
      cards: Array.isArray(raw.cards) && raw.cards.length === 0 ? [] : normalizeGlobalDeckCards(raw.cards),
    }
  })
  const roots = decks.filter((deck) => deck.parentSourceDeckId === null)
  if (roots.length !== 1 || roots[0].sourceDeckId !== sourceDeckId) throw badRequest('The published hierarchy must have one matching root deck.')
  let totalCards = 0
  for (const deck of decks) {
    totalCards += deck.cards.length
    if (deck.parentSourceDeckId && !seenDeckIds.has(deck.parentSourceDeckId)) throw badRequest('A subdeck parent is missing.')
  }
  if (totalCards === 0) throw badRequest('The global deck must contain at least one card.')
  if (totalCards > GLOBAL_DECK_LIMITS.maxCards) throw badRequest(`A global deck may contain at most ${GLOBAL_DECK_LIMITS.maxCards} cards.`)

  if (!Array.isArray(body.media)) throw badRequest('media must be an array.')
  if (body.media.length > GLOBAL_DECK_LIMITS.maxMedia) throw badRequest('The global deck has too many media files.')
  const seenMediaIds = new Set()
  const media = body.media.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest(`media[${index}] must be an object.`)
    const sourceMediaId = requiredText(raw.sourceMediaId, `media[${index}].sourceMediaId`, 200)
    if (seenMediaIds.has(sourceMediaId)) throw badRequest(`Duplicate source media id: ${sourceMediaId}.`)
    seenMediaIds.add(sourceMediaId)
    const sha256 = requiredText(raw.sha256, `media[${index}].sha256`, 64).toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw badRequest(`media[${index}].sha256 is invalid.`)
    const byteSize = Number(raw.byteSize)
    if (!Number.isInteger(byteSize) || byteSize <= 0 || byteSize > GLOBAL_DECK_LIMITS.maxMediaBytes) {
      throw badRequest(`media[${index}].byteSize is invalid.`)
    }
    return {
      sourceMediaId,
      sha256,
      mimeType: requiredText(raw.mimeType, `media[${index}].mimeType`, 200),
      byteSize,
      originalName: requiredText(raw.originalName, `media[${index}].originalName`, 500),
    }
  })
  return { publisherId, sourceDeckId, name, decks, media, cardCount: totalCards }
}

export const normalizeGlobalDeckSearch = (value) =>
  typeof value === 'string' ? value.trim().slice(0, GLOBAL_DECK_LIMITS.maxSearchLength) : ''

export const globalDeckResponse = (row, detail = false) => ({
  id: row.id,
  name: row.name,
  cardCount: row.cardCount,
  heartCount: row._count?.hearts ?? 0,
  viewerHearted: Array.isArray(row.hearts) && row.hearts.length > 0,
  publishedAt: row.publishedAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  ...(detail
    ? {
        decks: Array.isArray(row.cardsJson)
          ? [{ sourceDeckId: row.sourceDeckId, parentSourceDeckId: null, name: row.name, cards: row.cardsJson }]
          : row.cardsJson?.decks ?? [],
        media: Array.isArray(row.media)
          ? row.media.map((item) => ({
              sourceMediaId: item.sourceMediaId,
              sha256: item.sha256,
              mimeType: item.mimeType,
              byteSize: item.byteSize,
              originalName: item.originalName,
            }))
          : [],
      }
    : {}),
})
