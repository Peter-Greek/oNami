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
  SyncCardUpsertPayload,
  SyncConfirmPairingInput,
  SyncConfirmPairingResult,
  SyncDeckRecord,
  SyncDeckUpsertPayload,
  SyncEntityType,
  SyncEventRecord,
  SyncEventPayload,
  SyncEventType,
  SyncHealthResult,
  SyncJoinPairingInput,
  SyncJoinPairingResult,
  SyncMediaBlob,
  SyncMediaRecord,
  SyncProgressEvent,
  SyncReviewAnswerPayload,
  SyncReviewLogRecord,
  SyncRunResult,
  SyncSnapshotBundle,
  SyncSnapshotResponse,
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

interface StoredMedia {
  id: string
  sha256: string
  mimeType: string
  originalName: string
  dataBase64: string
}

interface StoredState {
  decks: StoredDeck[]
  cards: StoredCard[]
  reviewLog: StoredReviewLog[]
  media: StoredMedia[]
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
  lastHostCursor: number
  nextSyncSequence: number
  backedUpEvents: number
  lastBackedUpAt: string | null
  seedSnapshotPending: boolean
}

const STORAGE_KEY = 'onami.android.mvp.v1'
const SYNC_SETTINGS_KEY = 'onami.sync.settings'
const SYNC_OUTBOX_KEY = 'onami.sync.outbox'
const DEFAULT_SYNC_HOST_URL = 'http://147.135.31.128:41729'
const syncProgressListeners = new Set<(event: SyncProgressEvent) => void>()

const defaultAppSettings: AppSettings = {
  audioVolume: 0.8,
  themeMode: 'system',
}

const defaultState: StoredState = {
  decks: [],
  cards: [],
  reviewLog: [],
  media: [],
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
      lastHostCursor: typeof parsed.lastHostCursor === 'number' ? parsed.lastHostCursor : 0,
      nextSyncSequence:
        typeof parsed.nextSyncSequence === 'number' && parsed.nextSyncSequence > 0 ? parsed.nextSyncSequence : 1,
      backedUpEvents: typeof parsed.backedUpEvents === 'number' ? parsed.backedUpEvents : 0,
      lastBackedUpAt: parsed.lastBackedUpAt ?? null,
      seedSnapshotPending: Boolean(parsed.seedSnapshotPending),
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
      lastHostCursor: 0,
      nextSyncSequence: 1,
      backedUpEvents: 0,
      lastBackedUpAt: null,
      seedSnapshotPending: false,
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

const readSyncOutbox = (): SyncEventRecord[] => {
  try {
    const raw = localStorage.getItem(SYNC_OUTBOX_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter((event): event is SyncEventRecord =>
      Boolean(
        event &&
          typeof event.eventId === 'string' &&
          typeof event.sourceDeviceId === 'string' &&
          typeof event.sequence === 'number' &&
          typeof event.entityType === 'string' &&
          typeof event.entityId === 'string' &&
          typeof event.eventType === 'string' &&
          typeof event.createdAt === 'string'
      )
    )
  } catch {
    return []
  }
}

const writeSyncOutbox = (events: SyncEventRecord[]) => {
  localStorage.setItem(SYNC_OUTBOX_KEY, JSON.stringify(events))
}

const emitSyncProgress = (event: SyncProgressEvent) => {
  for (const listener of syncProgressListeners) listener(event)
}

const syncStatusFromSettings = (settings: BrowserSyncSettings) => ({
  hostUrl: settings.hostUrl,
  deviceId: settings.deviceId,
  deviceName: settings.deviceName,
  syncGroupId: settings.syncGroupId,
  paired: Boolean(settings.syncGroupId),
  pendingEvents: readSyncOutbox().length,
  lastHostCursor: settings.lastHostCursor,
  backedUpEvents: settings.backedUpEvents,
  lastBackedUpAt: settings.lastBackedUpAt,
  backupState: !settings.syncGroupId
    ? ('not-paired' as const)
    : readSyncOutbox().length > 0
      ? ('needs-sync' as const)
      : settings.backedUpEvents > 0 || settings.lastHostCursor > 0
      ? ('backed-up' as const)
      : ('no-data' as const),
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

const getValidSyncDeviceToken = async (): Promise<string> => {
  const settings = readSyncSettings()
  if (
    settings.deviceToken &&
    settings.deviceTokenExpiresAt &&
    Date.parse(settings.deviceTokenExpiresAt) - Date.now() > 5 * 60 * 1000
  ) {
    return settings.deviceToken
  }

  const token = await requestSyncDeviceToken()
  writeSyncSettings({
    ...readSyncSettings(),
    deviceToken: token.token,
    deviceTokenExpiresAt: token.expiresAt,
  })
  return token.token
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
      media: Array.isArray(parsed.media) ? parsed.media : [],
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

// Desktop stores media references as onami-media://<id>. The Android WebView has
// no custom protocol handler, so resolve them against the local media store and
// inline the bytes as data: URLs for display.
const rewriteMediaForDisplay = (state: StoredState, html: string): string =>
  html.replace(/onami-media:\/\/([^"')\s]+)/g, (match, rawId: string) => {
    const id = decodeURIComponent(rawId)
    const media = state.media.find((item) => item.id === id)
    return media ? `data:${media.mimeType};base64,${media.dataBase64}` : match
  })

const extractMediaIds = (html: string): string[] => {
  const ids = new Set<string>()
  const pattern = /onami-media:\/\/([^"')\s]+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    ids.add(decodeURIComponent(match[1]))
  }
  return [...ids]
}

const toCardSummary = (state: StoredState, card: StoredCard): CardSummary => ({
  id: card.id,
  noteId: card.noteId,
  deckId: card.deckId,
  deckName: state.decks.find((deck) => deck.id === card.deckId)?.name ?? card.deckNameSnapshot,
  templateOrd: card.templateOrd,
  frontHtml: rewriteMediaForDisplay(state, card.frontHtml),
  backHtml: rewriteMediaForDisplay(state, card.backHtml),
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
        frontHtml: rewriteMediaForDisplay(state, card.frontHtml),
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

interface RemoteSyncEvent {
  hostEventId: number
  eventId: string
  sourceDeviceId: string
  sequence: number
  entityType: SyncEntityType
  entityId: string
  eventType: SyncEventType
  payload: SyncEventPayload
  createdAt: string
}

const normalizeNoteType = (value: string): NoteTypeName => {
  const lower = value.toLowerCase()
  if (lower.includes('cloze')) return 'cloze'
  if (lower === 'basic') return 'basic'
  return 'imported'
}

const applyDeckUpsert = (state: StoredState, payload: SyncDeckUpsertPayload): boolean => {
  const deck = payload.deck
  const record: StoredDeck = {
    id: deck.id,
    parentId: deck.parentId,
    name: deck.name,
    source: deck.source,
    createdAt: deck.createdAt,
    updatedAt: deck.updatedAt,
  }
  const existing = state.decks.find((item) => item.id === deck.id)
  if (existing) Object.assign(existing, record)
  else state.decks.push(record)
  return true
}

const applyCardUpsert = (state: StoredState, payload: SyncCardUpsertPayload): boolean => {
  const { note, card, reviewState } = payload
  const deck = state.decks.find((item) => item.id === card.deckId)
  const existing = state.cards.find((item) => item.id === card.id)
  const record: StoredCard = {
    id: card.id,
    noteId: card.noteId,
    deckId: card.deckId,
    deckNameSnapshot: deck?.name ?? existing?.deckNameSnapshot ?? '',
    templateOrd: card.templateOrd,
    noteType: normalizeNoteType(note.noteType),
    frontHtml: card.frontHtml,
    backHtml: card.backHtml,
    tags: [...note.tags],
    fields: { ...note.fields },
    state: reviewState.state,
    dueAt: reviewState.dueAt,
    stability: reviewState.stability,
    difficulty: reviewState.difficulty,
    elapsedDays: reviewState.elapsedDays,
    scheduledDays: reviewState.scheduledDays,
    learningSteps: reviewState.learningSteps,
    reps: reviewState.reps,
    lapses: reviewState.lapses,
    successRate: reviewState.successRate,
    lastRating: reviewState.lastRating,
    lastReviewedAt: reviewState.lastReviewedAt,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  }
  if (existing) Object.assign(existing, record)
  else state.cards.push(record)
  return true
}

const applyReviewAnswer = (state: StoredState, event: RemoteSyncEvent): boolean => {
  const payload = event.payload as SyncReviewAnswerPayload
  const card = state.cards.find((item) => item.id === payload.cardId)
  if (!card) return false
  const reviewState = payload.reviewState
  card.state = reviewState.state
  card.dueAt = reviewState.dueAt
  card.stability = reviewState.stability
  card.difficulty = reviewState.difficulty
  card.elapsedDays = reviewState.elapsedDays
  card.scheduledDays = reviewState.scheduledDays
  card.learningSteps = reviewState.learningSteps
  card.reps = reviewState.reps
  card.lapses = reviewState.lapses
  card.successRate = reviewState.successRate
  card.lastRating = reviewState.lastRating
  card.lastReviewedAt = reviewState.lastReviewedAt
  card.updatedAt = payload.reviewedAt
  if (!state.reviewLog.some((log) => log.id === event.eventId)) {
    state.reviewLog.push({
      id: event.eventId,
      cardId: payload.cardId,
      reviewedAt: payload.reviewedAt,
      rating: payload.rating,
      elapsedMs: payload.elapsedMs,
      revealMs: payload.revealMs,
      answerMs: payload.answerMs,
      previousDueAt: payload.previousDueAt,
      nextDueAt: payload.nextDueAt,
    })
  }
  return true
}

const applyRemoteSyncEvent = (state: StoredState, event: RemoteSyncEvent): boolean => {
  switch (event.eventType) {
    case 'deck.upsert':
      return applyDeckUpsert(state, event.payload as SyncDeckUpsertPayload)
    case 'deck.delete': {
      const deckIds = new Set(getDescendantDeckIds(state, event.entityId))
      const removedCardIds = new Set(
        state.cards.filter((card) => deckIds.has(card.deckId)).map((card) => card.id)
      )
      const changed =
        state.decks.some((deck) => deckIds.has(deck.id)) || removedCardIds.size > 0
      state.decks = state.decks.filter((deck) => !deckIds.has(deck.id))
      state.cards = state.cards.filter((card) => !deckIds.has(card.deckId))
      state.reviewLog = state.reviewLog.filter((log) => !removedCardIds.has(log.cardId))
      return changed
    }
    case 'card.upsert':
      return applyCardUpsert(state, event.payload as SyncCardUpsertPayload)
    case 'card.delete': {
      const changed = state.cards.some((card) => card.id === event.entityId)
      state.cards = state.cards.filter((card) => card.id !== event.entityId)
      state.reviewLog = state.reviewLog.filter((log) => log.cardId !== event.entityId)
      return changed
    }
    case 'review.answer':
      return applyReviewAnswer(state, event)
    default:
      return false
  }
}

const base64ByteLength = (base64: string): number => {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

const buildSnapshot = (state: StoredState): SyncSnapshotBundle => ({
  version: 1,
  decks: state.decks.map(
    (deck): SyncDeckRecord => ({
      id: deck.id,
      parentId: deck.parentId,
      name: deck.name,
      source: deck.source,
      sourceId: null,
      createdAt: deck.createdAt,
      updatedAt: deck.updatedAt,
    })
  ),
  cards: state.cards.map(
    (card): SyncCardUpsertPayload => ({
      version: 1,
      note: {
        id: card.noteId,
        deckId: card.deckId,
        noteType: card.noteType,
        fields: card.fields,
        tags: card.tags,
        sourceGuid: null,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
      },
      card: {
        id: card.id,
        noteId: card.noteId,
        deckId: card.deckId,
        templateOrd: card.templateOrd,
        frontHtml: card.frontHtml,
        backHtml: card.backHtml,
        mediaRefs: extractMediaIds(`${card.frontHtml}\n${card.backHtml}`),
        sourceCardId: null,
        statsResetAt: null,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
      },
      reviewState: {
        dueAt: card.dueAt,
        state: card.state,
        stability: card.stability,
        difficulty: card.difficulty,
        elapsedDays: card.elapsedDays,
        scheduledDays: card.scheduledDays,
        learningSteps: card.learningSteps,
        reps: card.reps,
        lapses: card.lapses,
        successRate: card.successRate,
        lastRating: card.lastRating,
        lastReviewedAt: card.lastReviewedAt,
      },
    })
  ),
  reviewLogs: state.reviewLog.map(
    (log): SyncReviewLogRecord => ({
      id: log.id,
      cardId: log.cardId,
      reviewedAt: log.reviewedAt,
      rating: log.rating,
      elapsedMs: log.elapsedMs,
      revealMs: log.revealMs,
      answerMs: log.answerMs,
      previousDueAt: log.previousDueAt,
      nextDueAt: log.nextDueAt,
    })
  ),
  media: state.media.map(
    (media): SyncMediaRecord => ({
      id: media.id,
      sha256: media.sha256,
      mimeType: media.mimeType,
      byteSize: base64ByteLength(media.dataBase64),
      originalName: media.originalName,
    })
  ),
})

const applySnapshotBundle = (state: StoredState, bundle: SyncSnapshotBundle): void => {
  for (const deck of bundle.decks) applyDeckUpsert(state, { version: 1, deck })
  for (const card of bundle.cards) applyCardUpsert(state, card)
  for (const log of bundle.reviewLogs) {
    if (!state.reviewLog.some((entry) => entry.id === log.id)) {
      state.reviewLog.push({ ...log })
    }
  }
}

const buildDeckSyncPayload = (deck: StoredDeck): SyncDeckUpsertPayload => ({
  version: 1,
  deck: {
    id: deck.id,
    parentId: deck.parentId,
    name: deck.name,
    source: deck.source,
    sourceId: null,
    createdAt: deck.createdAt,
    updatedAt: deck.updatedAt,
  },
})

const buildCardSyncPayload = (card: StoredCard): SyncCardUpsertPayload => ({
  version: 1,
  note: {
    id: card.noteId,
    deckId: card.deckId,
    noteType: card.noteType,
    fields: card.fields,
    tags: card.tags,
    sourceGuid: null,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  },
  card: {
    id: card.id,
    noteId: card.noteId,
    deckId: card.deckId,
    templateOrd: card.templateOrd,
    frontHtml: card.frontHtml,
    backHtml: card.backHtml,
    mediaRefs: extractMediaIds(`${card.frontHtml}\n${card.backHtml}`),
    sourceCardId: null,
    statsResetAt: null,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  },
  reviewState: {
    dueAt: card.dueAt,
    state: card.state,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsedDays,
    scheduledDays: card.scheduledDays,
    learningSteps: card.learningSteps,
    reps: card.reps,
    lapses: card.lapses,
    successRate: card.successRate,
    lastRating: card.lastRating,
    lastReviewedAt: card.lastReviewedAt,
  },
})

const buildReviewAnswerSyncPayload = (input: {
  card: StoredCard
  reviewedAt: string
  rating: ReviewRating
  elapsedMs: number
  revealMs: number
  answerMs: number
  previousDueAt: string | null
  nextDueAt: string | null
}): SyncReviewAnswerPayload => ({
  version: 1,
  cardId: input.card.id,
  reviewedAt: input.reviewedAt,
  rating: input.rating,
  elapsedMs: input.elapsedMs,
  revealMs: input.revealMs,
  answerMs: input.answerMs,
  previousDueAt: input.previousDueAt,
  nextDueAt: input.nextDueAt,
  reviewState: buildCardSyncPayload(input.card).reviewState,
})

const enqueueSyncEvent = (
  entityType: SyncEntityType,
  entityId: string,
  eventType: SyncEventType,
  payload: SyncEventPayload
): void => {
  const settings = readSyncSettings()
  if (!settings.deviceId || !settings.syncGroupId) return

  const outbox = readSyncOutbox()
  const sequence = Math.max(settings.nextSyncSequence, ...outbox.map((event) => event.sequence + 1), 1)
  const event: SyncEventRecord = {
    eventId: makeId('sync_event'),
    sourceDeviceId: settings.deviceId,
    sequence,
    entityType,
    entityId,
    eventType,
    payload,
    createdAt: nowIso(),
  }

  writeSyncOutbox([...outbox, event])
  writeSyncSettings({
    ...settings,
    nextSyncSequence: sequence + 1,
  })
}

const markSyncEventsPushed = (eventIds: string[]): void => {
  if (eventIds.length === 0) return
  const sent = new Set(eventIds)
  const current = readSyncOutbox()
  const remaining = current.filter((event) => !sent.has(event.eventId))
  const removedCount = current.length - remaining.length
  if (removedCount === 0) return

  const timestamp = nowIso()
  writeSyncOutbox(remaining)
  writeSyncSettings({
    ...readSyncSettings(),
    backedUpEvents: readSyncSettings().backedUpEvents + removedCount,
    lastBackedUpAt: timestamp,
  })
}

const pushPendingSyncEvents = async (token: string): Promise<number> => {
  let pushedEvents = 0
  while (true) {
    const pending = readSyncOutbox()
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, 100)
    if (pending.length === 0) break

    emitSyncProgress({
      stage: 'push',
      message: `Uploading local events ${pushedEvents + 1}-${pushedEvents + pending.length}.`,
      current: pushedEvents,
      total: pushedEvents + pending.length,
      itemType: 'event',
    })
    await syncHostRequest<{ accepted: number; highestAcceptedSequence: number }>('/sync/events', {
      method: 'POST',
      token,
      body: { events: pending },
    })
    markSyncEventsPushed(pending.map((event) => event.eventId))
    pushedEvents += pending.length
    emitSyncProgress({
      stage: 'push',
      message: `Uploaded ${pushedEvents} local event${pushedEvents === 1 ? '' : 's'}.`,
      current: pushedEvents,
      total: pushedEvents + readSyncOutbox().length,
      itemType: 'event',
    })
  }
  return pushedEvents
}

const uploadFullSnapshot = async (): Promise<void> => {
  const settings = readSyncSettings()
  if (!settings.deviceId || !settings.syncGroupId) return

  const token = await getValidSyncDeviceToken()
  const state = readState()
  const snapshot = buildSnapshot(state)
  const totalItems = snapshot.decks.length + snapshot.cards.length + snapshot.reviewLogs.length + snapshot.media.length
  emitSyncProgress({
    stage: 'snapshot-upload',
    message: `Preparing full snapshot with ${totalItems} item${totalItems === 1 ? '' : 's'}.`,
    current: 0,
    total: totalItems,
  })

  for (const [index, media] of state.media.entries()) {
    emitSyncProgress({
      stage: 'snapshot-upload',
      message: `Uploading media ${index + 1}/${state.media.length}.`,
      current: index + 1,
      total: state.media.length,
      itemType: 'media',
      itemName: media.originalName,
    })
    await syncHostRequest('/media', {
      method: 'POST',
      token,
      body: { sha256: media.sha256, mimeType: media.mimeType, dataBase64: media.dataBase64 },
    })
  }

  emitSyncProgress({
    stage: 'snapshot-upload',
    message: `Uploading full snapshot ${totalItems}/${totalItems}.`,
    current: totalItems,
    total: totalItems,
  })
  await syncHostRequest('/sync/snapshot', { method: 'POST', token, body: { snapshot } })
}

const maybeSeedSnapshot = async (): Promise<void> => {
  const settings = readSyncSettings()
  if (!settings.seedSnapshotPending || !settings.syncGroupId) return
  try {
    await uploadFullSnapshot()
    writeSyncSettings({ ...readSyncSettings(), seedSnapshotPending: false })
  } catch {
    // Leave the flag set so the next sync retries seeding the snapshot.
  }
}

const hydrateFromSnapshot = async (token: string): Promise<boolean> => {
  let response: SyncSnapshotResponse
  try {
    emitSyncProgress({ stage: 'snapshot-download', message: 'Checking for initial content snapshot.' })
    response = await syncHostRequest<SyncSnapshotResponse>('/sync/snapshot', { method: 'GET', token })
  } catch {
    // A host without snapshot support falls back to event-only sync.
    return false
  }
  if (!response.snapshot) return false

  const totalItems =
    response.snapshot.decks.length +
    response.snapshot.cards.length +
    response.snapshot.reviewLogs.length +
    response.snapshot.media.length
  emitSyncProgress({
    stage: 'snapshot-download',
    message: `Downloading initial snapshot with ${totalItems} item${totalItems === 1 ? '' : 's'}.`,
    current: 0,
    total: totalItems,
  })

  const state = readState()
  for (const [index, media] of response.snapshot.media.entries()) {
    if (state.media.some((item) => item.sha256 === media.sha256)) continue
    emitSyncProgress({
      stage: 'snapshot-download',
      message: `Downloading media ${index + 1}/${response.snapshot.media.length}.`,
      current: index + 1,
      total: response.snapshot.media.length,
      itemType: 'media',
      itemName: media.originalName,
    })
    const blob = await syncHostRequest<SyncMediaBlob>(`/media/${media.sha256}`, { method: 'GET', token })
    state.media.push({
      id: media.id,
      sha256: media.sha256,
      mimeType: media.mimeType,
      originalName: media.originalName,
      dataBase64: blob.dataBase64,
    })
  }
  for (const [index, deck] of response.snapshot.decks.entries()) {
    emitSyncProgress({
      stage: 'apply',
      message: `Applying deck ${index + 1}/${response.snapshot.decks.length}: ${deck.name}.`,
      current: index + 1,
      total: response.snapshot.decks.length,
      itemType: 'deck',
      itemName: deck.name,
    })
  }
  for (const [index, card] of response.snapshot.cards.entries()) {
    emitSyncProgress({
      stage: 'apply',
      message: `Applying card ${index + 1}/${response.snapshot.cards.length}.`,
      current: index + 1,
      total: response.snapshot.cards.length,
      itemType: 'card',
      itemName: card.card.id,
    })
  }
  if (response.snapshot.reviewLogs.length > 0) {
    emitSyncProgress({
      stage: 'apply',
      message: `Applying ${response.snapshot.reviewLogs.length} review history entr${response.snapshot.reviewLogs.length === 1 ? 'y' : 'ies'}.`,
      current: response.snapshot.reviewLogs.length,
      total: response.snapshot.reviewLogs.length,
      itemType: 'review',
    })
  }

  applySnapshotBundle(state, response.snapshot)
  writeState(state)

  // Confirm receipt so the host clears the snapshot bundle and its media.
  emitSyncProgress({ stage: 'ack', message: 'Acknowledging initial snapshot.' })
  await syncHostRequest('/sync/snapshot/ack', { method: 'POST', token, body: {} })
  return true
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
          enqueueSyncEvent('deck', deck.id, 'deck.upsert', buildDeckSyncPayload(deck))
          return toSummary(state, deck)
        }),
      delete: async (deckId: string) =>
        mutateState((state) => {
          const deckIds = new Set(getDescendantDeckIds(state, deckId))
          const deletedCardIds = new Set(state.cards.filter((card) => deckIds.has(card.deckId)).map((card) => card.id))
          state.decks = state.decks.filter((deck) => !deckIds.has(deck.id))
          state.cards = state.cards.filter((card) => !deletedCardIds.has(card.id))
          state.reviewLog = state.reviewLog.filter((log) => !deletedCardIds.has(log.cardId))
          enqueueSyncEvent('deck', deckId, 'deck.delete', {})
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
            enqueueSyncEvent('card', card.id, 'card.upsert', buildCardSyncPayload(card))
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
          enqueueSyncEvent('card', card.id, 'card.upsert', buildCardSyncPayload(card))
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
          enqueueSyncEvent('card', card.id, 'card.upsert', buildCardSyncPayload(card))
          return toCardSummary(state, card)
        }),
      delete: async (cardId: string) =>
        mutateState((state) => {
          state.cards = state.cards.filter((card) => card.id !== cardId)
          state.reviewLog = state.reviewLog.filter((log) => log.cardId !== cardId)
          enqueueSyncEvent('card', cardId, 'card.delete', {})
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
          enqueueSyncEvent(
            'review',
            card.id,
            'review.answer',
            buildReviewAnswerSyncPayload({
              card,
              reviewedAt: card.lastReviewedAt,
              rating: input.rating,
              elapsedMs: input.elapsedMs ?? 0,
              revealMs: input.revealMs ?? 0,
              answerMs: input.answerMs ?? 0,
              previousDueAt,
              nextDueAt,
            })
          )

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
        const sameHost = hostUrl === current.hostUrl
        const next = {
          ...current,
          hostUrl,
          deviceToken: sameHost ? current.deviceToken : null,
          deviceTokenExpiresAt: sameHost ? current.deviceTokenExpiresAt : null,
          lastHostCursor: sameHost ? current.lastHostCursor : 0,
          backedUpEvents: sameHost ? current.backedUpEvents : 0,
          lastBackedUpAt: sameHost ? current.lastBackedUpAt : null,
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
        if (input.mode === 'copy-phone-to-desktop') {
          writeSyncSettings({ ...readSyncSettings(), seedSnapshotPending: true })
        }

        const result = await syncHostRequest<SyncConfirmPairingResult>('/pairing/confirm', {
          method: 'POST',
          body: {
            pairingCode: input.pairingCode,
            deviceId: device.deviceId,
            mode: input.mode,
          },
        })
        if (result.completed && result.syncGroupId) {
          writeSyncSettings({
            ...readSyncSettings(),
            syncGroupId: result.syncGroupId,
          })
          const token = await requestSyncDeviceToken()
          writeSyncSettings({
            ...readSyncSettings(),
            deviceToken: token.token,
            deviceTokenExpiresAt: token.expiresAt,
          })
          if (input.mode === 'copy-phone-to-desktop') await maybeSeedSnapshot()
        }
        return result
      },
      syncNow: async (): Promise<SyncRunResult> => {
        const settings = readSyncSettings()
        if (!settings.syncGroupId) throw new Error('Pair this device before syncing.')

        const token = await getValidSyncDeviceToken()
        emitSyncProgress({ stage: 'pairing', message: 'Sync device is paired.' })

        // Seed the snapshot if this phone is the source (retry after a failed
        // confirm-time upload); otherwise hydrate from the source's one-time
        // full snapshot (decks, cards, review-log history, media) before events.
        await maybeSeedSnapshot()
        const hydratedFromSnapshot = await hydrateFromSnapshot(token)

        const pushedEvents = await pushPendingSyncEvents(token)
        let pulledEvents = 0
        let appliedEvents = 0
        let cursor = readSyncSettings().lastHostCursor

        while (true) {
          emitSyncProgress({
            stage: 'pull',
            message: `Checking host updates after cursor ${cursor}.`,
            current: pulledEvents,
            itemType: 'event',
          })
          const result = await syncHostRequest<{ events: RemoteSyncEvent[]; nextCursor: number }>(
            `/sync/events?after=${cursor}&limit=100`,
            { method: 'GET', token }
          )

          pulledEvents += result.events.length
          if (result.events.length > 0) {
            const state = readState()
            for (const event of result.events) {
              emitSyncProgress({
                stage: 'apply',
                message: `Applying ${event.eventType} update.`,
                current: appliedEvents + 1,
                total: pulledEvents,
                itemType: event.entityType,
                itemName: event.entityId,
              })
              if (applyRemoteSyncEvent(state, event)) appliedEvents += 1
            }
            writeState(state)
          }

          cursor = result.nextCursor
          writeSyncSettings({ ...readSyncSettings(), lastHostCursor: cursor })

          if (result.events.length < 100) break
        }

        emitSyncProgress({ stage: 'ack', message: `Acknowledging host cursor ${cursor}.`, current: cursor })
        await syncHostRequest<{ ok: boolean }>('/sync/ack', {
          method: 'POST',
          token,
          body: { lastEventId: cursor },
        })

        if (appliedEvents > 0 || hydratedFromSnapshot) sessions.clear()
        emitSyncProgress({
          stage: 'complete',
          message: `Sync complete. Sent ${pushedEvents}, received ${pulledEvents}, applied ${appliedEvents}.`,
        })

        return {
          pushedEvents,
          pulledEvents,
          appliedEvents,
          pendingEvents: readSyncOutbox().length,
          lastHostCursor: cursor,
          backedUpEvents: readSyncSettings().backedUpEvents,
          lastBackedUpAt: readSyncSettings().lastBackedUpAt,
        }
      },
      onProgress: (listener) => {
        syncProgressListeners.add(listener)
        return () => {
          syncProgressListeners.delete(listener)
        }
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
