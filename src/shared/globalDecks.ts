import type {
  GlobalDeckCard,
  GlobalDeckDetail,
  GlobalDeckHeartResult,
  GlobalDeckSummary,
  NoteTypeName,
} from './types'

/** Host of the global deck library. */
export const GLOBAL_DECKS_BASE_URL = 'http://147.135.31.128:41729'

/** The library is always listed most-hearted first. */
export const GLOBAL_DECKS_SORT = 'hearts'

export const GLOBAL_DECKS_TIMEOUT_MS = 15_000

/** Upper bound on a single publish, so one huge deck cannot become one huge POST. */
export const GLOBAL_DECKS_MAX_PUBLISH_CARDS = 5000

/** What is uploaded for a deck: names and card content only, never scheduling. */
export interface GlobalDeckPublishInput {
  sourceDeckId: string
  name: string
  cards: GlobalDeckCard[]
}

export interface GlobalDecksClient {
  list(search: string): Promise<GlobalDeckSummary[]>
  get(globalDeckId: string): Promise<GlobalDeckDetail>
  publish(input: GlobalDeckPublishInput): Promise<GlobalDeckSummary>
  heart(globalDeckId: string, hearted: boolean): Promise<GlobalDeckHeartResult>
}

const asString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)

const asCount = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
}

const asIsoString = (value: unknown): string => {
  const parsed = Date.parse(asString(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString()
}

const asNoteType = (value: unknown): NoteTypeName =>
  value === 'cloze' || value === 'imported' ? value : 'basic'

const asTags = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : []

/**
 * Coerces one host-returned card. Everything in the library is user-published,
 * so a malformed field becomes a safe default rather than being trusted; the
 * HTML itself is sanitized by the renderer before it is ever displayed.
 */
export const toGlobalDeckCard = (raw: unknown): GlobalDeckCard | null => {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const frontHtml = asString(row.frontHtml)
  const backHtml = asString(row.backHtml)
  if (!frontHtml.trim() && !backHtml.trim()) return null
  return { frontHtml, backHtml, tags: asTags(row.tags), noteType: asNoteType(row.noteType) }
}

/** Coerces one host-returned listing row; `null` when it is not usable at all. */
export const toGlobalDeckSummary = (raw: unknown): GlobalDeckSummary | null => {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const id = asString(row.id)
  const name = asString(row.name).trim()
  if (!id || !name) return null

  const publishedAt = asIsoString(row.publishedAt)
  return {
    id,
    name,
    cardCount: asCount(row.cardCount),
    heartCount: asCount(row.heartCount),
    viewerHearted: Boolean(row.viewerHearted),
    publishedAt,
    updatedAt: row.updatedAt === undefined ? publishedAt : asIsoString(row.updatedAt),
  }
}

export const toGlobalDeckDetail = (raw: unknown): GlobalDeckDetail | null => {
  const summary = toGlobalDeckSummary(raw)
  if (!summary) return null
  const cards = Array.isArray((raw as Record<string, unknown>).cards)
    ? ((raw as Record<string, unknown>).cards as unknown[])
        .map(toGlobalDeckCard)
        .filter((card): card is GlobalDeckCard => card !== null)
    : []
  // The host's declared count can disagree with what it actually sent.
  return { ...summary, cards, cardCount: cards.length || summary.cardCount }
}

export const toGlobalDeckHeartResult = (
  raw: unknown,
  fallback: { id: string; hearted: boolean }
): GlobalDeckHeartResult => {
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    id: asString(row.id, fallback.id),
    heartCount: asCount(row.heartCount),
    viewerHearted: row.viewerHearted === undefined ? fallback.hearted : Boolean(row.viewerHearted),
  }
}

/** Hosts may answer with the deck directly or wrap it in `{ deck }`. */
const unwrapDeck = (payload: unknown): unknown => {
  if (payload && typeof payload === 'object' && 'deck' in (payload as Record<string, unknown>)) {
    return (payload as Record<string, unknown>).deck
  }
  return payload
}

export const buildGlobalDeckListPath = (search: string, installationId: string): string => {
  const params = new URLSearchParams({
    search: search.trim(),
    sort: GLOBAL_DECKS_SORT,
    installationId,
  })
  return `/global-decks?${params.toString()}`
}

export const globalDecksRequest = async <T>(
  path: string,
  options: { method: 'GET' | 'POST'; body?: unknown; baseUrl?: string } = { method: 'GET' }
): Promise<T> => {
  const baseUrl = options.baseUrl ?? GLOBAL_DECKS_BASE_URL
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), GLOBAL_DECKS_TIMEOUT_MS)

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method,
      headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })

    const text = await response.text()
    let parsed: unknown = {}
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error('The deck library returned a response oNami could not read.')
      }
    }

    if (!response.ok) {
      const message = (parsed as { error?: unknown } | null)?.error
      throw new Error(typeof message === 'string' && message ? message : `The deck library returned HTTP ${response.status}.`)
    }
    return parsed as T
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('The deck library did not respond in time.')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * The library client shared by the Electron main process and the browser build.
 * `installationId` is a stable per-install UUID: it identifies who published a
 * deck and whose hearts are whose, and is the only identity the host is given.
 */
export const createGlobalDecksClient = (options: {
  installationId: () => string | Promise<string>
  baseUrl?: string
}): GlobalDecksClient => {
  const request = <T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> =>
    globalDecksRequest<T>(path, { ...init, baseUrl: options.baseUrl })

  return {
    list: async (search) => {
      const installationId = await options.installationId()
      const payload = await globalDecksRequest<{ decks?: unknown }>(
        buildGlobalDeckListPath(search, installationId),
        { method: 'GET', baseUrl: options.baseUrl }
      )
      const rows = Array.isArray(payload.decks) ? payload.decks : []
      // Host order is the heart order the UI shows, so it is preserved as-is.
      return rows.map(toGlobalDeckSummary).filter((deck): deck is GlobalDeckSummary => deck !== null)
    },

    get: async (globalDeckId) => {
      const installationId = await options.installationId()
      const params = new URLSearchParams({ installationId })
      const payload = await request<unknown>(
        `/global-decks/${encodeURIComponent(globalDeckId)}?${params.toString()}`,
        { method: 'GET' }
      )
      const detail = toGlobalDeckDetail(unwrapDeck(payload))
      if (!detail) throw new Error('That deck is no longer available in the library.')
      return detail
    },

    publish: async (input) => {
      const publisherId = await options.installationId()
      const payload = await request<unknown>('/global-decks', {
        method: 'POST',
        body: {
          publisherId,
          sourceDeckId: input.sourceDeckId,
          name: input.name,
          cards: input.cards,
        },
      })
      const summary = toGlobalDeckSummary(unwrapDeck(payload))
      if (!summary) {
        // The deck is published; only the echoed row was unusable.
        return {
          id: '',
          name: input.name,
          cardCount: input.cards.length,
          heartCount: 0,
          viewerHearted: false,
          publishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      }
      return summary
    },

    heart: async (globalDeckId, hearted) => {
      const installationId = await options.installationId()
      const payload = await request<unknown>(`/global-decks/${encodeURIComponent(globalDeckId)}/heart`, {
        method: 'POST',
        body: { installationId, hearted },
      })
      return toGlobalDeckHeartResult(unwrapDeck(payload), { id: globalDeckId, hearted })
    },
  }
}
