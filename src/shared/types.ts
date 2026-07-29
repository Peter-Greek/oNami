export type StudyMode = 'learn-new' | 'review-due' | 'mixed' | 'unit-test'

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy'

export type ReviewStateName = 'New' | 'Learning' | 'Review' | 'Relearning'

export type NoteTypeName = 'basic' | 'cloze' | 'imported'

export type ThemeMode = 'system' | 'light' | 'dark'

export interface DeckSummary {
  id: string
  parentId: string | null
  name: string
  source: string
  totalCards: number
  newCards: number
  dueCards: number
  learningCards: number
  reviewCards: number
  successRate: number
  createdAt: string
  updatedAt: string
}

export interface DeckDetail extends DeckSummary {
  cards: CardSummary[]
}

export interface CardSummary {
  id: string
  noteId: string
  deckId: string
  deckName: string
  templateOrd: number
  frontHtml: string
  backHtml: string
  tags: string[]
  state: ReviewStateName
  dueAt: string | null
  reps: number
  lapses: number
  successRate: number
  lastRating: ReviewRating | null
  lastReviewedAt: string | null
}

export interface CreateDeckInput {
  name: string
  parentId?: string | null
}

export interface CreateCardInput {
  deckId: string
  noteType: NoteTypeName
  frontHtml: string
  backHtml: string
  tags?: string[]
  fields?: Record<string, string>
}

export interface UpdateCardInput {
  id: string
  deckId?: string
  frontHtml?: string
  backHtml?: string
  tags?: string[]
}

export interface StudySessionSettings {
  limit?: number
  newEvery?: number
  unitTestEvery?: number
  unitTestThreshold?: number
}

export interface StudyCard extends CardSummary {
  backVisible: boolean
}

export interface StudySession {
  id: string
  mode: StudyMode
  deckId: string
  cards: StudyCard[]
  createdAt: string
  unitTestThreshold: number
}

export interface AnswerInput {
  sessionId: string
  cardId: string
  rating: ReviewRating
  elapsedMs?: number
  revealMs?: number
  answerMs?: number
}

export interface AnswerResult {
  cardId: string
  rating: ReviewRating
  nextDueAt: string | null
  state: ReviewStateName
  successRate: number
  sessionComplete: boolean
  unitScore: number | null
  recommendation: string | null
}

export interface ImportApkgOptions {
  preserveScheduling: boolean
}

export interface ImportResult {
  deckId: string
  deckName: string
  importedNotes: number
  importedCards: number
  importedMedia: number
  updatedNotes: number
  warnings: string[]
}

export interface AiGenerationOptions {
  style: 'basic' | 'cloze' | 'mixed'
  deckId?: string
  count?: number
  model?: string
}

export interface AiDraftCard {
  frontHtml: string
  backHtml: string
  tags: string[]
  noteType: NoteTypeName
  rationale?: string
}

export interface AiGenerationResult {
  cards: AiDraftCard[]
  model: string
}

export interface AiSettings {
  hasApiKey: boolean
  model: string
}

export interface AppSettings {
  audioVolume: number
  themeMode: ThemeMode
}

export interface SaveAiSettingsInput {
  apiKey?: string
  model: string
}

export interface SaveAppSettingsInput {
  audioVolume?: number
  themeMode?: ThemeMode
}

export interface StatsFilterInput {
  deckId?: string | null
}

export interface StudyTimeStats {
  todayMs: number
  weekMs: number
  monthMs: number
  overallMs: number
}

export interface CompletionStats {
  completedCards: number
  totalCards: number
  completionRatio: number
  fullyLearned: boolean
}

export interface HardCardSummary {
  cardId: string
  deckId: string
  deckName: string
  frontHtml: string
  backHtml: string
  state: ReviewStateName
  dueAt: string | null
  reps: number
  lapses: number
  successRate: number
  reviewCount: number
  againCount: number
  easyCount: number
  averageReviewMs: number
  averageRevealMs: number
  averageAgainToEasyMs: number | null
  difficultyScore: number
}

export interface AppStats {
  scopeDeckId: string | null
  scopeDeckName: string | null
  totalDecks: number
  totalCards: number
  newCards: number
  dueCards: number
  reviewedToday: number
  reviewedThisWeek: number
  reviewedThisMonth: number
  totalReviews: number
  averageSuccessRate: number
  streakDays: number
  longestStreakDays: number
  studyTime: StudyTimeStats
  completion: CompletionStats
  averageReviewMs: number
  averageRevealMs: number
  averageAgainToEasyMs: number | null
  hardestCards: HardCardSummary[]
}

export type SyncPairingMode = 'merge' | 'copy-desktop-to-phone' | 'copy-phone-to-desktop'

export type SyncBackupState = 'not-paired' | 'no-data' | 'needs-sync' | 'backed-up'

export type SyncEntityType = 'deck' | 'card' | 'review'

export type SyncEventType = 'deck.upsert' | 'deck.delete' | 'card.upsert' | 'card.delete' | 'review.answer'

export interface SyncReviewStatePayload {
  dueAt: string | null
  state: ReviewStateName
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
}

export interface SyncDeckRecord {
  id: string
  parentId: string | null
  name: string
  source: string
  sourceId: string | null
  createdAt: string
  updatedAt: string
}

export interface SyncNoteRecord {
  id: string
  deckId: string
  noteType: string
  fields: Record<string, string>
  tags: string[]
  sourceGuid: string | null
  createdAt: string
  updatedAt: string
}

export interface SyncCardRecord {
  id: string
  noteId: string
  deckId: string
  templateOrd: number
  frontHtml: string
  backHtml: string
  mediaRefs: string[]
  sourceCardId: string | null
  statsResetAt: string | null
  createdAt: string
  updatedAt: string
}

export interface SyncDeckUpsertPayload {
  version: 1
  deck: SyncDeckRecord
}

export interface SyncCardUpsertPayload {
  version: 1
  note: SyncNoteRecord
  card: SyncCardRecord
  reviewState: SyncReviewStatePayload
}

export interface SyncReviewAnswerPayload {
  version: 1
  cardId: string
  reviewedAt: string
  rating: ReviewRating
  elapsedMs: number
  revealMs: number
  answerMs: number
  previousDueAt: string | null
  nextDueAt: string | null
  reviewState: SyncReviewStatePayload
}

export type SyncEventPayload = SyncDeckUpsertPayload | SyncCardUpsertPayload | SyncReviewAnswerPayload | Record<string, never>

export interface SyncReviewLogRecord {
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

export interface SyncMediaRecord {
  id: string
  sha256: string
  mimeType: string
  byteSize: number
  originalName: string
}

/**
 * A one-time full-data bundle used to hydrate a fresh device (decks, cards with
 * their current review state, the full review-log history for stats/streak, and
 * media metadata). Media blobs are transferred separately, content-addressed by
 * sha256. Delivered through the host and cleaned up once the target device acks.
 */
export interface SyncSnapshotBundle {
  version: 1
  decks: SyncDeckRecord[]
  cards: SyncCardUpsertPayload[]
  reviewLogs: SyncReviewLogRecord[]
  media: SyncMediaRecord[]
}

export interface SyncSnapshotResponse {
  snapshot: SyncSnapshotBundle | null
  sourceDeviceId: string | null
}

export interface SyncMediaBlob {
  sha256: string
  mimeType: string
  dataBase64: string
}

export interface SyncEventRecord {
  eventId: string
  sourceDeviceId: string
  sequence: number
  entityType: SyncEntityType
  entityId: string
  eventType: SyncEventType
  payload: SyncEventPayload
  createdAt: string
}

export interface SyncStatus {
  hostUrl: string
  deviceId: string | null
  deviceName: string | null
  syncGroupId: string | null
  paired: boolean
  pendingEvents: number
  lastHostCursor: number
  backedUpEvents: number
  lastBackedUpAt: string | null
  backupState: SyncBackupState
  activeProgress: SyncProgressEvent | null
  recentProgress: SyncProgressEvent[]
}

export interface SaveSyncSettingsInput {
  hostUrl: string
}

export interface SyncHealthResult {
  ok: boolean
  service: string | null
  time: string | null
  error: string | null
}

export interface SyncStartPairingResult {
  deviceId: string
  pairingCode: string
  confirmationCode: string
  expiresInMs: number
}

export interface SyncJoinPairingInput {
  pairingCode: string
}

export interface SyncJoinPairingResult {
  deviceId: string
  confirmationCode: string
  expiresAt: string
}

export interface SyncConfirmPairingInput {
  pairingCode: string
  mode: SyncPairingMode
}

export interface SyncConfirmPairingResult {
  completed: boolean
  syncGroupId: string | null
  mode: SyncPairingMode
}

export interface SyncRunResult {
  pushedEvents: number
  pulledEvents: number
  appliedEvents: number
  pendingEvents: number
  lastHostCursor: number
  backedUpEvents: number
  lastBackedUpAt: string | null
}

export type SyncProgressStage =
  | 'pairing'
  | 'snapshot-upload'
  | 'snapshot-download'
  | 'push'
  | 'pull'
  | 'apply'
  | 'ack'
  | 'complete'
  | 'error'

export interface SyncProgressEvent {
  stage: SyncProgressStage
  message: string
  current?: number
  total?: number
  itemType?: 'deck' | 'card' | 'review' | 'media' | 'event'
  itemName?: string
}

export interface OnamiApi {
  decks: {
    create(input: CreateDeckInput): Promise<DeckSummary>
    delete(deckId: string): Promise<void>
    resetScheduling(deckId: string): Promise<void>
    list(): Promise<DeckSummary[]>
    get(deckId: string): Promise<DeckDetail>
    selectApkg(): Promise<string | null>
    importApkg(filePath: string, options: ImportApkgOptions): Promise<ImportResult>
  }
  cards: {
    create(input: CreateCardInput): Promise<CardSummary>
    update(input: UpdateCardInput): Promise<CardSummary>
    delete(cardId: string): Promise<void>
  }
  study: {
    startSession(deckId: string, mode: StudyMode, settings: StudySessionSettings): Promise<StudySession>
    answer(input: AnswerInput): Promise<AnswerResult>
  }
  ai: {
    getSettings(): Promise<AiSettings>
    saveSettings(input: SaveAiSettingsInput): Promise<AiSettings>
    generateCards(input: string, options: AiGenerationOptions): Promise<AiGenerationResult>
  }
  settings: {
    get(): Promise<AppSettings>
    save(input: SaveAppSettingsInput): Promise<AppSettings>
  }
  sync: {
    getStatus(): Promise<SyncStatus>
    saveSettings(input: SaveSyncSettingsInput): Promise<SyncStatus>
    checkHealth(): Promise<SyncHealthResult>
    startPairing(): Promise<SyncStartPairingResult>
    joinPairing(input: SyncJoinPairingInput): Promise<SyncJoinPairingResult>
    confirmPairing(input: SyncConfirmPairingInput): Promise<SyncConfirmPairingResult>
    syncNow(): Promise<SyncRunResult>
    onProgress(listener: (event: SyncProgressEvent) => void): () => void
  }
  stats: {
    get(filter?: StatsFilterInput): Promise<AppStats>
  }
  appWindow: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<boolean>
    isMaximized(): Promise<boolean>
    close(): Promise<void>
    openDevTools(): Promise<void>
    onMaximizedChanged(listener: (isMaximized: boolean) => void): () => void
  }
}
