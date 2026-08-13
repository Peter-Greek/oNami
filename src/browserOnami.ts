import { createEmptyCard, fsrs, Rating, State, type Card as FsrsCard, type Grade } from 'ts-fsrs'

import { createGlobalDecksClient, GLOBAL_DECKS_MAX_PUBLISH_CARDS } from './shared/globalDecks'
import {
  getAvailableSnapshotMedia,
  selectAvailableMediaBatch,
  SNAPSHOT_MEDIA_BATCH_SIZE,
} from './shared/snapshotTransfer'
import { getPairingSnapshotPlan } from './shared/syncPairing'
import { shouldNotifyNativeTransfer } from './shared/transferNotifications'

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
  GlobalDeckCard,
  GlobalDeckMedia,
  GlobalDeckMediaBlob,
  GlobalDeckNode,
  GlobalDeckSummary,
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
  SyncRunOptions,
  SyncSnapshotBundle,
  SyncSnapshotResponse,
  SyncStartPairingResult,
  ThemeMode,
  TransferKind,
  TransferProgressEvent,
  TransferStatus,
  UpdateCardInput,
} from './shared/types'

interface StoredDeck {
  id: string
  parentId: string | null
  name: string
  source: string
  unitTestScore: number | null
  unitTestedAt: string | null
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
  seedSnapshotTargetDeviceId: string | null
  receiveSnapshotPending: boolean
  syncRequested: boolean
}

interface BrowserSyncProgressState {
  active: boolean
  updatedAt: string | null
  events: SyncProgressEvent[]
}

interface BrowserTransferRecord extends TransferProgressEvent {
  targetId: string
  targetName: string
  result?: DeckSummary | GlobalDeckSummary | SyncRunResult
  localDeckIds?: Record<string, string>
  mediaIds?: Record<string, string>
}

const STORAGE_KEY = 'onami.android.mvp.v1'
const SYNC_SETTINGS_KEY = 'onami.sync.settings'
const SYNC_OUTBOX_KEY = 'onami.sync.outbox'
const SYNC_PROGRESS_KEY = 'onami.sync.progress'
const TRANSFER_RECORDS_KEY = 'onami.transfer.records.v1'
const DEFAULT_SYNC_HOST_URL = 'http://147.135.31.128:41729'
const AUTO_SYNC_DELAY_MS = 500
const SNAPSHOT_POLL_DELAY_MS = 1_500
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const syncProgressListeners = new Set<(event: SyncProgressEvent) => void>()
const transferProgressListeners = new Set<(event: TransferProgressEvent) => void>()
let browserWakeLock: { release?: () => Promise<void> } | null = null
let browserAutoSyncTimer: number | null = null
let browserSyncInFlight: Promise<SyncRunResult> | null = null
let browserAutoSyncRunner: ((options?: SyncRunOptions) => Promise<SyncRunResult>) | null = null
let browserTransferRunner: (() => Promise<void>) | null = null
let browserTransferQueueInFlight: Promise<void> | null = null

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
      seedSnapshotTargetDeviceId: parsed.seedSnapshotTargetDeviceId ?? null,
      receiveSnapshotPending: Boolean(parsed.receiveSnapshotPending),
      syncRequested: Boolean(parsed.syncRequested),
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
      seedSnapshotTargetDeviceId: null,
      receiveSnapshotPending: false,
      syncRequested: false,
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

const readTransferRecords = (): BrowserTransferRecord[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(TRANSFER_RECORDS_KEY) || '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((record): record is BrowserTransferRecord =>
      Boolean(
        record &&
          typeof record === 'object' &&
          typeof record.id === 'string' &&
          (record.kind === 'browse-upload' || record.kind === 'browse-download' || record.kind === 'sync') &&
          typeof record.state === 'string' &&
          typeof record.title === 'string' &&
          typeof record.message === 'string' &&
          typeof record.targetId === 'string' &&
          typeof record.targetName === 'string'
      )
    )
  } catch {
    return []
  }
}

const writeTransferRecords = (records: BrowserTransferRecord[]): void => {
  const active = records.filter((record) => record.state !== 'completed' && record.state !== 'error')
  const recent = records
    .filter((record) => record.state === 'completed' || record.state === 'error')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 12)
  localStorage.setItem(TRANSFER_RECORDS_KEY, JSON.stringify([...active, ...recent]))
}

const notifyNativeTransfer = (event: TransferProgressEvent): void => {
  const bridge = window.onamiAndroid
  if (!bridge) return
  const current = Number.isFinite(event.current) ? Math.max(0, Math.trunc(event.current ?? 0)) : 0
  const total = Number.isFinite(event.total) ? Math.max(0, Math.trunc(event.total ?? 0)) : 0
  try {
    if (event.state === 'queued' || event.state === 'running') {
      bridge.updateTransfer(event.id, event.title, event.message, current, total)
    } else if (event.state === 'paused') {
      bridge.pauseTransfer(event.id, event.title, event.message)
    } else {
      const hasMore = readTransferRecords().some(
        (record) => record.id !== event.id && record.state !== 'completed' && record.state !== 'error'
      )
      bridge.finishTransfer(event.id, event.title, event.message, event.state === 'completed', hasMore)
    }
  } catch {
    // Native notifications are best-effort; the durable record remains authoritative.
  }
}

const emitTransferProgress = (
  id: string,
  update: Partial<Omit<BrowserTransferRecord, 'id' | 'kind' | 'targetId' | 'targetName'>>
): BrowserTransferRecord => {
  const records = readTransferRecords()
  const index = records.findIndex((record) => record.id === id)
  if (index < 0) throw new Error(`Transfer ${id} is no longer available.`)
  const previous = records[index]
  const next: BrowserTransferRecord = { ...previous, ...update, updatedAt: nowIso() }
  records[index] = next
  writeTransferRecords(records)
  const event: TransferProgressEvent = next
  for (const listener of transferProgressListeners) listener(event)
  if (shouldNotifyNativeTransfer(previous.state, next.state)) notifyNativeTransfer(event)
  return next
}

const createTransferRecord = (kind: TransferKind, targetId: string, targetName: string): BrowserTransferRecord => {
  const id = `${kind}-${crypto.randomUUID()}`
  const title = kind === 'browse-upload'
    ? `Uploading ${targetName}`
    : kind === 'browse-download'
      ? `Downloading ${targetName}`
      : 'Syncing oNami'
  const record: BrowserTransferRecord = {
    id,
    kind,
    state: 'queued',
    title,
    message: 'Queued and ready to continue in the background.',
    targetId,
    targetName,
    updatedAt: nowIso(),
  }
  writeTransferRecords([...readTransferRecords(), record])
  notifyNativeTransfer(record)
  return record
}

const getTransferStatus = (): TransferStatus => {
  const records = readTransferRecords().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  return {
    active: records.find((record) => record.state === 'running' || record.state === 'queued' || record.state === 'paused') ?? null,
    recent: records.slice(0, 12),
  }
}

const waitForTransfer = async <T,>(id: string): Promise<T> => {
  while (true) {
    const record = readTransferRecords().find((item) => item.id === id)
    if (!record) throw new Error('The transfer record was lost before it completed.')
    if (record.state === 'completed') return record.result as T
    if (record.state === 'paused' || record.state === 'error') throw new Error(record.message)
    await new Promise((resolve) => window.setTimeout(resolve, 150))
  }
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

const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value)

const isValidTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))

const normalizeSyncOutboxForUpload = (): SyncEventRecord[] => {
  const settings = readSyncSettings()
  const events = readSyncOutbox().sort((left, right) => left.sequence - right.sequence)
  const usedSequences = new Set<number>()
  let nextSequence = 1
  let changed = false

  const normalized = events.map((event) => {
    const next: SyncEventRecord = { ...event }

    if (!isUuid(next.eventId)) {
      next.eventId = crypto.randomUUID()
      changed = true
    }
    if (settings.deviceId && next.sourceDeviceId !== settings.deviceId) {
      next.sourceDeviceId = settings.deviceId
      changed = true
    }
    if (!Number.isInteger(next.sequence) || next.sequence <= 0 || usedSequences.has(next.sequence)) {
      while (usedSequences.has(nextSequence)) nextSequence += 1
      next.sequence = nextSequence
      changed = true
    }
    usedSequences.add(next.sequence)
    nextSequence = Math.max(nextSequence, next.sequence + 1)

    if (!isValidTimestamp(next.createdAt)) {
      next.createdAt = nowIso()
      changed = true
    }
    if (!next.payload || typeof next.payload !== 'object' || Array.isArray(next.payload)) {
      next.payload = {}
      changed = true
    }

    return next
  })

  if (changed) {
    writeSyncOutbox(normalized)
    const highestSequence = Math.max(0, ...normalized.map((event) => event.sequence))
    if (readSyncSettings().nextSyncSequence <= highestSequence) {
      writeSyncSettings({ ...readSyncSettings(), nextSyncSequence: highestSequence + 1 })
    }
  }

  return normalized
}

const readSyncProgressState = (): BrowserSyncProgressState => {
  try {
    const raw = localStorage.getItem(SYNC_PROGRESS_KEY)
    const parsed = raw ? (JSON.parse(raw) as Partial<BrowserSyncProgressState>) : {}
    const events = Array.isArray(parsed.events)
      ? parsed.events.filter((event): event is SyncProgressEvent =>
          Boolean(event && typeof event.stage === 'string' && typeof event.message === 'string')
        )
      : []
    return {
      active: Boolean(parsed.active),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      events,
    }
  } catch {
    return { active: false, updatedAt: null, events: [] }
  }
}

const writeSyncProgressState = (state: BrowserSyncProgressState) => {
  try {
    localStorage.setItem(SYNC_PROGRESS_KEY, JSON.stringify({ ...state, events: state.events.slice(0, 20) }))
  } catch {
    // Progress UI is best-effort; media/state writes are the durable checkpoints.
  }
}

const emitSyncProgress = (event: SyncProgressEvent) => {
  const current = readSyncProgressState()
  const active = event.stage !== 'complete' && event.stage !== 'error'
  writeSyncProgressState({
    active,
    updatedAt: nowIso(),
    events: [event, ...current.events].slice(0, 20),
  })
  for (const listener of syncProgressListeners) listener(event)
  const transfer = readTransferRecords().find(
    (record) => record.kind === 'sync' && record.state !== 'completed' && record.state !== 'error'
  )
  if (transfer) {
    emitTransferProgress(transfer.id, {
      state: event.stage === 'complete' ? 'completed' : event.stage === 'error' ? 'paused' : 'running',
      message: event.message,
      current: event.current,
      total: event.total,
      itemName: event.itemName,
    })
  }
}

const scheduleBrowserAutoSync = () => {
  if (!readSyncSettings().syncGroupId || browserAutoSyncTimer !== null) return
  browserAutoSyncTimer = window.setTimeout(() => {
    browserAutoSyncTimer = null
    void browserAutoSyncRunner?.().catch(() => {
      // Background sync is best-effort. Manual sync still reports failures.
    })
  }, AUTO_SYNC_DELAY_MS)
}

const syncStatusFromSettings = (settings: BrowserSyncSettings) => {
  const progress = readSyncProgressState()
  return {
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
    activeProgress: progress.active ? (progress.events[0] ?? null) : null,
    recentProgress: progress.events,
  }
}

const setNativeKeepScreenAwake = (enabled: boolean) => {
  const bridge = window.onamiAndroid
  if (!bridge) return
  try {
    bridge.setKeepScreenAwake(enabled)
  } catch {
    // Native bridge is best-effort; browser wake lock below is the fallback.
  }
}

const acquireSyncWakeLock = async () => {
  setNativeKeepScreenAwake(true)
  const wakeLock = (navigator as Navigator & {
    wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> }
  }).wakeLock
  if (!wakeLock?.request || browserWakeLock) return
  try {
    browserWakeLock = await wakeLock.request('screen')
  } catch {
    browserWakeLock = null
  }
}

const releaseSyncWakeLock = async () => {
  setNativeKeepScreenAwake(false)
  const current = browserWakeLock
  browserWakeLock = null
  try {
    await current?.release?.()
  } catch {
    // Releasing can fail if the browser already revoked the lock.
  }
}

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

const GLOBAL_DECKS_INSTALLATION_KEY = 'onami.globalDecks.installationId'

/**
 * Stable id for this browser install, kept in localStorage so hearts and
 * published decks stay attributable across reloads. It is deliberately not the
 * sync device id: the deck library only ever sees this.
 */
const getInstallationId = (): string => {
  const stored = localStorage.getItem(GLOBAL_DECKS_INSTALLATION_KEY)
  if (stored) return stored
  const installationId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  localStorage.setItem(GLOBAL_DECKS_INSTALLATION_KEY, installationId)
  return installationId
}

const globalDecksClient = createGlobalDecksClient({ installationId: getInstallationId })

const buildGlobalDeckPublishInput = (localDeckId: string) => {
  const state = readState()
  const deck = state.decks.find((item) => item.id === localDeckId)
  if (!deck) throw new Error('Deck not found.')
  const deckIds = new Set(getDescendantDeckIds(state, deck.id))
  const selectedCards = state.cards.filter((card) => deckIds.has(card.deckId))
  if (selectedCards.length === 0) throw new Error('That deck has no cards to publish yet.')
  if (selectedCards.length > GLOBAL_DECKS_MAX_PUBLISH_CARDS) {
    throw new Error(
      `Decks up to ${GLOBAL_DECKS_MAX_PUBLISH_CARDS} cards can be published; this one has ${selectedCards.length}.`
    )
  }
  const decks: GlobalDeckNode[] = state.decks
    .filter((item) => deckIds.has(item.id))
    .map((item) => ({
      sourceDeckId: item.id,
      parentSourceDeckId: item.id === deck.id ? null : item.parentId,
      name: item.name,
      cards: selectedCards
        .filter((card) => card.deckId === item.id)
        .map((card): GlobalDeckCard => ({
          frontHtml: card.frontHtml,
          backHtml: card.backHtml,
          tags: card.tags,
          noteType: card.noteType,
        })),
    }))
  const mediaIds = new Set(selectedCards.flatMap((card) => extractMediaIds(`${card.frontHtml}\n${card.backHtml}`)))
  const selectedMedia = state.media.filter((item) => mediaIds.has(item.id))
  if (selectedMedia.length !== mediaIds.size) throw new Error('One or more deck media files are missing locally.')
  const media: GlobalDeckMedia[] = selectedMedia.map((item) => ({
    sourceMediaId: item.id,
    sha256: item.sha256,
    mimeType: item.mimeType,
    byteSize: base64ByteLength(item.dataBase64),
    originalName: item.originalName,
  }))
  const mediaBlobs: GlobalDeckMediaBlob[] = selectedMedia.map((item) => ({
    sha256: item.sha256,
    mimeType: item.mimeType,
    dataBase64: item.dataBase64,
  }))
  return { sourceDeckId: deck.id, name: deck.name, decks, media, mediaBlobs }
}

const runBrowseUploadTransfer = async (record: BrowserTransferRecord): Promise<void> => {
  const input = buildGlobalDeckPublishInput(record.targetId)
  emitTransferProgress(record.id, {
    state: 'running',
    title: `Uploading ${input.name}`,
    message: 'Preparing deck contents.',
    current: 0,
    total: Math.max(1, input.mediaBlobs.length + 2),
  })
  const published = await globalDecksClient.publish(input, (progress) => {
    emitTransferProgress(record.id, {
      state: 'running',
      message: progress.message,
      current: progress.current,
      total: progress.total,
      itemName: progress.itemName,
    })
  })
  emitTransferProgress(record.id, {
    state: 'completed',
    title: `Uploaded ${published.name}`,
    message: `Published ${published.cardCount} card${published.cardCount === 1 ? '' : 's'}.`,
    current: Math.max(1, input.mediaBlobs.length + 2),
    total: Math.max(1, input.mediaBlobs.length + 2),
    result: published,
  })
}

const runBrowseDownloadTransfer = async (initial: BrowserTransferRecord): Promise<void> => {
  const detail = await globalDecksClient.get(initial.targetId)
  const totalCards = detail.decks.reduce((total, item) => total + item.cards.length, 0)
  if (totalCards === 0) throw new Error('That deck has no cards to add.')
  const total = Math.max(1, detail.media.length + totalCards + detail.decks.length)
  let record = emitTransferProgress(initial.id, {
    state: 'running',
    title: `Downloading ${detail.name}`,
    message: 'Preparing deck download.',
    current: 0,
    total,
  })

  const mediaIds = { ...(record.mediaIds ?? {}) }
  let completed = 0
  for (const media of detail.media) {
    const existing = readState().media.find((item) => item.sha256 === media.sha256)
    if (existing) {
      mediaIds[media.sourceMediaId] = existing.id
      completed += 1
      record = emitTransferProgress(record.id, {
        state: 'running',
        message: `Media ready ${completed}/${detail.media.length}.`,
        current: completed,
        total,
        itemName: media.originalName,
        mediaIds,
      })
      continue
    }

    const localId = mediaIds[media.sourceMediaId] ??
      (readState().media.some((item) => item.id === media.sourceMediaId) ? makeId('media') : media.sourceMediaId)
    mediaIds[media.sourceMediaId] = localId
    record = emitTransferProgress(record.id, {
      state: 'running',
      message: `Downloading media ${completed + 1}/${detail.media.length}.`,
      current: completed,
      total,
      itemName: media.originalName,
      mediaIds,
    })
    const blob = await globalDecksClient.downloadMedia(media.sha256)
    mutateState((state) => {
      if (state.media.some((item) => item.sha256 === media.sha256)) return
      state.media.push({
        id: localId,
        sha256: media.sha256,
        mimeType: media.mimeType,
        originalName: media.originalName,
        dataBase64: blob.dataBase64,
      })
    })
    await flushState()
    completed += 1
    emitTransferProgress(record.id, {
      state: 'running',
      message: `Saved media ${completed}/${detail.media.length}.`,
      current: completed,
      total,
      itemName: media.originalName,
      mediaIds,
    })
  }

  const localDeckIds = { ...(record.localDeckIds ?? {}) }
  for (const deck of detail.decks) localDeckIds[deck.sourceDeckId] ??= makeId('deck')
  record = emitTransferProgress(record.id, { state: 'running', localDeckIds, mediaIds })
  const rootSource = detail.decks.find((deck) => !deck.parentSourceDeckId)
  if (!rootSource) throw new Error('That global deck has no root deck.')
  const rootId = localDeckIds[rootSource.sourceDeckId]
  const alreadyApplied = readState().decks.find((deck) => deck.id === rootId)
  if (!alreadyApplied) {
    mutateState((state) => {
      const pending = [...detail.decks]
      const created = new Set<string>()
      const timestamp = nowIso()
      while (pending.length > 0) {
        const index = pending.findIndex((deck) => !deck.parentSourceDeckId || created.has(deck.parentSourceDeckId))
        if (index < 0) throw new Error('That global deck has an invalid subdeck hierarchy.')
        const [deck] = pending.splice(index, 1)
        const deckId = localDeckIds[deck.sourceDeckId]
        const parentId = deck.parentSourceDeckId ? localDeckIds[deck.parentSourceDeckId] : null
        const storedDeck: StoredDeck = {
          id: deckId,
          parentId,
          name: parentId ? deck.name : uniqueLocalDeckName(deck.name),
          source: 'global-library',
          unitTestScore: null,
          unitTestedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        }
        state.decks.push(storedDeck)
        created.add(deck.sourceDeckId)
        for (const [cardIndex, card] of deck.cards.entries()) {
          const remap = (html: string) => html.replace(/onami-media:\/\/([^"')\s]+)/g, (original, rawId: string) => {
            const localId = mediaIds[decodeURIComponent(rawId)]
            return localId ? `onami-media://${encodeURIComponent(localId)}` : original
          })
          const storedCard: StoredCard = {
            id: makeId('card'),
            noteId: makeId('note'),
            deckId,
            deckNameSnapshot: storedDeck.name,
            templateOrd: cardIndex,
            noteType: card.noteType,
            frontHtml: remap(card.frontHtml),
            backHtml: remap(card.backHtml),
            tags: card.tags,
            fields: {},
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
          state.cards.push(storedCard)
        }
      }
    })
    await flushState()
  }

  const state = readState()
  const root = state.decks.find((deck) => deck.id === rootId)
  if (!root) throw new Error('The downloaded deck could not be saved.')
  // Queue sync only after the imported state is durable. If the app is killed
  // between the IndexedDB commit and this checkpoint, the running transfer is
  // restored and safely queues these idempotent upserts on the next launch.
  const importedDeckIds = new Set(Object.values(localDeckIds))
  for (const deck of state.decks.filter((item) => importedDeckIds.has(item.id))) {
    enqueueSyncEvent('deck', deck.id, 'deck.upsert', buildDeckSyncPayload(deck))
  }
  for (const card of state.cards.filter((item) => importedDeckIds.has(item.deckId))) {
    enqueueSyncEvent('card', card.id, 'card.upsert', buildCardSyncPayload(card))
  }
  const result = toSummary(state, root)
  emitTransferProgress(record.id, {
    state: 'completed',
    title: `Downloaded ${result.name}`,
    message: `Added ${result.totalCards} card${result.totalCards === 1 ? '' : 's'} to your library.`,
    current: total,
    total,
    result,
    localDeckIds,
    mediaIds,
  })
}

const processBrowserTransferQueue = async (): Promise<void> => {
  while (true) {
    const record = readTransferRecords()
      .filter((item) => item.kind !== 'sync' && (item.state === 'queued' || item.state === 'running'))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0]
    if (!record) return
    try {
      if (record.kind === 'browse-upload') await runBrowseUploadTransfer(record)
      else await runBrowseDownloadTransfer(record)
    } catch (error) {
      emitTransferProgress(record.id, {
        state: 'paused',
        message: `${error instanceof Error ? error.message : String(error)} The transfer will resume when oNami reopens or reconnects.`,
      })
      return
    }
  }
}

const runBrowserTransferQueue = (): Promise<void> => {
  if (browserTransferQueueInFlight) return browserTransferQueueInFlight
  const task = (async () => {
    const locks = navigator.locks
    if (locks?.request) await locks.request('onami-transfer-runner', () => processBrowserTransferQueue())
    else await processBrowserTransferQueue()
  })().finally(() => {
    if (browserTransferQueueInFlight === task) browserTransferQueueInFlight = null
  })
  browserTransferQueueInFlight = task
  return task
}

/** Keeps repeated adds of the same library deck distinguishable. */
const uniqueLocalDeckName = (name: string): string => {
  const taken = new Set(readState().decks.map((deck) => deck.name))
  if (!taken.has(name)) return name
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${name} (${suffix})`
    if (!taken.has(candidate)) return candidate
  }
  return `${name} (${Date.now()})`
}

const normalizeThemeMode = (value: unknown): ThemeMode =>
  value === 'light' || value === 'dark' || value === 'system' ? value : 'system'

const clampAudioVolume = (value: unknown): number => {
  const volume = Number(value)
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : defaultAppSettings.audioVolume
}

const normalizeState = (parsed: Partial<StoredState> | null | undefined): StoredState => {
  const source = parsed ?? {}
  return {
    decks: Array.isArray(source.decks)
      ? source.decks.map((deck) => ({
          ...deck,
          unitTestScore:
            typeof deck.unitTestScore === 'number'
              ? Math.min(1, Math.max(0, deck.unitTestScore))
              : null,
          unitTestedAt: deck.unitTestedAt ?? null,
        }))
      : [],
    cards: Array.isArray(source.cards) ? source.cards : [],
    reviewLog: Array.isArray(source.reviewLog) ? source.reviewLog : [],
    media: Array.isArray(source.media) ? source.media : [],
    appSettings: {
      audioVolume: clampAudioVolume(source.appSettings?.audioVolume),
      themeMode: normalizeThemeMode(source.appSettings?.themeMode),
    },
    aiSettings: {
      hasApiKey: Boolean(source.aiSettings?.hasApiKey),
      model: source.aiSettings?.model || 'gpt-4o-mini',
    },
  }
}

// Persistence lives in IndexedDB rather than localStorage: base64 media blobs
// quickly overflow the ~5MB localStorage quota (the "exceeded the quota" error
// on content sync). State is held in memory so the synchronous read/write API is
// unchanged, and mirrored to IndexedDB — the lite state (decks/cards/review
// log/settings) is one record and each media blob is its own record so growing
// the media library never rewrites the whole store.
const IDB_NAME = 'onami'
const IDB_STATE_STORE = 'state'
const IDB_MEDIA_STORE = 'media'
const IDB_STATE_KEY = 'state'

let cachedState: StoredState = clone(defaultState)
const persistedMediaIds = new Set<string>()
let persistChain: Promise<void> = Promise.resolve()
let idbPromise: Promise<IDBDatabase> | null = null

const openStateDb = (): Promise<IDBDatabase> => {
  if (idbPromise) return idbPromise
  idbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(IDB_STATE_STORE)) db.createObjectStore(IDB_STATE_STORE)
      if (!db.objectStoreNames.contains(IDB_MEDIA_STORE)) db.createObjectStore(IDB_MEDIA_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB.'))
  })
  return idbPromise
}

const idbPut = (storeName: string, key: string, value: unknown): Promise<void> =>
  openStateDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite')
        tx.objectStore(storeName).put(value, key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
  )

const idbGetStateRecord = (): Promise<Partial<StoredState> | undefined> =>
  openStateDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const request = db.transaction(IDB_STATE_STORE, 'readonly').objectStore(IDB_STATE_STORE).get(IDB_STATE_KEY)
        request.onsuccess = () => resolve(request.result as Partial<StoredState> | undefined)
        request.onerror = () => reject(request.error)
      })
  )

const idbGetAllMedia = (): Promise<StoredMedia[]> =>
  openStateDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const request = db.transaction(IDB_MEDIA_STORE, 'readonly').objectStore(IDB_MEDIA_STORE).getAll()
        request.onsuccess = () => resolve((request.result as StoredMedia[]) ?? [])
        request.onerror = () => reject(request.error)
      })
  )

const persistState = () => {
  const liteState: StoredState = { ...cachedState, media: [] }
  const newMedia = cachedState.media.filter((media) => !persistedMediaIds.has(media.id))
  for (const media of newMedia) persistedMediaIds.add(media.id)
  persistChain = persistChain
    .then(async () => {
      await idbPut(IDB_STATE_STORE, IDB_STATE_KEY, liteState)
      for (const media of newMedia) await idbPut(IDB_MEDIA_STORE, media.id, media)
    })
    .catch((error) => {
      // Re-queue this batch's media so a later write retries persisting it.
      for (const media of newMedia) persistedMediaIds.delete(media.id)
      console.error('Failed to persist oNami state to IndexedDB.', error)
    })
}

// Resolves once every persist queued so far has been durably written to
// IndexedDB. Sync checkpoints await this before advancing (media downloaded, host
// cursor moved) so an app kill or dropped connection resumes exactly where it
// left off instead of re-downloading or skipping un-persisted data.
const flushState = (): Promise<void> => persistChain

const requestPersistentStorage = async (): Promise<void> => {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist()
    }
  } catch {
    // Best-effort: unsupported WebViews fall back to default (evictable) storage.
  }
}

const loadPersistedState = async (): Promise<void> => {
  try {
    await requestPersistentStorage()
    const record = await idbGetStateRecord()
    if (record) {
      const state = normalizeState(record)
      state.media = await idbGetAllMedia()
      cachedState = state
      persistedMediaIds.clear()
      for (const media of cachedState.media) persistedMediaIds.add(media.id)
      return
    }

    // One-time migration off the localStorage store that overflowed its quota.
    const legacy = localStorage.getItem(STORAGE_KEY)
    cachedState = legacy ? normalizeState(JSON.parse(legacy) as Partial<StoredState>) : clone(defaultState)
    persistedMediaIds.clear()
    if (legacy) {
      await idbPut(IDB_STATE_STORE, IDB_STATE_KEY, { ...cachedState, media: [] })
      for (const media of cachedState.media) await idbPut(IDB_MEDIA_STORE, media.id, media)
      for (const media of cachedState.media) persistedMediaIds.add(media.id)
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch (error) {
    console.error('Failed to load oNami state from IndexedDB.', error)
    cachedState = clone(defaultState)
    persistedMediaIds.clear()
  }
}

const readState = (): StoredState => cachedState

const writeState = (state: StoredState) => {
  cachedState = state
  persistState()
}

const mutateState = <T>(fn: (state: StoredState) => T): T => {
  const result = fn(cachedState)
  persistState()
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
    unitTestScore: deck.unitTestScore,
    unitTestedAt: deck.unitTestedAt,
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
  settings: StudySessionSettings,
  random: () => number = Math.random
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
    const shuffled = [...cards]
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1))
      const current = shuffled[index]
      shuffled[index] = shuffled[swapIndex]
      shuffled[swapIndex] = current
    }
    return shuffled
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
        backHtml: rewriteMediaForDisplay(state, card.backHtml),
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
    unitTestScores: (scopeDeckId
      ? state.decks.filter((deck) => getDescendantDeckIds(state, scopeDeckId).includes(deck.id))
      : state.decks
    ).map((deck) => {
      const children = state.decks.filter((candidate) => candidate.parentId === deck.id)
      return {
        deckId: deck.id,
        deckName: deck.name,
        parentId: deck.parentId,
        score: deck.unitTestScore ?? 0,
        hasTakenTest: deck.unitTestScore !== null,
        testedAt: deck.unitTestedAt,
        subdeckAverage:
          children.length > 0
            ? children.reduce((sum, child) => sum + (child.unitTestScore ?? 0), 0) / children.length
            : null,
        subdeckCount: children.length,
      }
    }),
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
  const existing = state.decks.find((item) => item.id === deck.id)
  const record: StoredDeck = {
    id: deck.id,
    parentId: deck.parentId,
    name: deck.name,
    source: deck.source,
    unitTestScore:
      typeof deck.unitTestScore === 'number'
        ? Math.min(1, Math.max(0, deck.unitTestScore))
        : existing?.unitTestScore ?? null,
    unitTestedAt:
      Object.prototype.hasOwnProperty.call(deck, 'unitTestedAt')
        ? deck.unitTestedAt ?? null
        : existing?.unitTestedAt ?? null,
    createdAt: deck.createdAt,
    updatedAt: deck.updatedAt,
  }
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
      unitTestScore: deck.unitTestScore,
      unitTestedAt: deck.unitTestedAt,
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
    unitTestScore: deck.unitTestScore,
    unitTestedAt: deck.unitTestedAt,
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
    eventId: crypto.randomUUID(),
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
  scheduleBrowserAutoSync()
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
    const pending = normalizeSyncOutboxForUpload().slice(0, 100)
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

  const publishManifest = (uploadComplete: boolean) =>
    syncHostRequest('/sync/snapshot', {
      method: 'POST',
      token,
      body: {
        snapshot,
        targetDeviceId: settings.seedSnapshotTargetDeviceId,
        uploadComplete,
      },
    })

  // Publish the manifest first so the target can apply cards immediately and
  // begin downloading each media batch as soon as it reaches the host.
  await publishManifest(false)
  const mediaByHash = new Map(state.media.map((media) => [media.sha256, media]))
  for (let index = 0; index < snapshot.media.length; index += SNAPSHOT_MEDIA_BATCH_SIZE) {
    const batch = snapshot.media.slice(index, index + SNAPSHOT_MEDIA_BATCH_SIZE)
    emitSyncProgress({
      stage: 'snapshot-upload',
      message: `Uploading media ${index + 1}-${Math.min(index + batch.length, snapshot.media.length)}/${snapshot.media.length}.`,
      current: index,
      total: snapshot.media.length,
      itemType: 'media',
      itemName: batch[0]?.originalName,
    })
    await Promise.all(
      batch.map((metadata) => {
        const media = mediaByHash.get(metadata.sha256)
        if (!media) throw new Error(`Media ${metadata.originalName} is missing from local storage.`)
        return syncHostRequest('/media', {
          method: 'POST',
          token,
          body: { sha256: media.sha256, mimeType: media.mimeType, dataBase64: media.dataBase64 },
        })
      })
    )
    emitSyncProgress({
      stage: 'snapshot-upload',
      message: `Uploaded media ${Math.min(index + batch.length, snapshot.media.length)}/${snapshot.media.length}.`,
      current: Math.min(index + batch.length, snapshot.media.length),
      total: snapshot.media.length,
      itemType: 'media',
      itemName: batch[batch.length - 1]?.originalName,
    })
  }

  emitSyncProgress({
    stage: 'snapshot-upload',
    message: `Uploading full snapshot ${totalItems}/${totalItems}.`,
    current: totalItems,
    total: totalItems,
  })
  await publishManifest(true)
}

const maybeSeedSnapshot = async (): Promise<void> => {
  const settings = readSyncSettings()
  if (!settings.seedSnapshotPending || !settings.syncGroupId) return
  await uploadFullSnapshot()
  writeSyncSettings({
    ...readSyncSettings(),
    seedSnapshotPending: false,
    seedSnapshotTargetDeviceId: null,
  })
}

const hydrateFromSnapshot = async (token: string): Promise<boolean> => {
  const waitForSnapshot = readSyncSettings().receiveSnapshotPending
  let response: SyncSnapshotResponse
  let waitingForManifest = false
  while (true) {
    try {
      emitSyncProgress({
        stage: 'snapshot-download',
        message: waitingForManifest
          ? 'Waiting for the source device to publish its card and media manifest.'
          : 'Checking for initial content snapshot.',
      })
      response = await syncHostRequest<SyncSnapshotResponse>('/sync/snapshot', { method: 'GET', token })
    } catch (error) {
      if (waitForSnapshot) throw error
      // A host without snapshot support falls back to event-only sync.
      return false
    }
    if (response.snapshot) break
    if (!waitForSnapshot) return false
    waitingForManifest = true
    await new Promise<void>((resolve) => window.setTimeout(resolve, SNAPSHOT_POLL_DELAY_MS))
  }
  const snapshot = response.snapshot

  const totalItems =
    snapshot.decks.length +
    snapshot.cards.length +
    snapshot.reviewLogs.length +
    snapshot.media.length
  emitSyncProgress({
    stage: 'snapshot-download',
    message: `Received snapshot manifest with ${totalItems} item${totalItems === 1 ? '' : 's'}.`,
    current: 0,
    total: totalItems,
  })

  // Cards and review history do not need to wait for media. Persist them as
  // soon as the source publishes the manifest while both devices stream blobs.
  let state = readState()
  for (const [index, deck] of snapshot.decks.entries()) {
    emitSyncProgress({
      stage: 'apply',
      message: `Applying deck ${index + 1}/${snapshot.decks.length}: ${deck.name}.`,
      current: index + 1,
      total: snapshot.decks.length,
      itemType: 'deck',
      itemName: deck.name,
    })
  }
  for (const [index, card] of snapshot.cards.entries()) {
    emitSyncProgress({
      stage: 'apply',
      message: `Applying card ${index + 1}/${snapshot.cards.length}.`,
      current: index + 1,
      total: snapshot.cards.length,
      itemType: 'card',
      itemName: card.card.id,
    })
  }
  if (snapshot.reviewLogs.length > 0) {
    emitSyncProgress({
      stage: 'apply',
      message: `Applying ${snapshot.reviewLogs.length} review history entr${snapshot.reviewLogs.length === 1 ? 'y' : 'ies'}.`,
      current: snapshot.reviewLogs.length,
      total: snapshot.reviewLogs.length,
      itemType: 'review',
    })
  }
  applySnapshotBundle(state, snapshot)
  writeState(state)
  await flushState()

  const persistMediaAliases = async (): Promise<void> => {
    const current = readState()
    let changed = false
    for (const media of snapshot.media) {
      if (current.media.some((item) => item.id === media.id)) continue
      const existing = current.media.find((item) => item.sha256 === media.sha256)
      if (!existing) continue
      current.media.push({
        ...existing,
        id: media.id,
        mimeType: media.mimeType,
        originalName: media.originalName,
      })
      changed = true
    }
    if (changed) {
      writeState(current)
      await flushState()
    }
  }
  await persistMediaAliases()

  while (true) {
    state = readState()
    const downloadedSha256 = new Set(
      snapshot.media
        .filter((media) => state.media.some((item) => item.id === media.id && item.sha256 === media.sha256))
        .map((media) => media.sha256)
    )
    const batch = selectAvailableMediaBatch(
      snapshot.media,
      downloadedSha256,
      getAvailableSnapshotMedia(response, snapshot.media)
    )

    if (batch.length > 0) {
      emitSyncProgress({
        stage: 'snapshot-download',
        message: `Downloading available media batch ${downloadedSha256.size + 1}-${Math.min(downloadedSha256.size + batch.length, snapshot.media.length)}/${snapshot.media.length}.`,
        current: downloadedSha256.size,
        total: snapshot.media.length,
        itemType: 'media',
        itemName: batch[0]?.originalName,
      })
      const downloads = await Promise.all(
        batch.map(async (media) => ({
          media,
          blob: await syncHostRequest<SyncMediaBlob>(`/media/${media.sha256}`, { method: 'GET', token }),
        }))
      )
      state = readState()
      for (const { media, blob } of downloads) {
        if (state.media.some((item) => item.id === media.id)) continue
        state.media.push({
          id: media.id,
          sha256: media.sha256,
          mimeType: media.mimeType,
          originalName: media.originalName,
          dataBase64: blob.dataBase64,
        })
      }
      writeState(state)
      // Each completed batch is durable before requesting the next one, so a
      // process death resumes from the last saved batch without re-downloading.
      await flushState()
      await persistMediaAliases()
      const downloadedMediaCount = snapshot.media.filter((media) =>
        readState().media.some((item) => item.id === media.id && item.sha256 === media.sha256)
      ).length
      emitSyncProgress({
        stage: 'snapshot-download',
        message: `Saved media ${downloadedMediaCount}/${snapshot.media.length}.`,
        current: downloadedMediaCount,
        total: snapshot.media.length,
        itemType: 'media',
        itemName: batch[batch.length - 1]?.originalName,
      })
    }

    const downloadedMediaCount = snapshot.media.filter((media) =>
      readState().media.some((item) => item.id === media.id && item.sha256 === media.sha256)
    ).length
    if (downloadedMediaCount === snapshot.media.length && response.uploadComplete !== false) break

    if (batch.length === 0) {
      emitSyncProgress({
        stage: 'snapshot-download',
        message: `Waiting for the next uploaded media batch. Saved ${downloadedMediaCount}/${snapshot.media.length}.`,
        current: downloadedMediaCount,
        total: snapshot.media.length,
        itemType: 'media',
      })
      await new Promise<void>((resolve) => window.setTimeout(resolve, SNAPSHOT_POLL_DELAY_MS))
    }

    const nextResponse = await syncHostRequest<SyncSnapshotResponse>('/sync/snapshot', { method: 'GET', token })
    if (!nextResponse.snapshot) {
      throw new Error('The full snapshot is no longer available. Restart pairing to continue.')
    }
    response = nextResponse
  }

  // Confirm receipt so the host clears the snapshot bundle and its media.
  emitSyncProgress({ stage: 'ack', message: 'Acknowledging initial snapshot.' })
  await syncHostRequest('/sync/snapshot/ack', { method: 'POST', token, body: {} })
  writeSyncSettings({ ...readSyncSettings(), receiveSnapshotPending: false })
  return true
}

export const installBrowserOnami = async () => {
  if (window.onami) return
  document.documentElement.classList.add('browser-shell')

  await loadPersistedState()

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
            unitTestScore: null,
            unitTestedAt: null,
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
    globalDecks: {
      list: (search: string) => globalDecksClient.list(search),
      publish: async (localDeckId: string): Promise<GlobalDeckSummary> => {
        const deck = readState().decks.find((item) => item.id === localDeckId)
        if (!deck) throw new Error('Deck not found.')
        buildGlobalDeckPublishInput(localDeckId)
        const transfer = createTransferRecord('browse-upload', localDeckId, deck.name)
        void runBrowserTransferQueue()
        return waitForTransfer<GlobalDeckSummary>(transfer.id)
      },
      heart: (globalDeckId: string, hearted: boolean) => globalDecksClient.heart(globalDeckId, hearted),
      addToLibrary: async (globalDeckId: string): Promise<DeckSummary> => {
        const transfer = createTransferRecord('browse-download', globalDeckId, 'deck')
        void runBrowserTransferQueue()
        return waitForTransfer<DeckSummary>(transfer.id)
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
          if (!session.cardIds.includes(input.cardId)) {
            throw new Error('Card is not part of this study session.')
          }
          if (session.answered.some((answer) => answer.cardId === input.cardId)) {
            throw new Error('Card has already been answered in this study session.')
          }

          if (session.mode === 'unit-test') {
            if (input.rating !== 'hard' && input.rating !== 'easy') {
              throw new Error('Unit test answers must be Hard or Easy.')
            }

            const testedAt = nowIso()
            if (input.rating === 'hard') {
              card.dueAt = testedAt
              if (card.state === 'New') card.state = 'Learning'
              card.updatedAt = testedAt
              enqueueSyncEvent('card', card.id, 'card.upsert', buildCardSyncPayload(card))
            }

            session.answered.push({ cardId: input.cardId, rating: input.rating })
            const sessionComplete = session.answered.length >= session.cardIds.length
            const unitScore =
              session.answered.filter((answer) => answer.rating === 'easy').length /
              session.answered.length

            if (sessionComplete) {
              const deck = state.decks.find((item) => item.id === session.deckId)
              if (!deck) throw new Error('Deck not found.')
              deck.unitTestScore = unitScore
              deck.unitTestedAt = testedAt
              deck.updatedAt = testedAt
              enqueueSyncEvent('deck', deck.id, 'deck.upsert', buildDeckSyncPayload(deck))
            }

            return {
              cardId: card.id,
              rating: input.rating,
              nextDueAt: card.dueAt,
              state: card.state,
              successRate: card.successRate,
              sessionComplete,
              unitScore,
              recommendation:
                sessionComplete && unitScore < session.unitTestThreshold
                  ? 'Score is below target. Incorrect cards are ready in Review Due.'
                  : null,
            }
          }

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

          return {
            cardId: card.id,
            rating: input.rating,
            nextDueAt,
            state: nextState,
            successRate,
            sessionComplete,
            unitScore: null,
            recommendation: null,
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
        const result = await syncHostRequest<SyncConfirmPairingResult>('/pairing/confirm', {
          method: 'POST',
          body: {
            pairingCode: input.pairingCode,
            deviceId: device.deviceId,
            mode: input.mode,
          },
        })
        if (result.completed && result.syncGroupId) {
          const snapshotPlan = getPairingSnapshotPlan(result, device.deviceId)
          writeSyncSettings({
            ...readSyncSettings(),
            syncGroupId: result.syncGroupId,
            seedSnapshotPending: Boolean(snapshotPlan.uploadTargetDeviceId),
            seedSnapshotTargetDeviceId: snapshotPlan.uploadTargetDeviceId,
            receiveSnapshotPending: snapshotPlan.downloadPending,
          })
          const token = await requestSyncDeviceToken()
          writeSyncSettings({
            ...readSyncSettings(),
            deviceToken: token.token,
            deviceTokenExpiresAt: token.expiresAt,
          })
        }
        return result
      },
      syncNow: async (options?: SyncRunOptions): Promise<SyncRunResult> => {
        if (browserSyncInFlight) return browserSyncInFlight

        const persistent = !options?.background
        const existingTransfer = persistent
          ? readTransferRecords().find(
              (record) => record.kind === 'sync' && record.state !== 'completed' && record.state !== 'error'
            )
          : undefined
        const transfer = !persistent
          ? null
          : existingTransfer
            ? emitTransferProgress(existingTransfer.id, {
                state: 'queued',
                message: 'Sync queued and ready to continue in the background.',
              })
            : createTransferRecord('sync', 'sync', 'oNami')
        if (persistent) writeSyncSettings({ ...readSyncSettings(), syncRequested: true })

        const execute = async (): Promise<SyncRunResult> => {
          const settings = readSyncSettings()
          if (!settings.syncGroupId) throw new Error('Pair this device before syncing.')

            if (persistent) await acquireSyncWakeLock()
          try {
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
                // Persist applied events before advancing the cursor below;
                // otherwise a crash would skip them on the next sync.
                await flushState()
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

            const result = {
              pushedEvents,
              pulledEvents,
              appliedEvents,
              pendingEvents: readSyncOutbox().length,
              lastHostCursor: cursor,
              backedUpEvents: readSyncSettings().backedUpEvents,
              lastBackedUpAt: readSyncSettings().lastBackedUpAt,
            }
            if (persistent) writeSyncSettings({ ...readSyncSettings(), syncRequested: false })
            if (transfer) emitTransferProgress(transfer.id, { state: 'completed', result })
            return result
          } catch (error) {
            emitSyncProgress({
              stage: 'error',
              message: error instanceof Error ? error.message : String(error),
            })
            throw error
          } finally {
            if (persistent) await releaseSyncWakeLock()
          }
        }
        const task = navigator.locks?.request
          ? navigator.locks.request('onami-transfer-runner', execute)
          : execute()

        browserSyncInFlight = task
        try {
          return await task
        } finally {
          if (browserSyncInFlight === task) browserSyncInFlight = null
        }
      },
      onProgress: (listener) => {
        syncProgressListeners.add(listener)
        return () => {
          syncProgressListeners.delete(listener)
        }
      },
    },
    transfers: {
      getStatus: async () => getTransferStatus(),
      onProgress: (listener) => {
        transferProgressListeners.add(listener)
        return () => {
          transferProgressListeners.delete(listener)
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

  browserAutoSyncRunner = api.sync.syncNow
  browserTransferRunner = runBrowserTransferQueue
  window.onami = api

  const resumePendingTransfers = () => {
    const records = readTransferRecords()
    for (const record of records) {
      if (record.state !== 'paused' && record.state !== 'running') continue
      emitTransferProgress(record.id, {
        state: 'queued',
        message: `${record.kind === 'sync' ? 'Sync' : 'Transfer'} restored after interruption.`,
      })
    }
    void browserTransferRunner?.()
    const settings = readSyncSettings()
    if (
      settings.syncGroupId &&
      (
        settings.syncRequested ||
        settings.seedSnapshotPending ||
        settings.receiveSnapshotPending ||
        readSyncOutbox().length > 0
      )
    ) {
      void api.sync.syncNow().catch(() => {
        // The durable sync request stays queued for the next reconnect or launch.
      })
    }
  }
  resumePendingTransfers()
  window.addEventListener('online', resumePendingTransfers)
}
