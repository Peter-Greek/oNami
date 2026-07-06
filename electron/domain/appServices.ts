import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import OpenAI from 'openai'
import { safeStorage } from 'electron'
import { z } from 'zod'

import { ApkgImporter } from './apkgImporter'
import { OnamiDatabase, type RemoteSyncEvent } from './database'
import { SchedulerService, selectCardsForMode, type StudySessionRuntime } from './scheduler'
import type {
  AiGenerationOptions,
  AiGenerationResult,
  AiSettings,
  AppSettings,
  AnswerInput,
  AnswerResult,
  AppStats,
  CreateCardInput,
  CreateDeckInput,
  DeckDetail,
  DeckSummary,
  ImportApkgOptions,
  ImportResult,
  SaveAiSettingsInput,
  SaveAppSettingsInput,
  StatsFilterInput,
  SaveSyncSettingsInput,
  StudyMode,
  StudySession,
  StudySessionSettings,
  SyncConfirmPairingInput,
  SyncConfirmPairingResult,
  SyncBackupState,
  SyncEntityType,
  SyncEventPayload,
  SyncEventType,
  SyncHealthResult,
  SyncJoinPairingInput,
  SyncJoinPairingResult,
  SyncMediaBlob,
  SyncMediaRecord,
  SyncProgressEvent,
  SyncRunResult,
  SyncSnapshotResponse,
  ThemeMode,
  SyncStartPairingResult,
  SyncStatus,
  UpdateCardInput,
} from '../../src/shared/types'

type SyncProgressReporter = (event: SyncProgressEvent) => void

interface StoredAiSettings {
  encryptedApiKey: string | null
  model: string
}

interface StoredSyncSettings {
  hostUrl: string
  deviceId: string | null
  deviceName: string | null
  publicKey: string | null
  privateKey: string | null
  syncGroupId: string | null
  deviceToken: string | null
  deviceTokenExpiresAt: string | null
  // Set when this device becomes the snapshot source; cleared once a full
  // snapshot upload succeeds. Persisted so a failed seed is retried on next sync.
  seedSnapshotPending: boolean
}

const AI_SETTINGS_KEY = 'ai.settings'
const APP_SETTINGS_KEY = 'app.settings'
const SYNC_SETTINGS_KEY = 'sync.settings'
const DEFAULT_AI_MODEL = 'gpt-4o-mini'
const DEFAULT_SYNC_HOST_URL = 'http://147.135.31.128:41729'
const DEFAULT_APP_SETTINGS: AppSettings = {
  audioVolume: 0.8,
  themeMode: 'system',
}

const clampAudioVolume = (value: unknown): number => {
  const volume = Number(value)
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULT_APP_SETTINGS.audioVolume
}

const normalizeThemeMode = (value: unknown): ThemeMode =>
  value === 'light' || value === 'dark' || value === 'system' ? value : DEFAULT_APP_SETTINGS.themeMode

const aiDraftSchema = z.object({
  cards: z.array(
    z.object({
      frontHtml: z.string().min(1),
      backHtml: z.string().min(1),
      tags: z.array(z.string()).default([]),
      noteType: z.enum(['basic', 'cloze', 'imported']).default('basic'),
      rationale: z.string().optional(),
    })
  ),
})

export class AppServices {
  private readonly importer = new ApkgImporter()
  private readonly scheduler: SchedulerService
  private readonly sessions = new Map<string, StudySessionRuntime>()

  constructor(private readonly database: OnamiDatabase) {
    this.scheduler = new SchedulerService(database)
  }

  getMediaPath(mediaId: string): string | null {
    return this.database.getMediaPath(mediaId)
  }

  createDeck(input: CreateDeckInput): DeckSummary {
    const deck = this.database.createDeck(input)
    this.queueDeckUpsert(deck.id)
    return deck
  }

  deleteDeck(deckId: string): void {
    this.database.deleteDeck(deckId)
    this.queueSyncEvent('deck', deckId, 'deck.delete', {})
  }

  resetDeckScheduling(deckId: string): void {
    this.database.resetDeckScheduling(deckId)
    for (const card of this.database.listCards(deckId)) {
      this.queueCardUpsert(card.id)
    }
    this.sessions.clear()
  }

  listDecks(): DeckSummary[] {
    return this.database.listDecks()
  }

  getDeck(deckId: string): DeckDetail {
    return this.database.getDeck(deckId)
  }

  createCard(input: CreateCardInput) {
    const card = this.database.createCard(input)
    this.queueCardUpsert(card.id)
    return card
  }

  updateCard(input: UpdateCardInput) {
    const card = this.database.updateCard(input)
    this.queueCardUpsert(card.id)
    return card
  }

  deleteCard(cardId: string): void {
    this.database.deleteCard(cardId)
    this.queueSyncEvent('card', cardId, 'card.delete', {})
  }

  importApkg(filePath: string, options: ImportApkgOptions): ImportResult {
    const parsed = this.importer.parse(filePath)
    const source = 'anki'
    const mediaIdByName = new Map<string, string>()
    const warnings = [...parsed.warnings]

    try {
      for (const media of parsed.media) {
        const record = this.database.upsertMediaFromFile(media.originalName, media.tempPath)
        mediaIdByName.set(media.originalName, record.id)
      }

      let importedNotes = 0
      let updatedNotes = 0
      let importedCards = 0
      let firstDeckId = ''
      let fallbackDeckId = ''
      let firstCardDeckId = ''

      this.database.importTransaction(() => {
        const deckIdByAnkiId = new Map<string, string>()
        const deckByAnkiId = new Map(parsed.decks.map((deck) => [deck.ankiId, deck]))
        const depthOf = (deck: { parentAnkiId: string | null }): number =>
          deck.parentAnkiId && deckByAnkiId.has(deck.parentAnkiId)
            ? 1 + depthOf(deckByAnkiId.get(deck.parentAnkiId)!)
            : 0
        const sortedDecks = [...parsed.decks].sort((a, b) => depthOf(a) - depthOf(b) || a.name.localeCompare(b.name))

        for (const deck of sortedDecks) {
          const parentId = deck.parentAnkiId ? deckIdByAnkiId.get(deck.parentAnkiId) ?? null : null
          const summary = this.database.upsertImportedDeck({
            name: deck.name,
            parentId,
            source,
            sourceId: `deck:${deck.name}:${deck.ankiId}`,
          })
          deckIdByAnkiId.set(deck.ankiId, summary.id)
          if (!fallbackDeckId) fallbackDeckId = summary.id
          if (!firstDeckId && deck.ankiId !== '1') firstDeckId = summary.id
        }

        if (deckIdByAnkiId.size === 0) {
          const fallback = this.database.upsertImportedDeck({
            name: parsed.rootDeckName || path.basename(filePath, '.apkg'),
            parentId: null,
            source,
            sourceId: `deck:${parsed.rootDeckName || path.basename(filePath, '.apkg')}`,
          })
          deckIdByAnkiId.set('1', fallback.id)
          firstDeckId = fallback.id
          fallbackDeckId = fallback.id
        }

        const noteIdByAnkiId = new Map<string, string>()
        for (const note of parsed.notes) {
          const deckId = deckIdByAnkiId.get(note.deckAnkiId) ?? firstDeckId
          const result = this.database.upsertImportedNote({
            deckId,
            noteType: note.modelName,
            fields: note.fields,
            tags: note.tags,
            sourceGuid: `anki:${note.guid}`,
          })
          noteIdByAnkiId.set(note.ankiId, result.id)
          if (result.updated) updatedNotes += 1
          else importedNotes += 1
        }

        for (const card of parsed.cards) {
          const note = parsed.notes.find((candidate) => candidate.ankiId === card.noteAnkiId)
          const noteId = noteIdByAnkiId.get(card.noteAnkiId)
          if (!note || !noteId) {
            warnings.push(`Card ${card.ankiId} could not be imported because its note was missing.`)
            continue
          }
          const deckId = deckIdByAnkiId.get(card.deckAnkiId) ?? firstDeckId
          if (!firstCardDeckId) firstCardDeckId = deckId
          const frontHtml = this.rewriteMedia(card.frontHtml, mediaIdByName)
          const backHtml = this.rewriteMedia(card.backHtml, mediaIdByName)
          const mediaRefs = card.mediaNames
            .map((name) => mediaIdByName.get(name))
            .filter((id): id is string => Boolean(id))
          this.database.upsertImportedCard(
            {
              noteId,
              deckId,
              templateOrd: card.templateOrd,
              frontHtml,
              backHtml,
              mediaRefs,
              sourceCardId: `anki:${note.guid}:${card.templateOrd}`,
              reviewState: card.reviewState,
            },
            options.preserveScheduling
          )
          importedCards += 1
        }
      })

      const resultDeckId = firstDeckId || firstCardDeckId || fallbackDeckId
      const deckName = resultDeckId ? this.database.getDeckSummary(resultDeckId).name : parsed.rootDeckName
      this.queueFullSyncSnapshot()
      return {
        deckId: resultDeckId,
        deckName,
        importedNotes,
        importedCards,
        importedMedia: mediaIdByName.size,
        updatedNotes,
        warnings,
      }
    } finally {
      fs.rmSync(parsed.tempDir, { recursive: true, force: true })
    }
  }

  startSession(deckId: string, mode: StudyMode, settings: StudySessionSettings): StudySession {
    const deck = this.database.getDeck(deckId)
    const selected = selectCardsForMode(deck.cards, mode, settings)
    const id = randomUUID()
    const unitTestThreshold = settings.unitTestThreshold ?? 0.8
    this.sessions.set(id, {
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
      createdAt: new Date().toISOString(),
      unitTestThreshold,
    }
  }

  answer(input: AnswerInput): AnswerResult {
    const session = this.sessions.get(input.sessionId)
    if (!session) throw new Error('Study session not found.')
    const previous = this.database.getReviewState(input.cardId)
    const result = this.scheduler.answer(input, session)
    const reviewedAt = this.database.getReviewState(input.cardId)?.lastReviewedAt ?? new Date().toISOString()
    this.queueSyncEvent(
      'review',
      input.cardId,
      'review.answer',
      this.database.buildReviewAnswerSyncPayload({
        cardId: input.cardId,
        reviewedAt,
        rating: input.rating,
        elapsedMs: input.elapsedMs ?? 0,
        revealMs: input.revealMs ?? 0,
        answerMs: input.answerMs ?? 0,
        previousDueAt: previous?.dueAt ?? null,
        nextDueAt: result.nextDueAt,
      })
    )
    return result
  }

  getAiSettings(): AiSettings {
    const stored = this.getStoredAiSettings()
    return {
      hasApiKey: Boolean(stored.encryptedApiKey),
      model: stored.model,
    }
  }

  saveAiSettings(input: SaveAiSettingsInput): AiSettings {
    const current = this.getStoredAiSettings()
    const next: StoredAiSettings = {
      encryptedApiKey: current.encryptedApiKey,
      model: input.model.trim() || DEFAULT_AI_MODEL,
    }

    if (input.apiKey !== undefined) {
      const trimmed = input.apiKey.trim()
      next.encryptedApiKey = trimmed ? this.encryptApiKey(trimmed) : null
    }

    this.database.setSettingsValue(AI_SETTINGS_KEY, next)
    return this.getAiSettings()
  }

  async generateCards(input: string, options: AiGenerationOptions): Promise<AiGenerationResult> {
    const apiKey = this.getApiKey()
    if (!apiKey) throw new Error('Add an OpenAI API key in Settings before generating cards.')

    const model = options.model?.trim() || this.getStoredAiSettings().model || DEFAULT_AI_MODEL
    const client = new OpenAI({ apiKey })
    const count = Math.min(Math.max(options.count ?? 8, 1), 30)
    const style = options.style

    const completion = await client.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You create concise, high-quality flashcards. Return strict JSON only with a cards array. Each card needs frontHtml, backHtml, tags, noteType, and optional rationale. Use clean HTML tags only.',
        },
        {
          role: 'user',
          content: `Create ${count} ${style} flashcards from these notes:\n\n${input}`,
        },
      ],
    })

    const raw = completion.choices[0]?.message?.content
    if (!raw) throw new Error('The AI response did not include any card drafts.')
    const parsed = aiDraftSchema.parse(JSON.parse(raw))
    return {
      cards: parsed.cards,
      model,
    }
  }

  getStats(filter?: StatsFilterInput): AppStats {
    return this.database.getStats(filter?.deckId)
  }

  getAppSettings(): AppSettings {
    const stored = this.database.getSettingsValue<Partial<AppSettings>>(APP_SETTINGS_KEY, DEFAULT_APP_SETTINGS)
    return {
      audioVolume: clampAudioVolume(stored.audioVolume),
      themeMode: normalizeThemeMode(stored.themeMode),
    }
  }

  saveAppSettings(input: SaveAppSettingsInput): AppSettings {
    const current = this.getAppSettings()
    this.database.setSettingsValue(APP_SETTINGS_KEY, {
      audioVolume: input.audioVolume === undefined ? current.audioVolume : clampAudioVolume(input.audioVolume),
      themeMode: input.themeMode === undefined ? current.themeMode : normalizeThemeMode(input.themeMode),
    })
    return this.getAppSettings()
  }

  getSyncStatus(): SyncStatus {
    const stored = this.getStoredSyncSettings()
    const pendingEvents = this.database.getPendingSyncEventCount()
    const lastHostCursor = this.database.getSyncHostCursor()
    const backup = this.database.getSyncBackupSummary()
    const paired = Boolean(stored.syncGroupId)
    return {
      hostUrl: stored.hostUrl,
      deviceId: stored.deviceId,
      deviceName: stored.deviceName,
      syncGroupId: stored.syncGroupId,
      paired,
      pendingEvents,
      lastHostCursor,
      backedUpEvents: backup.backedUpEvents,
      lastBackedUpAt: backup.lastBackedUpAt,
      backupState: this.getSyncBackupState({
        paired,
        pendingEvents,
        backedUpEvents: backup.backedUpEvents,
        lastHostCursor,
      }),
    }
  }

  saveSyncSettings(input: SaveSyncSettingsInput): SyncStatus {
    const current = this.getStoredSyncSettings()
    const hostUrl = this.normalizeHostUrl(input.hostUrl)
    this.saveStoredSyncSettings({
      ...current,
      hostUrl,
      deviceToken: hostUrl === current.hostUrl ? current.deviceToken : null,
      deviceTokenExpiresAt: hostUrl === current.hostUrl ? current.deviceTokenExpiresAt : null,
    })
    return this.getSyncStatus()
  }

  async checkSyncHealth(): Promise<SyncHealthResult> {
    const stored = this.getStoredSyncSettings()
    try {
      const result = await this.syncHostRequest<{ ok?: boolean; service?: string; time?: string }>('/health', {
        method: 'GET',
      })
      return {
        ok: result.ok === true,
        service: result.service ?? null,
        time: result.time ?? null,
        error: null,
      }
    } catch (error) {
      return {
        ok: false,
        service: null,
        time: null,
        error: error instanceof Error ? error.message : `Could not reach ${stored.hostUrl}.`,
      }
    }
  }

  async startSyncPairing(): Promise<SyncStartPairingResult> {
    const device = this.ensureSyncDevice()
    return this.syncHostRequest<SyncStartPairingResult>('/pairing/start', {
      method: 'POST',
      body: {
        deviceId: device.deviceId,
        name: device.deviceName,
        platform: 'desktop',
        publicKey: device.publicKey,
      },
    })
  }

  async joinSyncPairing(input: SyncJoinPairingInput): Promise<SyncJoinPairingResult> {
    const device = this.ensureSyncDevice()
    return this.syncHostRequest<SyncJoinPairingResult>('/pairing/join', {
      method: 'POST',
      body: {
        pairingCode: input.pairingCode,
        deviceId: device.deviceId,
        name: device.deviceName,
        platform: 'desktop',
        publicKey: device.publicKey,
      },
    })
  }

  async confirmSyncPairing(input: SyncConfirmPairingInput): Promise<SyncConfirmPairingResult> {
    const device = this.ensureSyncDevice()
    if (input.mode !== 'copy-phone-to-desktop') {
      this.saveStoredSyncSettings({
        ...this.getStoredSyncSettings(),
        seedSnapshotPending: true,
      })
    }

    const result = await this.syncHostRequest<SyncConfirmPairingResult>('/pairing/confirm', {
      method: 'POST',
      body: {
        pairingCode: input.pairingCode,
        deviceId: device.deviceId,
        mode: input.mode,
      },
    })

    if (result.completed && result.syncGroupId) {
      this.saveStoredSyncSettings({
        ...this.getStoredSyncSettings(),
        syncGroupId: result.syncGroupId,
      })
      const token = await this.requestSyncDeviceToken()
      this.saveStoredSyncSettings({
        ...this.getStoredSyncSettings(),
        deviceToken: token.token,
        deviceTokenExpiresAt: token.expiresAt,
      })
      if (input.mode !== 'copy-phone-to-desktop') await this.maybeSeedSnapshot()
    }

    return result
  }

  async syncNow(onProgress?: SyncProgressReporter): Promise<SyncRunResult> {
    const stored = this.getStoredSyncSettings()
    if (!stored.syncGroupId) throw new Error('Pair this device before syncing.')

    const token = await this.getValidSyncDeviceToken()
    onProgress?.({ stage: 'pairing', message: 'Sync device is paired.' })

    // If this device is the snapshot source, (re)seed the one-time bundle. If it
    // is a fresh device, hydrate from the source's snapshot. These are mutually
    // exclusive in practice — a source has no snapshot to pull, a target has no
    // pending seed — so ordering is safe.
    await this.maybeSeedSnapshot(onProgress)
    const hydratedFromSnapshot = await this.hydrateFromSnapshot(token, onProgress)

    let pushedEvents = 0
    while (true) {
      const pending = this.database.listPendingSyncEvents(100)
      if (pending.length === 0) break
      onProgress?.({
        stage: 'push',
        message: `Uploading local events ${pushedEvents + 1}-${pushedEvents + pending.length}.`,
        current: pushedEvents,
        total: pushedEvents + pending.length,
        itemType: 'event',
      })
      await this.syncHostRequest<{ accepted: number; highestAcceptedSequence: number }>('/sync/events', {
        method: 'POST',
        token,
        body: { events: pending },
      })
      this.database.markSyncEventsPushed(pending.map((event) => event.eventId))
      pushedEvents += pending.length
      onProgress?.({
        stage: 'push',
        message: `Uploaded ${pushedEvents} local event${pushedEvents === 1 ? '' : 's'}.`,
        current: pushedEvents,
        total: pushedEvents + this.database.getPendingSyncEventCount(),
        itemType: 'event',
      })
    }

    let pulledEvents = 0
    let appliedEvents = 0
    let cursor = this.database.getSyncHostCursor()

    while (true) {
      onProgress?.({
        stage: 'pull',
        message: `Checking host updates after cursor ${cursor}.`,
        current: pulledEvents,
        itemType: 'event',
      })
      const result = await this.syncHostRequest<{
        events: RemoteSyncEvent[]
        nextCursor: number
      }>(`/sync/events?after=${cursor}&limit=100`, {
        method: 'GET',
        token,
      })

      pulledEvents += result.events.length
      for (const event of result.events) {
        onProgress?.({
          stage: 'apply',
          message: `Applying ${event.eventType} update.`,
          current: appliedEvents + 1,
          total: pulledEvents,
          itemType: event.entityType,
          itemName: event.entityId,
        })
        if (this.database.applyRemoteSyncEvent(event)) appliedEvents += 1
      }
      cursor = result.nextCursor
      this.database.setSyncHostCursor(cursor)

      if (result.events.length < 100) break
    }

    onProgress?.({ stage: 'ack', message: `Acknowledging host cursor ${cursor}.`, current: cursor })
    await this.syncHostRequest<{ ok: boolean }>('/sync/ack', {
      method: 'POST',
      token,
      body: { lastEventId: cursor },
    })

    if (appliedEvents > 0 || hydratedFromSnapshot) this.sessions.clear()
    onProgress?.({
      stage: 'complete',
      message: `Sync complete. Sent ${pushedEvents}, received ${pulledEvents}, applied ${appliedEvents}.`,
    })

    return {
      pushedEvents,
      pulledEvents,
      appliedEvents,
      pendingEvents: this.database.getPendingSyncEventCount(),
      lastHostCursor: this.database.getSyncHostCursor(),
      ...this.database.getSyncBackupSummary(),
    }
  }

  private async maybeSeedSnapshot(onProgress?: SyncProgressReporter): Promise<void> {
    const stored = this.getStoredSyncSettings()
    if (!stored.seedSnapshotPending || !stored.syncGroupId) return
    try {
      await this.uploadFullSnapshot(onProgress)
      this.saveStoredSyncSettings({
        ...this.getStoredSyncSettings(),
        seedSnapshotPending: false,
      })
    } catch {
      // Leave the flag set so the next sync retries seeding the snapshot.
    }
  }

  private async uploadFullSnapshot(onProgress?: SyncProgressReporter): Promise<void> {
    const stored = this.getStoredSyncSettings()
    if (!stored.deviceId || !stored.syncGroupId) return

    const token = await this.getValidSyncDeviceToken()
    const snapshot = this.database.buildFullSnapshot()
    const totalItems = snapshot.decks.length + snapshot.cards.length + snapshot.reviewLogs.length + snapshot.media.length
    onProgress?.({
      stage: 'snapshot-upload',
      message: `Preparing full snapshot with ${totalItems} item${totalItems === 1 ? '' : 's'}.`,
      current: 0,
      total: totalItems,
    })

    // Upload blobs first so the target can resolve every media reference.
    for (const [index, media] of snapshot.media.entries()) {
      onProgress?.({
        stage: 'snapshot-upload',
        message: `Uploading media ${index + 1}/${snapshot.media.length}.`,
        current: index + 1,
        total: snapshot.media.length,
        itemType: 'media',
        itemName: media.originalName,
      })
      await this.uploadMediaBlob(media, token)
    }

    onProgress?.({
      stage: 'snapshot-upload',
      message: `Uploading full snapshot ${totalItems}/${totalItems}.`,
      current: totalItems,
      total: totalItems,
    })
    await this.syncHostRequest<{ ok: boolean }>('/sync/snapshot', {
      method: 'POST',
      token,
      body: { snapshot },
    })
  }

  private async hydrateFromSnapshot(token: string, onProgress?: SyncProgressReporter): Promise<boolean> {
    let response: SyncSnapshotResponse
    try {
      onProgress?.({ stage: 'snapshot-download', message: 'Checking for initial content snapshot.' })
      response = await this.syncHostRequest<SyncSnapshotResponse>('/sync/snapshot', {
        method: 'GET',
        token,
      })
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
    onProgress?.({
      stage: 'snapshot-download',
      message: `Downloading initial snapshot with ${totalItems} item${totalItems === 1 ? '' : 's'}.`,
      current: 0,
      total: totalItems,
    })

    for (const [index, media] of response.snapshot.media.entries()) {
      onProgress?.({
        stage: 'snapshot-download',
        message: `Downloading media ${index + 1}/${response.snapshot.media.length}.`,
        current: index + 1,
        total: response.snapshot.media.length,
        itemType: 'media',
        itemName: media.originalName,
      })
      await this.downloadMediaBlob(media, token)
    }
    for (const [index, deck] of response.snapshot.decks.entries()) {
      onProgress?.({
        stage: 'apply',
        message: `Applying deck ${index + 1}/${response.snapshot.decks.length}: ${deck.name}.`,
        current: index + 1,
        total: response.snapshot.decks.length,
        itemType: 'deck',
        itemName: deck.name,
      })
    }
    for (const [index, card] of response.snapshot.cards.entries()) {
      onProgress?.({
        stage: 'apply',
        message: `Applying card ${index + 1}/${response.snapshot.cards.length}.`,
        current: index + 1,
        total: response.snapshot.cards.length,
        itemType: 'card',
        itemName: card.card.id,
      })
    }
    if (response.snapshot.reviewLogs.length > 0) {
      onProgress?.({
        stage: 'apply',
        message: `Applying ${response.snapshot.reviewLogs.length} review history entr${response.snapshot.reviewLogs.length === 1 ? 'y' : 'ies'}.`,
        current: response.snapshot.reviewLogs.length,
        total: response.snapshot.reviewLogs.length,
        itemType: 'review',
      })
    }
    this.database.applySnapshot(response.snapshot)

    // Confirm receipt so the host can clean up the snapshot bundle and its media.
    onProgress?.({ stage: 'ack', message: 'Acknowledging initial snapshot.' })
    await this.syncHostRequest<{ ok: boolean }>('/sync/snapshot/ack', {
      method: 'POST',
      token,
      body: {},
    })
    return true
  }

  private async uploadMediaBlob(media: SyncMediaRecord, token: string): Promise<void> {
    const data = this.database.readMediaBytesByHash(media.sha256)
    if (!data) return
    await this.syncHostRequest<{ sha256: string }>('/media', {
      method: 'POST',
      token,
      body: { sha256: media.sha256, mimeType: media.mimeType, dataBase64: data.toString('base64') },
    })
  }

  private async downloadMediaBlob(media: SyncMediaRecord, token: string): Promise<void> {
    if (this.database.hasMediaHash(media.sha256)) return
    const blob = await this.syncHostRequest<SyncMediaBlob>(`/media/${media.sha256}`, {
      method: 'GET',
      token,
    })
    this.database.saveMediaBlob(media, Buffer.from(blob.dataBase64, 'base64'))
  }

  private rewriteMedia(html: string, mediaIdByName: Map<string, string>): string {
    let rewritten = html.replace(/\[sound:([^\]]+)]/g, (_match, name: string) => {
      const id = mediaIdByName.get(name)
      return id ? `<audio controls src="onami-media://${encodeURIComponent(id)}"></audio>` : ''
    })

    rewritten = rewritten.replace(/\bsrc=(["'])([^"']+)\1/g, (match, quote: string, src: string) => {
      if (src.startsWith('http') || src.startsWith('data:') || src.startsWith('onami-media:')) return match
      const id = mediaIdByName.get(src)
      return id ? `src=${quote}onami-media://${encodeURIComponent(id)}${quote}` : match
    })

    return rewritten
  }

  private getStoredAiSettings(): StoredAiSettings {
    return this.database.getSettingsValue<StoredAiSettings>(AI_SETTINGS_KEY, {
      encryptedApiKey: null,
      model: DEFAULT_AI_MODEL,
    })
  }

  private encryptApiKey(apiKey: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure key storage is not available on this system.')
    }
    return safeStorage.encryptString(apiKey).toString('base64')
  }

  private getApiKey(): string | null {
    const stored = this.getStoredAiSettings()
    if (!stored.encryptedApiKey) return null
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64'))
  }

  private getStoredSyncSettings(): StoredSyncSettings {
    return this.database.getSettingsValue<StoredSyncSettings>(SYNC_SETTINGS_KEY, {
      hostUrl: DEFAULT_SYNC_HOST_URL,
      deviceId: null,
      deviceName: null,
      publicKey: null,
      privateKey: null,
      syncGroupId: null,
      deviceToken: null,
      deviceTokenExpiresAt: null,
      seedSnapshotPending: false,
    })
  }

  private saveStoredSyncSettings(settings: StoredSyncSettings): void {
    this.database.setSettingsValue(SYNC_SETTINGS_KEY, {
      ...settings,
      hostUrl: this.normalizeHostUrl(settings.hostUrl),
    })
  }

  private ensureSyncDevice(): StoredSyncSettings & {
    deviceId: string
    deviceName: string
    publicKey: string
    privateKey: string
  } {
    const stored = this.getStoredSyncSettings()
    if (stored.deviceId && stored.deviceName && stored.publicKey && stored.privateKey) {
      return {
        ...stored,
        deviceId: stored.deviceId,
        deviceName: stored.deviceName,
        publicKey: stored.publicKey,
        privateKey: stored.privateKey,
      }
    }

    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const deviceId = randomUUID()
    const deviceName = `${os.hostname()} desktop`
    const publicKeyPem = String(publicKey.export({ type: 'spki', format: 'pem' }))
    const privateKeyPem = String(privateKey.export({ type: 'pkcs8', format: 'pem' }))
    const next: StoredSyncSettings = {
      ...stored,
      deviceId,
      deviceName,
      publicKey: publicKeyPem,
      privateKey: privateKeyPem,
    }
    this.saveStoredSyncSettings(next)

    return {
      ...next,
      deviceId,
      deviceName,
      publicKey: publicKeyPem,
      privateKey: privateKeyPem,
    }
  }

  private queueDeckUpsert(deckId: string): void {
    this.queueSyncEvent('deck', deckId, 'deck.upsert', this.database.buildDeckSyncPayload(deckId))
  }

  private queueCardUpsert(cardId: string): void {
    this.queueSyncEvent('card', cardId, 'card.upsert', this.database.buildCardSyncPayload(cardId))
  }

  private queueFullSyncSnapshot(): void {
    const stored = this.getStoredSyncSettings()
    if (!stored.deviceId || !stored.syncGroupId) return

    for (const deck of this.database.listSyncDeckPayloads()) {
      this.queueSyncEvent('deck', deck.deck.id, 'deck.upsert', deck)
    }
    for (const card of this.database.listSyncCardPayloads()) {
      this.queueSyncEvent('card', card.card.id, 'card.upsert', card)
    }
  }

  private queueSyncEvent(
    entityType: SyncEntityType,
    entityId: string,
    eventType: SyncEventType,
    payload: SyncEventPayload
  ): void {
    const stored = this.getStoredSyncSettings()
    if (!stored.deviceId || !stored.syncGroupId) return
    this.database.enqueueSyncEvent({
      deviceId: stored.deviceId,
      entityType,
      entityId,
      eventType,
      payload,
    })
  }

  private getSyncBackupState(input: {
    paired: boolean
    pendingEvents: number
    backedUpEvents: number
    lastHostCursor: number
  }): SyncBackupState {
    if (!input.paired) return 'not-paired'
    if (input.pendingEvents > 0) return 'needs-sync'
    if (input.backedUpEvents > 0 || input.lastHostCursor > 0) return 'backed-up'
    return 'no-data'
  }

  private normalizeHostUrl(hostUrl: string): string {
    const trimmed = hostUrl.trim().replace(/\/+$/, '')
    if (!trimmed) return DEFAULT_SYNC_HOST_URL
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Sync host URL must start with http:// or https://.')
    }
    return parsed.toString().replace(/\/+$/, '')
  }

  private async getValidSyncDeviceToken(): Promise<string> {
    const stored = this.getStoredSyncSettings()
    if (
      stored.deviceToken &&
      stored.deviceTokenExpiresAt &&
      Date.parse(stored.deviceTokenExpiresAt) - Date.now() > 5 * 60 * 1000
    ) {
      return stored.deviceToken
    }

    const token = await this.requestSyncDeviceToken()
    this.saveStoredSyncSettings({
      ...this.getStoredSyncSettings(),
      deviceToken: token.token,
      deviceTokenExpiresAt: token.expiresAt,
    })
    return token.token
  }

  private async syncHostRequest<T>(
    path: string,
    options: { method: 'GET' | 'POST'; body?: unknown; token?: string }
  ): Promise<T> {
    const stored = this.getStoredSyncSettings()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    try {
      const response = await fetch(`${stored.hostUrl}${path}`, {
        method: options.method,
        headers: {
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      })
      const text = await response.text()
      const parsed = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string })
      if (!response.ok) {
        throw new Error(parsed.error || `Sync host returned HTTP ${response.status}.`)
      }
      return parsed
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Timed out connecting to ${stored.hostUrl}.`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private async requestSyncDeviceToken(): Promise<{ token: string; expiresAt: string }> {
    const device = this.ensureSyncDevice()
    const timestamp = new Date().toISOString()
    const signature = sign(null, Buffer.from(`${device.deviceId}.${timestamp}`), device.privateKey).toString('base64')

    return this.syncHostRequest<{ token: string; expiresAt: string }>('/devices/token', {
      method: 'POST',
      body: {
        deviceId: device.deviceId,
        timestamp,
        signature,
      },
    })
  }
}
