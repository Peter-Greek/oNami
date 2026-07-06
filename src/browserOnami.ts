import { createEmptyCard, fsrs, Rating, State, type Card as FsrsCard, type Grade } from 'ts-fsrs'

import type {
  AiGenerationResult,
  AiSettings,
  AppSettings,
  AppStats,
  AnswerInput,
  AnswerResult,
  CardSummary,
  CreateCardInput,
  CreateDeckInput,
  DeckDetail,
  DeckSummary,
  HardCardSummary,
  ImportResult,
  NoteTypeName,
  OnamiApi,
  ReviewRating,
  ReviewStateName,
  SaveAiSettingsInput,
  SaveAppSettingsInput,
  StatsFilterInput,
  StudyMode,
  StudySessionSettings,
  SyncConfirmPairingInput,
  SyncConfirmPairingResult,
  SyncHealthResult,
  SyncJoinPairingInput,
  SyncJoinPairingResult,
  SyncStartPairingResult,
  ThemeMode,
  UpdateCardInput,
} from './shared/types'

interface StoredDeck {
  id: string
  parentId: string | null
  name: string
  source: string
  createdAt: string
  updatedAt: string
}

interface StoredCard {
  id: string
  noteId: string
  deckId: string
  deckNameSnapshot: string
  templateOrd: number
  noteType: NoteTypeName
  frontHtml: string
  backHtml: string
  tags: string[]
  fields: Record<string, string>
  state: ReviewStateName
  dueAt: string | null
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  learningSteps: number
  reps: number
  lapses: number
  successRate: number
  lastRating: ReviewRating | null
  lastReviewedAt: string | null
  createdAt: string
  updatedAt: string
}

interface StoredReviewLog {
  id: string
  cardId: string
  reviewedAt: string
  rating: ReviewRating
  elapsedMs: number
  revealMs: number
  answerMs: number
  previousDueAt: string | null
  nextDueAt: string | null
}

interface StoredState {
  decks: StoredDeck[]
  cards: StoredCard[]
  reviewLog: StoredReviewLog[]
  appSettings: AppSettings
  aiSettings: AiSettings
}

interface RuntimeSession {
  id: string
  mode: StudyMode
  deckId: string
  cardIds: string[]
  answered: Array<{ cardId: string; rating: ReviewRating }>
  unitTestThreshold: number
}

interface BrowserSyncSettings {
  hostUrl: string
  deviceId: string | null
  deviceName: string | null
  publicKey: string | null
  privateKeyJwk: JsonWebKey | null
  syncGroupId: string | null
  deviceToken: string | null
  deviceTokenExpiresAt: string | null
}

const STORAGE_KEY = 'onami.android.mvp.v1'
const SYNC_SETTINGS_KEY = 'onami.sync.settings'
const DEFAULT_SYNC_HOST_URL = 'http://147.135.31.128:41729'

const defaultAppSettings: AppSettings = {
  audioVolume: 0.8,
  themeMode: 'system',
}

const defaultState: StoredState = {
  decks: [],
  cards: [],
  reviewLog: [],
  appSettings: defaultAppSettings,
  aiSettings: {
    hasApiKey: false,
    model: 'gpt-4o-mini',
  },
}

const ratingMap: Record<ReviewRating, Rating> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
}

const stateToFsrs: Record<ReviewStateName, State> = {
  New: State.New,
  Learning: State.Learning,
  Review: State.Review,
  Relearning: State.Relearning,
}

const fsrsToState: Record<State, ReviewStateName> = {
  [State.New]: 'New',
  [State.Learning]: 'Learning',
  [State.Review]: 'Review',
  [State.Relearning]: 'Relearning',
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const nowIso = () => new Date().toISOString()

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(index, index + 0x8000))
  }
  return btoa(binary)
}

const pemFromSpki = (buffer: ArrayBuffer): string => {
  const base64 = arrayBufferToBase64(buffer)
  const lines = base64.match(/.{1,64}/g) ?? []
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`
}

const normalizeSyncHostUrl = (hostUrl: string): string => {
  const trimmed = hostUrl.trim().replace(/\/+$/, '')
  if (!trimmed) return DEFAULT_SYNC_HOST_URL
  const parsed = new URL(trimmed)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Sync host URL must start with http:// or https://.')
  }
  return parsed.toString().replace(/\/+$/, '')
}

const readSyncSettings = (): BrowserSyncSettings => {
  try {
    const raw = localStorage.getItem(SYNC_SETTINGS_KEY)
    const parsed = raw ? (JSON.parse(raw) as Partial<BrowserSyncSettings>) : {}
    return {
      hostUrl: normalizeSyncHostUrl(parsed.hostUrl || localStorage.getItem('onami.sync.hostUrl') || DEFAULT_SYNC_HOST_URL),
      deviceId: parsed.deviceId ?? null,
      deviceName: parsed.deviceName ?? null,
      publicKey: parsed.publicKey ?? null,
      privateKeyJwk: parsed.privateKeyJwk ?? null,
      syncGroupId: parsed.syncGroupId ?? null,
      deviceToken: parsed.deviceToken ?? null,
      deviceTokenExpiresAt: parsed.deviceTokenExpiresAt ?? null,
    }
  } catch {
    return {
      hostUrl: DEFAULT_SYNC_HOST_URL,
      deviceId: null,
      deviceName: null,
      publicKey: null,
      privateKeyJwk: null,
      syncGroupId: null,
      deviceToken: null,
      deviceTokenExpiresAt: null,
    }
  }
}

const writeSyncSettings = (settings: BrowserSyncSettings) => {
  const next = {
    ...settings,
    hostUrl: normalizeSyncHostUrl(settings.hostUrl),
  }
  localStorage.setItem(SYNC_SETTINGS_KEY, JSON.stringify(next))
  localStorage.setItem('onami.sync.hostUrl', next.hostUrl)
}

const syncStatusFromSettings = (settings: BrowserSyncSettings) => ({
  hostUrl: settings.hostUrl,
  deviceId: settings.deviceId,
  deviceName: settings.deviceName,
  syncGroupId: settings.syncGroupId,
  paired: Boolean(settings.syncGroupId),
  pendingEvents: 0,
  lastHostCursor: 0,
  backedUpEvents: 0,
  lastBackedUpAt: null,
  backupState: settings.syncGroupId ? ('no-data' as const) : ('not-paired' as const),
})

const syncHostRequest = async <T,>(
  path: string,
  options: { method: 'GET' | 'POST'; body?: unknown; token?: string }
): Promise<T> => {
  const settings = readSyncSettings()
  const response = await fetch(`${settings.hostUrl}${path}`, {
    method: options.method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error || `Sync host returned HTTP ${response.status}.`)
  return body
}

const ensureSyncDevice = async (): Promise<BrowserSyncSettings & {
  deviceId: string
  deviceName: string
  publicKey: string
  privateKeyJwk: JsonWebKey
}> => {
  const settings = readSyncSettings()
  if (settings.deviceId && settings.deviceName && settings.publicKey && settings.privateKeyJwk) {
    return {
      ...settings,
      deviceId: settings.deviceId,
      deviceName: settings.deviceName,
      publicKey: settings.publicKey,
      privateKeyJwk: settings.privateKeyJwk,
    }
  }

  if (!crypto.subtle) throw new Error('This WebView does not support device passkeys.')
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' } as AlgorithmIdentifier, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicKey = pemFromSpki(await crypto.subtle.exportKey('spki', pair.publicKey))
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const deviceId = crypto.randomUUID()
  const deviceName = `${navigator.platform || 'Android'} phone`
  const next: BrowserSyncSettings = {
    ...settings,
    deviceId,
    deviceName,
    publicKey,
    privateKeyJwk,
  }
  writeSyncSettings(next)
  return {
    ...next,
    deviceId,
    deviceName,
    publicKey,
    privateKeyJwk,
  }
}

const requestSyncDeviceToken = async (): Promise<{ token: string; expiresAt: string }> => {
  const device = await ensureSyncDevice()
  const key = await crypto.subtle.importKey('jwk', device.privateKeyJwk, { name: 'Ed25519' } as AlgorithmIdentifier, false, [
    'sign',
  ])
  const timestamp = nowIso()
  const payload = new TextEncoder().encode(`${device.deviceId}.${timestamp}`)
  const signature = arrayBufferToBase64(await crypto.subtle.sign({ name: 'Ed25519' } as AlgorithmIdentifier, key, payload))
  return syncHostRequest('/devices/token', {
    method: 'POST',
    body: {
      deviceId: device.deviceId,
      timestamp,
      signature,
    },
  })
}

const makeId = (prefix: string) => {
  const randomId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${prefix}_${randomId}`
}

const normalizeThemeMode = (value: unknown): ThemeMode =>
  value === 'light' || value === 'dark' || value === 'system' ? value : 'system'

const clampAudioVolume = (value: unknown): number => {
  const volume = Number(value)
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : defaultAppSettings.audioVolume
}

const readState = (): StoredState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return clone(defaultState)
    const parsed = JSON.parse(raw) as Partial<StoredState>
    return {
      decks: Array.isArray(parsed.decks) ? parsed.decks : [],
      cards: Array.isArray(parsed.cards) ? parsed.cards : [],
      reviewLog: Array.isArray(parsed.reviewLog) ? parsed.reviewLog : [],
      appSettings: {
        audioVolume: clampAudioVolume(parsed.appSettings?.audioVolume),
        themeMode: normalizeThemeMode(parsed.appSettings?.themeMode),
      },
      aiSettings: {
        hasApiKey: Boolean(parsed.aiSettings?.hasApiKey),
        model: parsed.aiSettings?.model || 'gpt-4o-mini',
      },
    }
  } catch {
    return clone(defaultState)
  }
}

const writeState = (state: StoredState) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

const mutateState = <T>(fn: (state: StoredState) => T): T => {
  const state = readState()
  const result = fn(state)
  writeState(state)
  return result
}

const toSummary = (state: StoredState, deck: StoredDeck): DeckSummary => {
  const cards = state.cards.filter((card) => card.deckId === deck.id)
  const reviewCards = cards.filter((card) => card.state === 'Review')
  const dueCards = cards.filter((card) => card.state !== 'New' && card.dueAt && Date.parse(card.dueAt) <= Date.now())
  const reviewedCards = cards.filter((card) => card.reps > 0)
  return {
    id: deck.id,
    parentId: deck.parentId,
    name: deck.name,
    source: deck.source,
    totalCards: cards.length,
    newCards: cards.filter((card) => card.state === 'New').length,
    dueCards: dueCards.length,
    learningCards: cards.filter((card) => card.state === 'Learning' || card.state === 'Relearning').length,
    reviewCards: reviewCards.length,
    successRate:
      reviewedCards.length > 0
        ? reviewedCards.reduce((sum, card) => sum + card.successRate, 0) / reviewedCards.length
        : 0,
    createdAt: deck.createdAt,
    updatedAt: deck.updatedAt,
  }
}

const toCardSummary = (state: StoredState, card: StoredCard): CardSummary => ({
  id: card.id,
  noteId: card.noteId,
  deckId: card.deckId,
  deckName: state.decks.find((deck) => deck.id === card.deckId)?.name ?? card.deckNameSnapshot,
  templateOrd: card.templateOrd,
  frontHtml: card.frontHtml,
  backHtml: card.backHtml,
  tags: [...card.tags],
  state: card.state,
  dueAt: card.dueAt,
  reps: card.reps,
  lapses: card.lapses,
  successRate: card.successRate,
  lastRating: card.lastRating,
  lastReviewedAt: card.lastReviewedAt,
})

const getDescendantDeckIds = (state: StoredState, deckId: string): string[] => {
  const ids = new Set([deckId])
  let changed = true
  while (changed) {
    changed = false
    for (const deck of state.decks) {
      if (deck.parentId && ids.has(deck.parentId) && !ids.has(deck.id)) {
        ids.add(deck.id)
        changed = true
      }
    }
  }
  return [...ids]
}

const selectedCardsForStats = (state: StoredState, deckId?: string | null) => {
  if (!deckId) return state.cards
  const deckIds = new Set(getDescendantDeckIds(state, deckId))
  return state.cards.filter((card) => deckIds.has(card.deckId))
}

const selectCardsForMode = (
  cards: CardSummary[],
  mode: StudyMode,
  settings: StudySessionSettings
): CardSummary[] => {
  const limit = settings.limit ?? 30
  const now = Date.now()
  const isDue = (card: CardSummary) =>
    card.state !== 'New' && card.dueAt !== null && Date.parse(card.dueAt) <= now
  const newCards = cards
    .filter((card) => card.state === 'New')
    .sort((a, b) => a.templateOrd - b.templateOrd)
  const dueCards = cards.filter(isDue)

  if (mode === 'learn-new') return newCards.slice(0, limit)
  if (mode === 'review-due') return dueCards.slice(0, limit)
  if (mode === 'unit-test') {
    return [...cards]
      .sort((a, b) => a.successRate - b.successRate || a.reps - b.reps)
      .slice(0, settings.unitTestEvery ?? limit)
  }

  const newEvery = Math.max(1, settings.newEvery ?? 5)
  const mixed: CardSummary[] = []
  let newIndex = 0
  let dueIndex = 0
  while (mixed.length < limit && (dueIndex < dueCards.length || newIndex < newCards.length)) {
    const shouldInsertNew = mixed.length > 0 && mixed.length % newEvery === 0
    if (shouldInsertNew && newIndex < newCards.length) {
      mixed.push(newCards[newIndex])
      newIndex += 1
    } else if (dueIndex < dueCards.length) {
      mixed.push(dueCards[dueIndex])
      dueIndex += 1
    } else if (newIndex < newCards.length) {
      mixed.push(newCards[newIndex])
      newIndex += 1
    }
  }
  return mixed
}

const toFsrsCard = (card: StoredCard): FsrsCard => {
  if (card.state === 'New') return createEmptyCard(new Date())
  return {
    due: card.dueAt ? new Date(card.dueAt) : new Date(),
    stability: card.stability || 0.1,
    difficulty: card.difficulty || 5,
    elapsed_days: card.elapsedDays,
    scheduled_days: card.scheduledDays,
    learning_steps: card.learningSteps,
    reps: card.reps,
    lapses: card.lapses,
    state: stateToFsrs[card.state],
    last_review: card.lastReviewedAt ? new Date(card.lastReviewedAt) : undefined,
  }
}

const startOfLocalDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

const getStats = (state: StoredState, filter?: StatsFilterInput): AppStats => {
  const scopeDeckId = filter?.deckId || null
  const scopeDeck = scopeDeckId ? state.decks.find((deck) => deck.id === scopeDeckId) ?? null : null
  const cards = selectedCardsForStats(state, scopeDeckId)
  const cardIds = new Set(cards.map((card) => card.id))
  const logs = state.reviewLog.filter((log) => cardIds.has(log.cardId))
  const now = new Date()
  const todayStart = startOfLocalDay(now)
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000
  const monthStart = todayStart - 29 * 24 * 60 * 60 * 1000
  const reviewedSince = (startMs: number) =>
    logs.filter((log) => Date.parse(log.reviewedAt) >= startMs).length
  const studyTimeSince = (startMs: number) =>
    logs
      .filter((log) => Date.parse(log.reviewedAt) >= startMs)
      .reduce((sum, log) => sum + log.elapsedMs, 0)
  const reviewedCards = cards.filter((card) => card.reps > 0)
  const dayKeys = new Set(logs.map((log) => new Date(log.reviewedAt).toDateString()))
  let streakDays = 0
  for (let day = todayStart; dayKeys.has(new Date(day).toDateString()); day -= 24 * 60 * 60 * 1000) {
    streakDays += 1
  }

  const sortedDayTimes = [...dayKeys].map((key) => startOfLocalDay(new Date(key))).sort((a, b) => a - b)
  let longestStreakDays = 0
  let currentStreak = 0
  let previousDay = 0
  for (const day of sortedDayTimes) {
    currentStreak = previousDay && day - previousDay === 24 * 60 * 60 * 1000 ? currentStreak + 1 : 1
    longestStreakDays = Math.max(longestStreakDays, currentStreak)
    previousDay = day
  }

  const hardCards: HardCardSummary[] = cards
    .map((card) => {
      const cardLogs = logs.filter((log) => log.cardId === card.id)
      const againCount = cardLogs.filter((log) => log.rating === 'again').length
      const easyCount = cardLogs.filter((log) => log.rating === 'easy').length
      const averageReviewMs =
        cardLogs.length > 0 ? cardLogs.reduce((sum, log) => sum + log.elapsedMs, 0) / cardLogs.length : 0
      const averageRevealMs =
        cardLogs.length > 0 ? cardLogs.reduce((sum, log) => sum + log.revealMs, 0) / cardLogs.length : 0
      return {
        cardId: card.id,
        deckId: card.deckId,
        deckName: state.decks.find((deck) => deck.id === card.deckId)?.name ?? card.deckNameSnapshot,
        frontHtml: card.frontHtml,
        state: card.state,
        dueAt: card.dueAt,
        reps: card.reps,
        lapses: card.lapses,
        successRate: card.successRate,
        reviewCount: cardLogs.length,
        againCount,
        easyCount,
        averageReviewMs,
        averageRevealMs,
        averageAgainToEasyMs: null,
        difficultyScore: againCount * 2 + card.lapses + (1 - card.successRate),
      }
    })
    .filter((card) => card.reviewCount > 0)
    .sort((a, b) => b.difficultyScore - a.difficultyScore)
    .slice(0, 10)

  return {
    scopeDeckId,
    scopeDeckName: scopeDeck?.name ?? null,
    totalDecks: scopeDeckId ? getDescendantDeckIds(state, scopeDeckId).length : state.decks.length,
    totalCards: cards.length,
    newCards: cards.filter((card) => card.state === 'New').length,
    dueCards: cards.filter((card) => card.state !== 'New' && card.dueAt && Date.parse(card.dueAt) <= Date.now()).length,
    reviewedToday: reviewedSince(todayStart),
    reviewedThisWeek: reviewedSince(weekStart),
    reviewedThisMonth: reviewedSince(monthStart),
    totalReviews: logs.length,
    averageSuccessRate:
      reviewedCards.length > 0
        ? reviewedCards.reduce((sum, card) => sum + card.successRate, 0) / reviewedCards.length
        : 0,
    streakDays,
    longestStreakDays,
    studyTime: {
      todayMs: studyTimeSince(todayStart),
      weekMs: studyTimeSince(weekStart),
      monthMs: studyTimeSince(monthStart),
      overallMs: logs.reduce((sum, log) => sum + log.elapsedMs, 0),
    },
    completion: {
      completedCards: reviewedCards.length,
      totalCards: cards.length,
      completionRatio: cards.length > 0 ? reviewedCards.length / cards.length : 0,
      fullyLearned: cards.length > 0 && reviewedCards.length === cards.length,
    },
    averageReviewMs: logs.length > 0 ? logs.reduce((sum, log) => sum + log.elapsedMs, 0) / logs.length : 0,
    averageRevealMs: logs.length > 0 ? logs.reduce((sum, log) => sum + log.revealMs, 0) / logs.length : 0,
    averageAgainToEasyMs: null,
    hardestCards: hardCards,
  }
}

export const installBrowserOnami = () => {
  if (window.onami) return
  document.documentElement.classList.add('browser-shell')

  const scheduler = fsrs({
    request_retention: 0.9,
    maximum_interval: 36500,
    enable_fuzz: true,
    enable_short_term: true,
    learning_steps: ['1m', '10m'],
    relearning_steps: ['10m'],
  })
  const sessions = new Map<string, RuntimeSession>()

  const api: OnamiApi = {
    decks: {
      create: async (input: CreateDeckInput) =>
        mutateState((state) => {
          const trimmedName = input.name.trim()
          if (!trimmedName) throw new Error('Deck name is required.')
          const timestamp = nowIso()
          const deck: StoredDeck = {
            id: makeId('deck'),
            parentId: input.parentId ?? null,
            name: trimmedName,
            source: 'android-local',
            createdAt: timestamp,
            updatedAt: timestamp,
          }
          state.decks.push(deck)
          return toSummary(state, deck)
        }),
      delete: async (deckId: string) =>
        mutateState((state) => {
          const deckIds = new Set(getDescendantDeckIds(state, deckId))
          const deletedCardIds = new Set(state.cards.filter((card) => deckIds.has(card.deckId)).map((card) => card.id))
          state.decks = state.decks.filter((deck) => !deckIds.has(deck.id))
          state.cards = state.cards.filter((card) => !deletedCardIds.has(card.id))
          state.reviewLog = state.reviewLog.filter((log) => !deletedCardIds.has(log.cardId))
        }),
      resetScheduling: async (deckId: string) =>
        mutateState((state) => {
          const deckIds = new Set(getDescendantDeckIds(state, deckId))
          state.cards.forEach((card) => {
            if (!deckIds.has(card.deckId)) return
            card.state = 'New'
            card.dueAt = null
            card.stability = 0
            card.difficulty = 0
            card.elapsedDays = 0
            card.scheduledDays = 0
            card.learningSteps = 0
            card.reps = 0
            card.lapses = 0
            card.successRate = 0
            card.lastRating = null
            card.lastReviewedAt = null
            card.updatedAt = nowIso()
          })
        }),
      list: async () => {
        const state = readState()
        return state.decks.map((deck) => toSummary(state, deck))
      },
      get: async (deckId: string): Promise<DeckDetail> => {
        const state = readState()
        const deck = state.decks.find((item) => item.id === deckId)
        if (!deck) throw new Error('Deck not found.')
        return {
          ...toSummary(state, deck),
          cards: state.cards
            .filter((card) => card.deckId === deckId)
            .map((card) => toCardSummary(state, card)),
        }
      },
      selectApkg: async () => {
        throw new Error('APKG import is not available in this Android MVP yet. Create cards locally for this build.')
      },
      importApkg: async (): Promise<ImportResult> => {
        throw new Error('APKG import is not available in this Android MVP yet.')
      },
    },
    cards: {
      create: async (input: CreateCardInput) =>
        mutateState((state) => {
          const deck = state.decks.find((item) => item.id === input.deckId)
          if (!deck) throw new Error('Choose or create a deck first.')
          if (!input.frontHtml.trim() || !input.backHtml.trim()) throw new Error('Front and back are required.')
          const timestamp = nowIso()
          const card: StoredCard = {
            id: makeId('card'),
            noteId: makeId('note'),
            deckId: deck.id,
            deckNameSnapshot: deck.name,
            templateOrd: state.cards.filter((item) => item.deckId === deck.id).length,
            noteType: input.noteType,
            frontHtml: input.frontHtml,
            backHtml: input.backHtml,
            tags: input.tags ?? [],
            fields: input.fields ?? {},
            state: 'New',
            dueAt: null,
            stability: 0,
            difficulty: 0,
            elapsedDays: 0,
            scheduledDays: 0,
            learningSteps: 0,
            reps: 0,
            lapses: 0,
            successRate: 0,
            lastRating: null,
            lastReviewedAt: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          }
          state.cards.push(card)
          deck.updatedAt = timestamp
          return toCardSummary(state, card)
        }),
      update: async (input: UpdateCardInput) =>
        mutateState((state) => {
          const card = state.cards.find((item) => item.id === input.id)
          if (!card) throw new Error('Card not found.')
          if (input.deckId) {
            const deck = state.decks.find((item) => item.id === input.deckId)
            if (!deck) throw new Error('Deck not found.')
            card.deckId = deck.id
            card.deckNameSnapshot = deck.name
          }
          if (input.frontHtml !== undefined) card.frontHtml = input.frontHtml
          if (input.backHtml !== undefined) card.backHtml = input.backHtml
          if (input.tags !== undefined) card.tags = input.tags
          card.updatedAt = nowIso()
          return toCardSummary(state, card)
        }),
      delete: async (cardId: string) =>
        mutateState((state) => {
          state.cards = state.cards.filter((card) => card.id !== cardId)
          state.reviewLog = state.reviewLog.filter((log) => log.cardId !== cardId)
        }),
    },
    study: {
      startSession: async (deckId: string, mode: StudyMode, settings: StudySessionSettings) => {
        const state = readState()
        const deck = state.decks.find((item) => item.id === deckId)
        if (!deck) throw new Error('Choose or create a deck first.')
        const deckIds = new Set(getDescendantDeckIds(state, deckId))
        const cards = state.cards
          .filter((card) => deckIds.has(card.deckId))
          .map((card) => toCardSummary(state, card))
        const selected = selectCardsForMode(cards, mode, settings)
        if (selected.length === 0) throw new Error('No cards match this study mode right now.')
        const id = makeId('session')
        const unitTestThreshold = settings.unitTestThreshold ?? 0.8
        sessions.set(id, {
          id,
          mode,
          deckId,
          cardIds: selected.map((card) => card.id),
          answered: [],
          unitTestThreshold,
        })
        return {
          id,
          mode,
          deckId,
          cards: selected.map((card) => ({ ...card, backVisible: false })),
          createdAt: nowIso(),
          unitTestThreshold,
        }
      },
      answer: async (input: AnswerInput): Promise<AnswerResult> =>
        mutateState((state) => {
          const session = sessions.get(input.sessionId)
          if (!session) throw new Error('Study session not found.')
          const card = state.cards.find((item) => item.id === input.cardId)
          if (!card) throw new Error('Card not found.')
          const previousDueAt = card.dueAt
          const previousReps = card.reps
          const result = scheduler.next(toFsrsCard(card), new Date(), ratingMap[input.rating] as Grade)
          const nextState = fsrsToState[result.card.state]
          const nextDueAt = nextState === 'New' ? null : result.card.due.toISOString()
          const success = input.rating === 'again' ? 0 : 1
          const successRate =
            result.card.reps > 0 ? (previousReps * card.successRate + success) / result.card.reps : 0

          card.state = nextState
          card.dueAt = nextDueAt
          card.stability = result.card.stability
          card.difficulty = result.card.difficulty
          card.elapsedDays = result.card.elapsed_days
          card.scheduledDays = result.card.scheduled_days
          card.learningSteps = result.card.learning_steps
          card.reps = result.card.reps
          card.lapses = result.card.lapses
          card.successRate = successRate
          card.lastRating = input.rating
          card.lastReviewedAt = nowIso()
          card.updatedAt = card.lastReviewedAt

          state.reviewLog.push({
            id: makeId('review'),
            cardId: card.id,
            reviewedAt: card.lastReviewedAt,
            rating: input.rating,
            elapsedMs: input.elapsedMs ?? 0,
            revealMs: input.revealMs ?? 0,
            answerMs: input.answerMs ?? 0,
            previousDueAt,
            nextDueAt,
          })

          session.answered.push({ cardId: input.cardId, rating: input.rating })
          const sessionComplete = session.answered.length >= session.cardIds.length
          const unitScore =
            session.mode === 'unit-test' && session.answered.length > 0
              ? session.answered.filter((answer) => answer.rating !== 'again').length / session.answered.length
              : null
          const recommendation =
            sessionComplete && unitScore !== null && unitScore < session.unitTestThreshold
              ? 'Score is below target. Run a focused Review Due session before adding more new cards.'
              : null

          return {
            cardId: card.id,
            rating: input.rating,
            nextDueAt,
            state: nextState,
            successRate,
            sessionComplete,
            unitScore,
            recommendation,
          }
        }),
    },
    ai: {
      getSettings: async () => readState().aiSettings,
      saveSettings: async (input: SaveAiSettingsInput) =>
        mutateState((state) => {
          state.aiSettings = {
            hasApiKey: Boolean(input.apiKey?.trim()) || state.aiSettings.hasApiKey,
            model: input.model.trim() || state.aiSettings.model,
          }
          return state.aiSettings
        }),
      generateCards: async (): Promise<AiGenerationResult> => {
        throw new Error('AI card generation is not available in this Android MVP yet.')
      },
    },
    settings: {
      get: async () => readState().appSettings,
      save: async (input: SaveAppSettingsInput) =>
        mutateState((state) => {
          state.appSettings = {
            audioVolume:
              input.audioVolume === undefined ? state.appSettings.audioVolume : clampAudioVolume(input.audioVolume),
            themeMode:
              input.themeMode === undefined ? state.appSettings.themeMode : normalizeThemeMode(input.themeMode),
          }
          return state.appSettings
        }),
    },
    sync: {
      getStatus: async () => syncStatusFromSettings(readSyncSettings()),
      saveSettings: async (input) => {
        const current = readSyncSettings()
        const hostUrl = normalizeSyncHostUrl(input.hostUrl)
        const next = {
          ...current,
          hostUrl,
          deviceToken: hostUrl === current.hostUrl ? current.deviceToken : null,
          deviceTokenExpiresAt: hostUrl === current.hostUrl ? current.deviceTokenExpiresAt : null,
        }
        writeSyncSettings(next)
        return syncStatusFromSettings(next)
      },
      checkHealth: async (): Promise<SyncHealthResult> => {
        try {
          const body = await syncHostRequest<{ ok?: boolean; service?: string; time?: string }>('/health', {
            method: 'GET',
          })
          return {
            ok: body.ok === true,
            service: body.service ?? null,
            time: body.time ?? null,
            error: null,
          }
        } catch (error) {
          return {
            ok: false,
            service: null,
            time: null,
            error: error instanceof Error ? error.message : 'Could not reach sync host.',
          }
        }
      },
      startPairing: async (): Promise<SyncStartPairingResult> => {
        const device = await ensureSyncDevice()
        return syncHostRequest('/pairing/start', {
          method: 'POST',
          body: {
            deviceId: device.deviceId,
            name: device.deviceName,
            platform: 'android',
            publicKey: device.publicKey,
          },
        })
      },
      joinPairing: async (input: SyncJoinPairingInput): Promise<SyncJoinPairingResult> => {
        const device = await ensureSyncDevice()
        return syncHostRequest('/pairing/join', {
          method: 'POST',
          body: {
            pairingCode: input.pairingCode,
            deviceId: device.deviceId,
            name: device.deviceName,
            platform: 'android',
            publicKey: device.publicKey,
          },
        })
      },
      confirmPairing: async (input: SyncConfirmPairingInput): Promise<SyncConfirmPairingResult> => {
        const device = await ensureSyncDevice()
        const result = await syncHostRequest<SyncConfirmPairingResult>('/pairing/confirm', {
          method: 'POST',
          body: {
            pairingCode: input.pairingCode,
            deviceId: device.deviceId,
            mode: input.mode,
          },
        })
        if (result.completed && result.syncGroupId) {
          const token = await requestSyncDeviceToken()
          writeSyncSettings({
            ...readSyncSettings(),
            syncGroupId: result.syncGroupId,
            deviceToken: token.token,
            deviceTokenExpiresAt: token.expiresAt,
          })
        }
        return result
      },
      syncNow: async () => {
        throw new Error('Host sync is only available in the desktop app for this beta.')
      },
    },
    stats: {
      get: async (filter?: StatsFilterInput) => getStats(readState(), filter),
    },
    appWindow: {
      minimize: async () => undefined,
      toggleMaximize: async () => false,
      isMaximized: async () => false,
      close: async () => undefined,
      openDevTools: async () => undefined,
      onMaximizedChanged: () => () => undefined,
    },
  }

  window.onami = api
}
