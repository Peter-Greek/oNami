import { createEmptyCard, fsrs, Rating, State, type Card as FsrsCard, type Grade } from 'ts-fsrs'

import { createGlobalDecksClient, GLOBAL_DECKS_MAX_PUBLISH_CARDS } from './shared/globalDecks'
import { createBlobClient, MEDIA_BATCH_SIZE } from './shared/sync/blobClient'
import {
  buildLibraryRecords,
  cardToRecord,
  deckToRecord,
  readCardRecord,
  readDeckRecord,
  readMediaRecord,
  readReviewLogEntry,
  tombstone,
} from './shared/sync/recordMapping'
import { validateRecordEnvelope } from './shared/sync/records'
import type { RecordPage, StoredSyncRecord, SyncRecordEnvelope } from './shared/sync/records'
import { createTransport } from './shared/sync/transport'
import { shouldNotifyNativeTransfer } from './shared/transferNotifications'

import type {
  AiGenerationResult,
  AiSettings,
  AppSettings,
  AppStats,
  AnswerInput,
  AnswerResult,
  AppUpdateStatus,
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
  SyncDeckUpsertPayload,
  SyncHealthResult,
  SyncJoinPairingInput,
  SyncJoinPairingResult,
  SyncMediaRecord,
  SyncProgressEvent,
  SyncReviewLogRecord,
  SyncRunResult,
  SyncRunOptions,
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
  /**
   * Cursor into the old event log. Kept only so an existing install's backup
   * indicator still reads correctly; nothing pulls with it any more.
   */
  lastHostCursor: number
  /**
   * Cursor into the record stream. Deliberately separate from lastHostCursor:
   * an upgrading device already holds a high event cursor, and reusing it would
   * start the record pull past most of the library and silently skip it.
   */
  recordCursor: number
  reviewLogCursor: number
  backedUpEvents: number
  lastBackedUpAt: string | null
  /**
   * Whether this phone has queued its existing library for the first push.
   * Replaces the snapshot seed/receive flags: there is no handoff to arrange,
   * only a one-time backfill of what was here before syncing started.
   */
  libraryQueued: boolean
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
const SYNC_PROGRESS_KEY = 'onami.sync.progress'
const TRANSFER_RECORDS_KEY = 'onami.transfer.records.v1'
const DEFAULT_SYNC_HOST_URL = 'http://147.135.31.128:41729'
const AUTO_SYNC_DELAY_MS = 500
const RECORD_OUTBOX_KEY = 'onami.sync.records.outbox.v1'
const MEDIA_INDEX_KEY = 'onami.sync.media.index.v1'
const REVIEW_SENT_KEY = 'onami.sync.reviews.sent.v1'
/** Records per page, in both directions. Each page is durable on arrival. */
const RECORD_PAGE_SIZE = 500
/** Record and media traffic retries far longer than a control-plane call. */
const TRANSFER_ATTEMPTS = 50
const syncProgressListeners = new Set<(event: SyncProgressEvent) => void>()
const transferProgressListeners = new Set<(event: TransferProgressEvent) => void>()
let browserWakeLock: { release?: () => Promise<void> } | null = null
let browserAutoSyncTimer: number | null = null
let browserAutoSyncDeferred = false
let browserOpenStudySessions = 0
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
      recordCursor: typeof parsed.recordCursor === 'number' ? parsed.recordCursor : 0,
      reviewLogCursor: typeof parsed.reviewLogCursor === 'number' ? parsed.reviewLogCursor : 0,
      backedUpEvents: typeof parsed.backedUpEvents === 'number' ? parsed.backedUpEvents : 0,
      lastBackedUpAt: parsed.lastBackedUpAt ?? null,
      libraryQueued: Boolean(parsed.libraryQueued),
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
      recordCursor: 0,
      reviewLogCursor: 0,
      backedUpEvents: 0,
      lastBackedUpAt: null,
      libraryQueued: false,
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

const cancelBrowserAutoSync = () => {
  if (browserAutoSyncTimer === null) return
  window.clearTimeout(browserAutoSyncTimer)
  browserAutoSyncTimer = null
}

const scheduleBrowserAutoSync = () => {
  if (!readSyncSettings().syncGroupId) return
  // Syncing mid-session interrupts the card the user is on: the transfer
  // banner shifts the layout out from under their thumb, and the run ends by
  // dropping the in-memory sessions, so the next answer fails with "Study
  // session not found". What a session queues goes out once it ends.
  if (browserOpenStudySessions > 0) {
    browserAutoSyncDeferred = true
    cancelBrowserAutoSync()
    return
  }
  if (browserAutoSyncTimer !== null) return
  browserAutoSyncTimer = window.setTimeout(() => {
    browserAutoSyncTimer = null
    void browserAutoSyncRunner?.().catch(() => {
      // Background sync is best-effort. Manual sync still reports failures.
    })
  }, AUTO_SYNC_DELAY_MS)
}

/** Holds automatic syncing for as long as the user is answering cards. */
const beginBrowserStudySession = () => {
  // An auto-sync queued just before the session started would land on the
  // first card; hold it with everything the session itself queues.
  if (browserAutoSyncTimer !== null) browserAutoSyncDeferred = true
  cancelBrowserAutoSync()
  browserOpenStudySessions += 1
}

/** Releases that hold, and runs the sync the session held back. */
const endBrowserStudySession = () => {
  if (browserOpenStudySessions === 0) return
  browserOpenStudySessions -= 1
  if (browserOpenStudySessions > 0 || !browserAutoSyncDeferred) return
  browserAutoSyncDeferred = false
  scheduleBrowserAutoSync()
}

const syncStatusFromSettings = (settings: BrowserSyncSettings) => {
  const progress = readSyncProgressState()
  return {
    hostUrl: settings.hostUrl,
    deviceId: settings.deviceId,
    deviceName: settings.deviceName,
    syncGroupId: settings.syncGroupId,
    paired: Boolean(settings.syncGroupId),
    pendingEvents: readRecordOutbox().length,
    lastHostCursor: settings.recordCursor,
    backedUpEvents: settings.backedUpEvents,
    lastBackedUpAt: settings.lastBackedUpAt,
    backupState: !settings.syncGroupId
      ? ('not-paired' as const)
      : readRecordOutbox().length > 0
        ? ('needs-sync' as const)
        : settings.backedUpEvents > 0 || settings.recordCursor > 0
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

/**
 * Every call to the sync host goes through the shared transport, so the phone
 * gets the same behaviour as the desktop: a request is abandoned only when it
 * stops making progress, and a failure that could succeed later is retried with
 * backoff instead of failing the whole sync. This build previously had no
 * timeout and no retries at all, so one dropped packet ended a transfer.
 */
const syncTransport = createTransport({
  hostUrl: () => readSyncSettings().hostUrl,
  token: () => getValidSyncDeviceToken(),
})

const syncBlobs = createBlobClient({ transport: syncTransport })

const syncHostRequest = async <T,>(
  path: string,
  options: { method: 'GET' | 'POST'; body?: unknown; token?: string; attempts?: number }
): Promise<T> => {
  const response = await syncTransport.request({
    method: options.method,
    path,
    json: options.body,
    // Anonymous at the transport level: callers already hold a token when one
    // is needed, and auto-fetching here would make `/devices/token` recurse.
    anonymous: true,
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    retry: { maxAttempts: options.attempts ?? 4 },
  })
  return response.json<T>()
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
  // Read lazily: the host already holds most files after an interrupted
  // publish, and building base64 for all of them again just to skip them is
  // what made a resumed upload as expensive as the first attempt.
  const readBlob = async (sha256: string): Promise<GlobalDeckMediaBlob | null> => {
    const item = selectedMedia.find((candidate) => candidate.sha256 === sha256)
    return item ? { sha256, mimeType: item.mimeType, dataBase64: item.dataBase64 } : null
  }
  return { sourceDeckId: deck.id, name: deck.name, decks, media, readBlob }
}

const runBrowseUploadTransfer = async (record: BrowserTransferRecord): Promise<void> => {
  const input = buildGlobalDeckPublishInput(record.targetId)
  emitTransferProgress(record.id, {
    state: 'running',
    title: `Uploading ${input.name}`,
    message: 'Preparing deck contents.',
    current: 0,
    total: Math.max(1, input.media.length + 2),
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
    current: Math.max(1, input.media.length + 2),
    total: Math.max(1, input.media.length + 2),
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
    await downloadPublishedMedia(media, localId)
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
    enqueueRecord(deckToRecord(buildDeckSyncPayload(deck).deck))
  }
  for (const card of state.cards.filter((item) => importedDeckIds.has(item.deckId))) {
    enqueueRecord(cardToRecord(buildCardSyncPayload(card)))
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
/** Bytes of a media file that is still downloading, so it survives a restart. */
const IDB_PARTIAL_STORE = 'blobParts'
const IDB_STATE_KEY = 'state'
/**
 * The record outbox shares the state store. It holds full card HTML, so a first
 * push of a whole library is megabytes — far past the localStorage quota it used
 * to live in, which failed the sync with "exceeded the quota" and left the
 * device permanently unable to back itself up.
 */
const IDB_OUTBOX_KEY = 'recordOutbox'
/** One entry per media file, and one id per review ever sent — both unbounded. */
const IDB_MEDIA_INDEX_KEY = 'mediaIndex'
const IDB_REVIEW_SENT_KEY = 'sentReviewIds'
const IDB_VERSION = 2

let cachedState: StoredState = clone(defaultState)
let cachedRecordOutbox: SyncRecordEnvelope[] = []
let recordOutboxPersist: Promise<void> = Promise.resolve()
let cachedMediaIndex: SyncMediaRecord[] = []
let cachedSentReviewIds = new Set<string>()
const persistedMediaIds = new Set<string>()
let persistChain: Promise<void> = Promise.resolve()
let idbPromise: Promise<IDBDatabase> | null = null

const openStateDb = (): Promise<IDBDatabase> => {
  if (idbPromise) return idbPromise
  idbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(IDB_STATE_STORE)) db.createObjectStore(IDB_STATE_STORE)
      if (!db.objectStoreNames.contains(IDB_MEDIA_STORE)) db.createObjectStore(IDB_MEDIA_STORE)
      if (!db.objectStoreNames.contains(IDB_PARTIAL_STORE)) db.createObjectStore(IDB_PARTIAL_STORE)
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

const idbGet = <T,>(storeName: string, key: string): Promise<T | undefined> =>
  openStateDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key)
        request.onsuccess = () => resolve(request.result as T | undefined)
        request.onerror = () => reject(request.error)
      })
  )

const idbDelete = (storeName: string, key: string): Promise<void> =>
  openStateDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite')
        tx.objectStore(storeName).delete(key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
  )

const bytesFromBase64 = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const base64FromBytes = (bytes: Uint8Array): string => {
  // Chunked so a large file cannot blow the argument limit of String.fromCharCode.
  let binary = ''
  const step = 0x8000
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step))
  }
  return btoa(binary)
}

/**
 * Downloads one media file into the local store, continuing from any bytes a
 * previous attempt already saved. Media is kept as base64 because the renderer
 * builds `data:` URLs from it; only the transfer itself is binary.
 */
const downloadMediaToState = async (media: SyncMediaRecord, localId = media.id): Promise<void> => {
  const staged = (await idbGet<Uint8Array>(IDB_PARTIAL_STORE, media.sha256)) ?? new Uint8Array()

  await syncBlobs.download({
    blob: {
      sha256: media.sha256,
      byteSize: media.byteSize,
      mimeType: media.mimeType,
      originalName: media.originalName,
    },
    startOffset: staged.length,
    write: async (chunk, offset) => {
      const base = offset === 0 ? new Uint8Array() : staged
      const merged = new Uint8Array(base.length + chunk.length)
      merged.set(base)
      merged.set(chunk, base.length)
      await idbPut(IDB_PARTIAL_STORE, media.sha256, merged)
    },
  })

  const complete = await idbGet<Uint8Array>(IDB_PARTIAL_STORE, media.sha256)
  if (!complete) throw new Error(`${media.originalName} could not be saved.`)

  mutateState((state) => {
    if (state.media.some((item) => item.id === localId)) return
    state.media.push({
      id: localId,
      sha256: media.sha256,
      mimeType: media.mimeType,
      originalName: media.originalName,
      dataBase64: base64FromBytes(complete),
    })
  })
  await flushState()
  await idbDelete(IDB_PARTIAL_STORE, media.sha256)
}

/**
 * Fetches a published deck's media file, preferring the resumable blob route.
 * Decks published before the host indexed their media have no blob reference
 * yet, so a 404 or 401 falls back to the original base64 route.
 */
const downloadPublishedMedia = async (media: GlobalDeckMedia, localId: string): Promise<void> => {
  try {
    await downloadMediaToState(
      {
        id: localId,
        sha256: media.sha256,
        mimeType: media.mimeType,
        byteSize: media.byteSize,
        originalName: media.originalName,
      },
      localId
    )
    return
  } catch (error) {
    const status = (error as { status?: number | null }).status
    if (status !== 404 && status !== 401) throw error
    await idbDelete(IDB_PARTIAL_STORE, media.sha256).catch(() => undefined)
  }

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
}

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

const parseRecordOutbox = (value: unknown): SyncRecordEnvelope[] => {
  if (!Array.isArray(value)) return []
  return value.filter((record): record is SyncRecordEnvelope => validateRecordEnvelope(record) === null)
}

const parseMediaIndex = (value: unknown): SyncMediaRecord[] =>
  Array.isArray(value)
    ? (value as SyncMediaRecord[]).filter((item) => typeof item?.sha256 === 'string')
    : []

const parseSentReviewIds = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []

/**
 * Hydrates the outbox, moving anything the old localStorage store still holds.
 * A device that failed mid-migration keeps whichever copy has more queued, so a
 * partial write never silently drops changes that were never pushed.
 */
const loadRecordOutbox = async (): Promise<void> => {
  try {
    const stored = parseRecordOutbox(await idbGet<unknown>(IDB_STATE_STORE, IDB_OUTBOX_KEY))
    const legacyRaw = localStorage.getItem(RECORD_OUTBOX_KEY)
    if (legacyRaw === null) {
      cachedRecordOutbox = stored
      return
    }

    const legacy = parseRecordOutbox(JSON.parse(legacyRaw) as unknown)
    const byKey = new Map(stored.map((record) => [`${record.kind}|${record.recordId}`, record]))
    for (const record of legacy) byKey.set(`${record.kind}|${record.recordId}`, record)
    cachedRecordOutbox = [...byKey.values()]
    await idbPut(IDB_STATE_STORE, IDB_OUTBOX_KEY, cachedRecordOutbox)
    localStorage.removeItem(RECORD_OUTBOX_KEY)
  } catch (error) {
    console.error('Failed to load the oNami sync outbox from IndexedDB.', error)
    cachedRecordOutbox = []
  }
}

/**
 * Moves the media index and the sent-review ids off localStorage. Both only
 * ever grow, so they belong beside the outbox rather than in a 5MB bucket.
 * Merging rather than replacing keeps a half-migrated device correct: a media
 * file already downloaded is not re-fetched, and a review already pushed is not
 * pushed twice.
 */
const loadSyncIndexes = async (): Promise<void> => {
  try {
    const storedMedia = await idbGet<SyncMediaRecord[]>(IDB_STATE_STORE, IDB_MEDIA_INDEX_KEY)
    const legacyMediaRaw = localStorage.getItem(MEDIA_INDEX_KEY)
    const byHash = new Map((storedMedia ?? []).map((item) => [item.sha256, item]))
    if (legacyMediaRaw !== null) {
      for (const item of parseMediaIndex(JSON.parse(legacyMediaRaw) as unknown)) byHash.set(item.sha256, item)
    }
    cachedMediaIndex = [...byHash.values()]

    const storedSent = await idbGet<string[]>(IDB_STATE_STORE, IDB_REVIEW_SENT_KEY)
    const legacySentRaw = localStorage.getItem(REVIEW_SENT_KEY)
    cachedSentReviewIds = new Set(storedSent ?? [])
    if (legacySentRaw !== null) {
      for (const id of parseSentReviewIds(JSON.parse(legacySentRaw) as unknown)) cachedSentReviewIds.add(id)
    }

    if (legacyMediaRaw !== null) {
      await idbPut(IDB_STATE_STORE, IDB_MEDIA_INDEX_KEY, cachedMediaIndex)
      localStorage.removeItem(MEDIA_INDEX_KEY)
    }
    if (legacySentRaw !== null) {
      await idbPut(IDB_STATE_STORE, IDB_REVIEW_SENT_KEY, [...cachedSentReviewIds])
      localStorage.removeItem(REVIEW_SENT_KEY)
    }
  } catch (error) {
    console.error('Failed to load oNami sync indexes from IndexedDB.', error)
  }
}

const loadPersistedState = async (): Promise<void> => {
  try {
    await requestPersistentStorage()
    await loadRecordOutbox()
    await loadSyncIndexes()
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

const base64ByteLength = (base64: string): number => {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
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

const readRecordOutbox = (): SyncRecordEnvelope[] => cachedRecordOutbox

/**
 * Mirrors the outbox to IndexedDB on the shared persist chain, so `flushState()`
 * is one durability barrier covering both the library and what is queued about
 * it. Callers stay synchronous, as they were when this was localStorage.
 */
const writeRecordOutbox = (records: SyncRecordEnvelope[]): void => {
  cachedRecordOutbox = records
  const snapshot = records
  // Kept as its own promise as well as on the chain: `flushState` deliberately
  // swallows persist errors, but a caller about to record that the queue is
  // safely stored has to be able to see the write fail.
  recordOutboxPersist = persistChain.then(() => idbPut(IDB_STATE_STORE, IDB_OUTBOX_KEY, snapshot))
  persistChain = recordOutboxPersist.catch((error) => {
    console.error('Failed to persist the oNami sync outbox to IndexedDB.', error)
  })
}

/** Resolves once the queued outbox is durably stored; rejects if it was not. */
const flushRecordOutbox = (): Promise<void> => recordOutboxPersist

const enqueueRecord = (record: SyncRecordEnvelope): void => {
  const settings = readSyncSettings()
  if (!settings.deviceId || !settings.syncGroupId) return

  const key = `${record.kind}|${record.recordId}`
  const outbox = readRecordOutbox().filter((item) => `${item.kind}|${item.recordId}` !== key)
  writeRecordOutbox([...outbox, record])
  scheduleBrowserAutoSync()
}

const enqueueRecords = (records: SyncRecordEnvelope[]): void => {
  const settings = readSyncSettings()
  if (!settings.deviceId || !settings.syncGroupId) return

  const byKey = new Map(readRecordOutbox().map((item) => [`${item.kind}|${item.recordId}`, item]))
  for (const record of records) byKey.set(`${record.kind}|${record.recordId}`, record)
  writeRecordOutbox([...byKey.values()])
  scheduleBrowserAutoSync()
}

/**
 * Clears rows only if nothing re-queued them while the push was in flight, so
 * an edit made during a slow upload is not silently dropped.
 */
const markRecordsPushed = (pushed: SyncRecordEnvelope[]): void => {
  if (pushed.length === 0) return
  const sent = new Map(pushed.map((record) => [`${record.kind}|${record.recordId}`, record]))
  const remaining = readRecordOutbox().filter((record) => {
    const match = sent.get(`${record.kind}|${record.recordId}`)
    return !match || match.updatedAt !== record.updatedAt || match.mergeRank !== record.mergeRank
  })
  const removed = readRecordOutbox().length - remaining.length
  if (removed === 0) return

  writeRecordOutbox(remaining)
  writeSyncSettings({
    ...readSyncSettings(),
    backedUpEvents: readSyncSettings().backedUpEvents + removed,
    lastBackedUpAt: nowIso(),
  })
}

/** Everything this library holds, for a device that has never pushed. */
const buildLibraryRecordsFromState = (state: StoredState): SyncRecordEnvelope[] =>
  buildLibraryRecords({
    decks: state.decks.map((deck) => buildDeckSyncPayload(deck).deck),
    cards: state.cards.map((card) => buildCardSyncPayload(card)),
    media: state.media.map((media) => ({
      id: media.id,
      sha256: media.sha256,
      mimeType: media.mimeType,
      byteSize: base64ByteLength(media.dataBase64),
      originalName: media.originalName,
    })),
  })

/**
 * Applies one page of records. A record whose payload cannot be read is skipped
 * rather than thrown, so one bad row cannot wedge sync for every device.
 */
const applyRecordPage = (state: StoredState, records: StoredSyncRecord[]): { applied: number; skipped: number } => {
  let applied = 0
  let skipped = 0

  for (const record of records) {
    if (record.kind === 'deck') {
      if (record.deleted) {
        state.decks = state.decks.filter((deck) => deck.id !== record.recordId)
      } else {
        const deck = readDeckRecord(record)
        if (!deck) {
          skipped += 1
          continue
        }
        applyDeckUpsert(state, { version: 1, deck })
      }
    } else if (record.kind === 'card') {
      if (record.deleted) {
        state.cards = state.cards.filter((card) => card.id !== record.recordId)
      } else {
        const payload = readCardRecord(record)
        if (!payload) {
          skipped += 1
          continue
        }
        applyCardUpsert(state, payload)
      }
    } else if (record.kind === 'media') {
      const media = readMediaRecord(record)
      if (!media) {
        skipped += 1
        continue
      }
      const index = readMediaIndex().filter((item) => item.sha256 !== media.sha256)
      writeMediaIndex(record.deleted ? index : [...index, media])
    } else {
      skipped += 1
      continue
    }
    applied += 1
  }

  return { applied, skipped }
}

/**
 * Media this library is supposed to have, learned from media records. Compared
 * against what is actually stored to decide what to download, so an interrupted
 * download is retried without re-reading the record stream.
 */
const readMediaIndex = (): SyncMediaRecord[] => cachedMediaIndex

const writeMediaIndex = (media: SyncMediaRecord[]): void => {
  cachedMediaIndex = media
  const snapshot = media
  persistChain = persistChain
    .then(() => idbPut(IDB_STATE_STORE, IDB_MEDIA_INDEX_KEY, snapshot))
    .catch((error) => {
      console.error('Failed to persist the oNami media index to IndexedDB.', error)
    })
}

const listMissingMedia = (): SyncMediaRecord[] => {
  const stored = new Set(readState().media.map((item) => item.sha256))
  return readMediaIndex().filter((item) => !stored.has(item.sha256))
}

/** Reviews already sent, so the append-only stream is pushed once each. */
const readSentReviewIds = (): Set<string> => cachedSentReviewIds

const markReviewsSent = (ids: string[]): void => {
  for (const id of ids) cachedSentReviewIds.add(id)
  const snapshot = [...cachedSentReviewIds]
  persistChain = persistChain
    .then(() => idbPut(IDB_STATE_STORE, IDB_REVIEW_SENT_KEY, snapshot))
    .catch((error) => {
      console.error('Failed to persist sent review ids to IndexedDB.', error)
    })
}

const listUnsentReviewLogs = (limit = 500): SyncReviewLogRecord[] => {
  const sent = readSentReviewIds()
  return readState()
    .reviewLog.filter((entry) => !sent.has(entry.id))
    .slice(0, limit)
    .map((entry) => ({ ...entry }))
}

/**
 * One sync: push what changed, pull what is new, move the media those records
 * reference.
 *
 * A phone that has never pushed queues its whole library first, and a phone
 * that has never pulled starts from cursor zero. Neither is a special case —
 * there is no snapshot to seed, poll for, or acknowledge, and no source or
 * target device to arrange.
 */
const pushPendingRecords = async (token: string): Promise<number> => {
  let pushed = 0
  while (true) {
    const pending = readRecordOutbox().slice(0, RECORD_PAGE_SIZE)
    if (pending.length === 0) break
    emitSyncProgress({
      stage: 'push',
      message: `Uploading changes ${pushed + 1}-${pushed + pending.length}.`,
      current: pushed,
      total: pushed + readRecordOutbox().length,
      itemType: 'card',
    })
    await syncHostRequest('/records', {
      method: 'POST',
      token,
      body: { records: pending },
      attempts: TRANSFER_ATTEMPTS,
    })
    markRecordsPushed(pending)
    pushed += pending.length
  }
  return pushed
}

const pushPendingReviewLogs = async (token: string): Promise<number> => {
  let sent = 0
  while (true) {
    const entries = listUnsentReviewLogs(RECORD_PAGE_SIZE)
    if (entries.length === 0) break
    await syncHostRequest('/review-log', {
      method: 'POST',
      token,
      body: { entries },
      attempts: TRANSFER_ATTEMPTS,
    })
    markReviewsSent(entries.map((entry) => entry.id))
    sent += entries.length
  }
  return sent
}

const pullRecords = async (token: string): Promise<{ pulled: number; applied: number }> => {
  let pulled = 0
  let applied = 0
  let cursor = readSyncSettings().recordCursor

  while (true) {
    emitSyncProgress({
      stage: 'pull',
      message: cursor === 0 ? 'Fetching your library.' : 'Checking for changes.',
      current: pulled,
      itemType: 'card',
    })
    const page = await syncHostRequest<RecordPage>(
      `/records?since=${cursor}&limit=${RECORD_PAGE_SIZE}`,
      { method: 'GET', token, attempts: TRANSFER_ATTEMPTS }
    )
    if (page.records.length === 0) break

    const state = readState()
    const result = applyRecordPage(state, page.records)
    writeState(state)
    // Persisted before the cursor advances, so a crash re-reads this page
    // rather than skipping past it.
    await flushState()

    applied += result.applied
    pulled += page.records.length
    cursor = page.nextCursor
    writeSyncSettings({ ...readSyncSettings(), recordCursor: cursor })

    emitSyncProgress({
      stage: 'apply',
      message: `Applied ${applied} item${applied === 1 ? '' : 's'}.`,
      current: applied,
      total: pulled,
      itemType: 'card',
    })
    if (page.records.length < RECORD_PAGE_SIZE) break
  }

  return { pulled, applied }
}

const pullReviewLogs = async (token: string): Promise<void> => {
  let cursor = readSyncSettings().reviewLogCursor
  while (true) {
    const page = await syncHostRequest<{ entries: unknown[]; nextCursor: number }>(
      `/review-log?since=${cursor}&limit=${RECORD_PAGE_SIZE}`,
      { method: 'GET', token, attempts: TRANSFER_ATTEMPTS }
    )
    if (page.entries.length === 0) break

    const state = readState()
    const applied: string[] = []
    for (const raw of page.entries) {
      const entry = readReviewLogEntry(raw)
      if (!entry) continue
      if (!state.cards.some((card) => card.id === entry.cardId)) continue
      if (state.reviewLog.some((existing) => existing.id === entry.id)) continue
      state.reviewLog.push({ ...entry })
      applied.push(entry.id)
    }
    writeState(state)
    await flushState()
    // A review that arrived from elsewhere must not be pushed back out.
    markReviewsSent(applied)

    cursor = page.nextCursor
    writeSyncSettings({ ...readSyncSettings(), reviewLogCursor: cursor })
    if (page.entries.length < RECORD_PAGE_SIZE) break
  }
}

/**
 * Uploads any media this phone holds that the host does not. The host is asked
 * which hashes it is missing first, so a file another device already uploaded
 * is never sent twice and a partial one continues from its offset.
 */
const uploadMissingMedia = async (): Promise<void> => {
  const state = readState()
  if (state.media.length === 0) return

  const plan = await syncBlobs.check(state.media.map((media) => media.sha256))
  const needed = new Set([...plan.missing, ...plan.partial.map((item) => item.sha256)])
  const pending = state.media.filter((media) => needed.has(media.sha256))

  for (let index = 0; index < pending.length; index += MEDIA_BATCH_SIZE) {
    const batch = pending.slice(index, index + MEDIA_BATCH_SIZE)
    emitSyncProgress({
      stage: 'snapshot-upload',
      message: `Uploading media ${index + 1}-${Math.min(index + batch.length, pending.length)} of ${pending.length}.`,
      current: index,
      total: pending.length,
      itemType: 'media',
      itemName: batch[0]?.originalName,
    })
    await Promise.all(
      batch.map((media) => {
        const bytes = bytesFromBase64(media.dataBase64)
        return syncBlobs.upload({
          blob: {
            sha256: media.sha256,
            byteSize: bytes.length,
            mimeType: media.mimeType,
            originalName: media.originalName,
          },
          read: async (offset, length) => bytes.subarray(offset, offset + length),
        })
      })
    )
  }
}

/** Fetches media the applied records reference but this phone lacks. */
const downloadMissingMedia = async (): Promise<void> => {
  const missing = listMissingMedia()
  for (const [index, media] of missing.entries()) {
    emitSyncProgress({
      stage: 'snapshot-download',
      message: `Downloading media ${index + 1} of ${missing.length}.`,
      current: index,
      total: missing.length,
      itemType: 'media',
      itemName: media.originalName,
    })
    await downloadMediaToState(media)
  }
}

/**
 * Queues the whole library the first time this phone syncs. After that only
 * actual edits are queued.
 *
 * The flag is only set once the queue is durably written. Queueing used to
 * throw outright when it overflowed its storage quota, which at least meant the
 * flag stayed unset and the next sync tried again; now that the write is
 * asynchronous, waiting for it is what keeps a failed queue from being recorded
 * as a completed one and never retried.
 */
const ensureLibraryQueued = async (): Promise<void> => {
  const settings = readSyncSettings()
  if (settings.libraryQueued || !settings.syncGroupId) return
  enqueueRecords(buildLibraryRecordsFromState(readState()))
  await flushRecordOutbox()
  writeSyncSettings({ ...readSyncSettings(), libraryQueued: true })
}

const browserUpdateStatus = (): AppUpdateStatus => ({
  state: 'unsupported',
  installedVersionCode: 0,
  installedVersionName: 'browser',
  release: null,
  downloadedBytes: 0,
  checkedAt: null,
  error: null,
})

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

  /**
   * Drops a session the user finished, exited, or navigated away from, and
   * releases the sync hold it held. Answering the last card already closes the
   * session, so the renderer's own call for that session is a no-op.
   */
  const closeStudySession = (sessionId: string): void => {
    if (!sessions.delete(sessionId)) return
    endBrowserStudySession()
  }

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
          enqueueRecord(deckToRecord(buildDeckSyncPayload(deck).deck))
          return toSummary(state, deck)
        }),
      delete: async (deckId: string) =>
        mutateState((state) => {
          const deckIds = new Set(getDescendantDeckIds(state, deckId))
          const deletedCardIds = new Set(state.cards.filter((card) => deckIds.has(card.deckId)).map((card) => card.id))
          state.decks = state.decks.filter((deck) => !deckIds.has(deck.id))
          state.cards = state.cards.filter((card) => !deletedCardIds.has(card.id))
          state.reviewLog = state.reviewLog.filter((log) => !deletedCardIds.has(log.cardId))
          enqueueRecord(tombstone('deck', deckId))
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
            enqueueRecord(cardToRecord(buildCardSyncPayload(card)))
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
          enqueueRecord(cardToRecord(buildCardSyncPayload(card)))
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
          enqueueRecord(cardToRecord(buildCardSyncPayload(card)))
          return toCardSummary(state, card)
        }),
      delete: async (cardId: string) =>
        mutateState((state) => {
          state.cards = state.cards.filter((card) => card.id !== cardId)
          state.reviewLog = state.reviewLog.filter((log) => log.cardId !== cardId)
          enqueueRecord(tombstone('card', cardId))
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
        beginBrowserStudySession()
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
              enqueueRecord(cardToRecord(buildCardSyncPayload(card)))
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
              enqueueRecord(deckToRecord(buildDeckSyncPayload(deck).deck))
              closeStudySession(session.id)
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
          // Answering moves the card's scheduling, which is a record whose
          // rank rises with each review. The review itself is appended to the
          // log and picked up by the unsent-review push.
          enqueueRecord(cardToRecord(buildCardSyncPayload(card)))

          session.answered.push({ cardId: input.cardId, rating: input.rating })
          const sessionComplete = session.answered.length >= session.cardIds.length
          if (sessionComplete) closeStudySession(session.id)

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
      endSession: async (sessionId: string) => {
        closeStudySession(sessionId)
      },
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
          recordCursor: sameHost ? current.recordCursor : 0,
          reviewLogCursor: sameHost ? current.reviewLogCursor : 0,
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
          // Pairing now only establishes the sync group. Both devices push
          // their records and pull each other's, which merges the libraries;
          // there is no source, target, or direction to arrange.
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

            await ensureLibraryQueued()

            const pushedRecords = await pushPendingRecords(token)
            const sentReviews = await pushPendingReviewLogs(token)
            const { pulled, applied } = await pullRecords(token)
            await pullReviewLogs(token)
            await uploadMissingMedia()
            await downloadMissingMedia()

            emitSyncProgress({
              stage: 'complete',
              message: `Sync complete. Sent ${pushedRecords}, received ${pulled}, applied ${applied}.`,
            })

            const result = {
              pushedEvents: pushedRecords + sentReviews,
              pulledEvents: pulled,
              appliedEvents: applied,
              pendingEvents: readRecordOutbox().length,
              lastHostCursor: readSyncSettings().recordCursor,
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
    // The browser and Android builds are replaced by their own stores and by
    // the APK download card, never by a Windows installer.
    updates: {
      getStatus: async () => browserUpdateStatus(),
      check: async () => browserUpdateStatus(),
      download: async () => {
        throw new Error('This build cannot install its own updates.')
      },
      install: async () => {
        throw new Error('This build cannot install its own updates.')
      },
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
        !settings.libraryQueued ||
        readRecordOutbox().length > 0
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
