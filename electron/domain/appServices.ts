import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import OpenAI from 'openai'
import { safeStorage } from 'electron'
import { z } from 'zod'

import { ApkgImporter } from './apkgImporter'
import { createGlobalDecksClient, GLOBAL_DECKS_MAX_PUBLISH_CARDS } from '../../src/shared/globalDecks'
import {
  getAvailableSnapshotMedia,
  selectAvailableMediaBatch,
  SNAPSHOT_MEDIA_BATCH_SIZE,
} from '../../src/shared/snapshotTransfer'
import { getPairingSnapshotPlan } from '../../src/shared/syncPairing'
import { createBlobClient, type BlobClient } from '../../src/shared/sync/blobClient'
import { createTransport, type Transport } from '../../src/shared/sync/transport'
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
  GlobalDeckCard,
  GlobalDeckHeartResult,
  GlobalDeckMedia,
  GlobalDeckMediaBlob,
  GlobalDeckNode,
  GlobalDeckSummary,
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
  SyncMediaRecord,
  SyncProgressEvent,
  SyncRunResult,
  SyncRunOptions,
  SyncSnapshotResponse,
  ThemeMode,
  TransferKind,
  TransferProgressEvent,
  TransferStatus,
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
  seedSnapshotTargetDeviceId: string | null
  receiveSnapshotPending: boolean
  syncRequested: boolean
}

interface StoredTransferRecord extends TransferProgressEvent {
  targetId: string
  targetName: string
  result?: DeckSummary | GlobalDeckSummary | SyncRunResult
}

const AI_SETTINGS_KEY = 'ai.settings'
const APP_SETTINGS_KEY = 'app.settings'
const SYNC_SETTINGS_KEY = 'sync.settings'
const GLOBAL_DECKS_SETTINGS_KEY = 'globalDecks.settings'
const TRANSFERS_SETTINGS_KEY = 'transfers.records.v1'
const DEFAULT_AI_MODEL = 'gpt-4o-mini'
const DEFAULT_SYNC_HOST_URL = 'http://147.135.31.128:41729'
const SNAPSHOT_POLL_DELAY_MS = 1_500
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
  private autoSyncTimer: NodeJS.Timeout | null = null
  private syncInFlight: Promise<SyncRunResult> | null = null
  private transportInstance: Transport | null = null
  private blobClientInstance: BlobClient | null = null
  private readonly transferListeners = new Set<(event: TransferProgressEvent) => void>()
  private readonly globalTransfersInFlight = new Set<string>()
  private readonly globalDecks = createGlobalDecksClient({
    installationId: () => this.getInstallationId(),
  })

  constructor(private readonly database: OnamiDatabase) {
    this.scheduler = new SchedulerService(database)
  }

  startBackgroundTransfers(): void {
    const resumeTimer = setTimeout(() => {
      void this.resumePendingTransfers()
      const sync = this.getStoredSyncSettings()
      if (
        sync.syncGroupId &&
        (
          sync.syncRequested ||
          sync.seedSnapshotPending ||
          sync.receiveSnapshotPending ||
          this.database.getPendingSyncEventCount() > 0
        )
      ) {
        void this.syncNow().catch(() => {
          // The durable request remains set for the next launch.
        })
      }
    }, 0)
    resumeTimer.unref?.()
  }

  onTransferProgress(listener: (event: TransferProgressEvent) => void): () => void {
    this.transferListeners.add(listener)
    return () => this.transferListeners.delete(listener)
  }

  getTransferStatus(): TransferStatus {
    const records = this.getStoredTransferRecords().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return {
      active: records.find((record) =>
        record.state === 'queued' || record.state === 'running' || record.state === 'paused'
      ) ?? null,
      recent: records.slice(0, 12),
    }
  }

  private getStoredTransferRecords(): StoredTransferRecord[] {
    return this.database.getSettingsValue<StoredTransferRecord[]>(TRANSFERS_SETTINGS_KEY, [])
  }

  private saveStoredTransferRecords(records: StoredTransferRecord[]): void {
    const active = records.filter((record) => record.state !== 'completed' && record.state !== 'error')
    const recent = records
      .filter((record) => record.state === 'completed' || record.state === 'error')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 12)
    this.database.setSettingsValue(TRANSFERS_SETTINGS_KEY, [...active, ...recent])
  }

  private createTransfer(kind: TransferKind, targetId: string, targetName: string): StoredTransferRecord {
    const title = kind === 'browse-upload'
      ? `Uploading ${targetName}`
      : kind === 'browse-download'
        ? `Downloading ${targetName}`
        : 'Syncing oNami'
    const record: StoredTransferRecord = {
      id: `${kind}-${randomUUID()}`,
      kind,
      state: 'queued',
      title,
      message: 'Queued and ready to continue in the background.',
      targetId,
      targetName,
      updatedAt: new Date().toISOString(),
    }
    this.saveStoredTransferRecords([...this.getStoredTransferRecords(), record])
    this.notifyTransfer(record)
    return record
  }

  private updateTransfer(
    id: string,
    update: Partial<Omit<StoredTransferRecord, 'id' | 'kind' | 'targetId'>>
  ): StoredTransferRecord {
    const records = this.getStoredTransferRecords()
    const index = records.findIndex((record) => record.id === id)
    if (index < 0) throw new Error(`Transfer ${id} is no longer available.`)
    const next: StoredTransferRecord = { ...records[index], ...update, updatedAt: new Date().toISOString() }
    records[index] = next
    this.saveStoredTransferRecords(records)
    this.notifyTransfer(next)
    return next
  }

  private notifyTransfer(event: TransferProgressEvent): void {
    for (const listener of this.transferListeners) listener(event)
  }

  private async resumePendingTransfers(): Promise<void> {
    const pending = this.getStoredTransferRecords()
      .filter((record) => record.kind !== 'sync' && record.state !== 'completed' && record.state !== 'error')
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    for (const record of pending) {
      try {
        this.updateTransfer(record.id, {
          state: 'queued',
          message: 'Transfer restored after interruption.',
        })
        if (record.kind === 'browse-upload') await this.publishGlobalDeck(record.targetId, record)
        else await this.addGlobalDeckToLibrary(record.targetId, record)
      } catch {
        // Each operation records its own paused state for the next launch.
      }
    }
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

  listGlobalDecks(search: string): Promise<GlobalDeckSummary[]> {
    return this.globalDecks.list(search)
  }

  /**
   * Publishes a local deck as a card snapshot. Only card content and the deck
   * name leave the device — scheduling, review history and settings never do.
   */
  async publishGlobalDeck(
    localDeckId: string,
    resumeRecord?: StoredTransferRecord
  ): Promise<GlobalDeckSummary> {
    const deck = this.database.getDeck(localDeckId)
    if (deck.cards.length === 0) throw new Error('That deck has no cards to publish yet.')
    if (deck.cards.length > GLOBAL_DECKS_MAX_PUBLISH_CARDS) {
      throw new Error(
        `Decks up to ${GLOBAL_DECKS_MAX_PUBLISH_CARDS} cards can be published; this one has ${deck.cards.length}.`
      )
    }

    const noteTypes = this.database.listCardNoteTypes(localDeckId)
    const allDecks = this.database.listDecks()
    const included = new Set([localDeckId])
    let changed = true
    while (changed) {
      changed = false
      for (const candidate of allDecks) {
        if (candidate.parentId && included.has(candidate.parentId) && !included.has(candidate.id)) {
          included.add(candidate.id)
          changed = true
        }
      }
    }
    const cardsByDeck = new Map<string, GlobalDeckCard[]>()
    const mediaIds = new Set<string>()
    for (const card of deck.cards) {
      const cards = cardsByDeck.get(card.deckId) ?? []
      cards.push({
        frontHtml: card.frontHtml,
        backHtml: card.backHtml,
        tags: card.tags,
        noteType: noteTypes.get(card.id) ?? 'basic',
      })
      cardsByDeck.set(card.deckId, cards)
      for (const mediaId of this.extractMediaIds(`${card.frontHtml}\n${card.backHtml}`)) mediaIds.add(mediaId)
    }
    const decks: GlobalDeckNode[] = allDecks
      .filter((candidate) => included.has(candidate.id))
      .map((candidate) => ({
        sourceDeckId: candidate.id,
        parentSourceDeckId: candidate.id === localDeckId ? null : candidate.parentId,
        name: candidate.name,
        cards: cardsByDeck.get(candidate.id) ?? [],
      }))
    const mediaRecords = this.database.listMediaRecords().filter((media) => mediaIds.has(media.id))
    if (mediaRecords.length !== mediaIds.size) throw new Error('One or more deck media files are missing locally.')
    const media: GlobalDeckMedia[] = mediaRecords.map((item) => ({
      sourceMediaId: item.id,
      sha256: item.sha256,
      mimeType: item.mimeType,
      byteSize: item.byteSize,
      originalName: item.originalName,
    }))
    const readBlob = async (sha256: string): Promise<GlobalDeckMediaBlob | null> => {
      const record = mediaRecords.find((item) => item.sha256 === sha256)
      const bytes = this.database.readMediaBytesByHash(sha256)
      if (!record || !bytes) return null
      return { sha256, mimeType: record.mimeType, dataBase64: bytes.toString('base64') }
    }

    const transfer = resumeRecord ?? this.createTransfer('browse-upload', localDeckId, deck.name)
    if (this.globalTransfersInFlight.has(transfer.id)) {
      throw new Error('That Browse upload is already running.')
    }
    this.globalTransfersInFlight.add(transfer.id)
    try {
      this.updateTransfer(transfer.id, {
        state: 'running',
        title: `Uploading ${deck.name}`,
        message: 'Preparing deck contents.',
        current: 0,
        total: Math.max(1, media.length + 2),
      })
      const result = await this.globalDecks.publish(
        { sourceDeckId: deck.id, name: deck.name, decks, media, readBlob },
        (progress) => this.updateTransfer(transfer.id, {
          state: 'running',
          message: progress.message,
          current: progress.current,
          total: progress.total,
          itemName: progress.itemName,
        })
      )
      this.updateTransfer(transfer.id, {
        state: 'completed',
        title: `Uploaded ${result.name}`,
        message: `Published ${result.cardCount} card${result.cardCount === 1 ? '' : 's'}.`,
        current: Math.max(1, media.length + 2),
        total: Math.max(1, media.length + 2),
        result,
      })
      return result
    } catch (error) {
      this.updateTransfer(transfer.id, {
        state: 'paused',
        message: `${error instanceof Error ? error.message : String(error)} The upload will resume next time oNami opens.`,
      })
      throw error
    } finally {
      this.globalTransfersInFlight.delete(transfer.id)
    }
  }

  heartGlobalDeck(globalDeckId: string, hearted: boolean): Promise<GlobalDeckHeartResult> {
    return this.globalDecks.heart(globalDeckId, hearted)
  }

  /**
   * Copies a published deck into the local library as a brand new deck, so it
   * starts unscheduled and never collides with the copy the publisher has.
   */
  async addGlobalDeckToLibrary(
    globalDeckId: string,
    resumeRecord?: StoredTransferRecord
  ): Promise<DeckSummary> {
    const transfer = resumeRecord ?? this.createTransfer('browse-download', globalDeckId, 'deck')
    if (this.globalTransfersInFlight.has(transfer.id)) {
      throw new Error('That Browse download is already running.')
    }
    this.globalTransfersInFlight.add(transfer.id)
    try {
      this.updateTransfer(transfer.id, { state: 'running', message: 'Fetching deck details.' })
      const detail = await this.globalDecks.get(globalDeckId)
      const totalCards = detail.decks.reduce((total, item) => total + item.cards.length, 0)
      if (totalCards === 0) throw new Error('That deck has no cards to add.')
      const total = Math.max(1, detail.media.length + detail.decks.length + totalCards)
      this.updateTransfer(transfer.id, {
        state: 'running',
        title: `Downloading ${detail.name}`,
        targetName: detail.name,
        message: 'Preparing deck download.',
        current: 0,
        total,
      })

      const mediaIdMap = new Map<string, string>()
      let completed = 0
      for (const media of detail.media) {
        if (!this.database.hasMediaHash(media.sha256)) {
          this.updateTransfer(transfer.id, {
            state: 'running',
            message: `Downloading media ${completed + 1}/${detail.media.length}.`,
            current: completed,
            total,
            itemName: media.originalName,
          })
          const localId = this.database.saveGlobalMediaBlob(
            {
              id: media.sourceMediaId,
              sha256: media.sha256,
              mimeType: media.mimeType,
              byteSize: media.byteSize,
              originalName: media.originalName,
            },
            await this.fetchPublishedMedia(media)
          )
          mediaIdMap.set(media.sourceMediaId, localId)
        } else {
          const local = this.database.listMediaRecords().find((item) => item.sha256 === media.sha256)
          if (local) mediaIdMap.set(media.sourceMediaId, local.id)
        }
        completed += 1
        this.updateTransfer(transfer.id, {
          state: 'running',
          message: `Media ready ${completed}/${detail.media.length}.`,
          current: completed,
          total,
          itemName: media.originalName,
        })
      }

      return this.database.importTransaction(() => {
        const localDeckIds = new Map<string, string>()
        const pending = [...detail.decks]
        let rootDeck: DeckSummary | null = null
        let applied = completed
        while (pending.length > 0) {
          const index = pending.findIndex((item) =>
            !item.parentSourceDeckId || localDeckIds.has(item.parentSourceDeckId)
          )
          if (index < 0) throw new Error('That global deck has an invalid subdeck hierarchy.')
          const [item] = pending.splice(index, 1)
          const created = this.createDeck({
            name: item.parentSourceDeckId ? item.name : this.uniqueLocalDeckName(item.name),
            parentId: item.parentSourceDeckId ? localDeckIds.get(item.parentSourceDeckId) : null,
          })
          if (!item.parentSourceDeckId) rootDeck = created
          localDeckIds.set(item.sourceDeckId, created.id)
          applied += 1
          this.updateTransfer(transfer.id, {
            state: 'running',
            message: `Adding deck ${item.name}.`,
            current: applied,
            total,
            itemName: item.name,
          })
          for (const card of item.cards) {
            this.createCard({
              deckId: created.id,
              noteType: card.noteType,
              frontHtml: this.remapMediaIds(card.frontHtml, mediaIdMap),
              backHtml: this.remapMediaIds(card.backHtml, mediaIdMap),
              tags: card.tags,
            })
            applied += 1
            this.updateTransfer(transfer.id, {
              state: 'running',
              message: `Adding cards ${Math.min(applied, total)}/${total}.`,
              current: Math.min(applied, total),
              total,
            })
          }
        }
        if (!rootDeck) throw new Error('That global deck has no root deck.')
        const result = this.database.getDeckSummary(rootDeck.id)
        this.updateTransfer(transfer.id, {
          state: 'completed',
          title: `Downloaded ${result.name}`,
          message: `Added ${result.totalCards} card${result.totalCards === 1 ? '' : 's'} to your library.`,
          current: total,
          total,
          result,
        })
        return result
      })
    } catch (error) {
      this.updateTransfer(transfer.id, {
        state: 'paused',
        message: `${error instanceof Error ? error.message : String(error)} The download will resume next time oNami opens.`,
      })
      throw error
    } finally {
      this.globalTransfersInFlight.delete(transfer.id)
    }
  }

  private extractMediaIds(html: string): string[] {
    const ids = new Set<string>()
    const pattern = /onami-media:\/\/([^"')\s]+)/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(html)) !== null) ids.add(decodeURIComponent(match[1]))
    return [...ids]
  }

  private remapMediaIds(html: string, ids: Map<string, string>): string {
    return html.replace(/onami-media:\/\/([^"')\s]+)/g, (original, rawId: string) => {
      const sourceId = decodeURIComponent(rawId)
      const localId = ids.get(sourceId)
      return localId ? `onami-media://${encodeURIComponent(localId)}` : original
    })
  }

  /** Keeps repeated adds of the same library deck distinguishable. */
  private uniqueLocalDeckName(name: string): string {
    const taken = new Set(this.database.listDecks().map((deck) => deck.name))
    if (!taken.has(name)) return name
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${name} (${suffix})`
      if (!taken.has(candidate)) return candidate
    }
    return `${name} (${Date.now()})`
  }

  /**
   * Stable per-install id shared with the deck library. It is not the sync
   * device id: it survives pairing changes and is the only identity the
   * library host ever sees.
   */
  private getInstallationId(): string {
    const stored = this.database.getSettingsValue<{ installationId: string | null }>(
      GLOBAL_DECKS_SETTINGS_KEY,
      { installationId: null }
    )
    if (stored.installationId) return stored.installationId

    const installationId = randomUUID()
    this.database.setSettingsValue(GLOBAL_DECKS_SETTINGS_KEY, { installationId })
    return installationId
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

    if (session.mode === 'unit-test') {
      if (input.rating === 'hard') this.queueCardUpsert(input.cardId)
      if (result.sessionComplete) this.queueDeckUpsert(session.deckId)
      return result
    }

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
      activeProgress: null,
      recentProgress: [],
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
    const result = await this.syncHostRequest<SyncConfirmPairingResult>('/pairing/confirm', {
      method: 'POST',
      body: {
        pairingCode: input.pairingCode,
        deviceId: device.deviceId,
        mode: input.mode,
      },
    })

    if (result.completed && result.syncGroupId) {
      const snapshotPlan = getPairingSnapshotPlan(result, device.deviceId)
      this.saveStoredSyncSettings({
        ...this.getStoredSyncSettings(),
        syncGroupId: result.syncGroupId,
        seedSnapshotPending: Boolean(snapshotPlan.uploadTargetDeviceId),
        seedSnapshotTargetDeviceId: snapshotPlan.uploadTargetDeviceId,
        receiveSnapshotPending: snapshotPlan.downloadPending,
      })
      const token = await this.requestSyncDeviceToken()
      this.saveStoredSyncSettings({
        ...this.getStoredSyncSettings(),
        deviceToken: token.token,
        deviceTokenExpiresAt: token.expiresAt,
      })
    }

    return result
  }

  syncNow(options?: SyncRunOptions, onProgress?: SyncProgressReporter): Promise<SyncRunResult> {
    if (this.syncInFlight) return this.syncInFlight
    const stored = this.getStoredSyncSettings()
    if (!stored.syncGroupId) return Promise.reject(new Error('Pair this device before syncing.'))
    const persistent = !options?.background
    const existing = persistent
      ? this.getStoredTransferRecords().find(
          (record) => record.kind === 'sync' && record.state !== 'completed' && record.state !== 'error'
        )
      : undefined
    const transfer = !persistent
      ? null
      : existing
        ? this.updateTransfer(existing.id, {
            state: 'queued',
            message: 'Sync queued and ready to continue in the background.',
          })
        : this.createTransfer('sync', 'sync', 'oNami')
    if (persistent) this.saveStoredSyncSettings({ ...stored, syncRequested: true })
    const report = (event: SyncProgressEvent) => {
      onProgress?.(event)
      if (transfer) this.updateTransfer(transfer.id, {
        state: event.stage === 'complete' ? 'completed' : event.stage === 'error' ? 'paused' : 'running',
        message: event.message,
        current: event.current,
        total: event.total,
        itemName: event.itemName,
      })
    }
    const task = this.runSync(report)
      .then((result) => {
        if (persistent) this.saveStoredSyncSettings({ ...this.getStoredSyncSettings(), syncRequested: false })
        if (transfer) this.updateTransfer(transfer.id, { state: 'completed', result })
        return result
      })
      .catch((error) => {
        if (transfer) this.updateTransfer(transfer.id, {
          state: 'paused',
          message: `${error instanceof Error ? error.message : String(error)} Sync will resume next time oNami opens.`,
        })
        throw error
      })
      .finally(() => {
        if (this.syncInFlight === task) this.syncInFlight = null
      })
    this.syncInFlight = task
    return task
  }

  private async runSync(onProgress?: SyncProgressReporter): Promise<SyncRunResult> {
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
    await this.uploadFullSnapshot(onProgress)
    this.saveStoredSyncSettings({
      ...this.getStoredSyncSettings(),
      seedSnapshotPending: false,
      seedSnapshotTargetDeviceId: null,
    })
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

    const publishManifest = (uploadComplete: boolean) =>
      this.syncHostRequest<{ ok: boolean }>('/sync/snapshot', {
        method: 'POST',
        token,
        body: {
          snapshot,
          targetDeviceId: stored.seedSnapshotTargetDeviceId,
          uploadComplete,
        },
      })

    // Publish first, then upload bounded batches so the target can download in
    // parallel with the source instead of waiting for the entire upload.
    await publishManifest(false)
    for (let index = 0; index < snapshot.media.length; index += SNAPSHOT_MEDIA_BATCH_SIZE) {
      const batch = snapshot.media.slice(index, index + SNAPSHOT_MEDIA_BATCH_SIZE)
      onProgress?.({
        stage: 'snapshot-upload',
        message: `Uploading media ${index + 1}-${Math.min(index + batch.length, snapshot.media.length)}/${snapshot.media.length}.`,
        current: index,
        total: snapshot.media.length,
        itemType: 'media',
        itemName: batch[0]?.originalName,
      })
      await Promise.all(batch.map((media) => this.uploadMediaBlob(media)))
      onProgress?.({
        stage: 'snapshot-upload',
        message: `Uploaded media ${Math.min(index + batch.length, snapshot.media.length)}/${snapshot.media.length}.`,
        current: Math.min(index + batch.length, snapshot.media.length),
        total: snapshot.media.length,
        itemType: 'media',
        itemName: batch[batch.length - 1]?.originalName,
      })
    }

    onProgress?.({
      stage: 'snapshot-upload',
      message: `Uploading full snapshot ${totalItems}/${totalItems}.`,
      current: totalItems,
      total: totalItems,
    })
    await publishManifest(true)
  }

  private async hydrateFromSnapshot(token: string, onProgress?: SyncProgressReporter): Promise<boolean> {
    const waitForSnapshot = this.getStoredSyncSettings().receiveSnapshotPending
    let response: SyncSnapshotResponse
    let waitingForManifest = false
    while (true) {
      try {
        onProgress?.({
          stage: 'snapshot-download',
          message: waitingForManifest
            ? 'Waiting for the source device to publish its card and media manifest.'
            : 'Checking for initial content snapshot.',
        })
        response = await this.syncHostRequest<SyncSnapshotResponse>('/sync/snapshot', {
          method: 'GET',
          token,
        })
      } catch (error) {
        if (waitForSnapshot) throw error
        // A host without snapshot support falls back to event-only sync.
        return false
      }
      if (response.snapshot) break
      if (!waitForSnapshot) return false
      waitingForManifest = true
      await new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_POLL_DELAY_MS))
    }
    const snapshot = response.snapshot

    const totalItems =
      snapshot.decks.length +
      snapshot.cards.length +
      snapshot.reviewLogs.length +
      snapshot.media.length
    onProgress?.({
      stage: 'snapshot-download',
      message: `Received snapshot manifest with ${totalItems} item${totalItems === 1 ? '' : 's'}.`,
      current: 0,
      total: totalItems,
    })

    // Apply cards immediately; media streams independently in durable batches.
    for (const [index, deck] of snapshot.decks.entries()) {
      onProgress?.({
        stage: 'apply',
        message: `Applying deck ${index + 1}/${snapshot.decks.length}: ${deck.name}.`,
        current: index + 1,
        total: snapshot.decks.length,
        itemType: 'deck',
        itemName: deck.name,
      })
    }
    for (const [index, card] of snapshot.cards.entries()) {
      onProgress?.({
        stage: 'apply',
        message: `Applying card ${index + 1}/${snapshot.cards.length}.`,
        current: index + 1,
        total: snapshot.cards.length,
        itemType: 'card',
        itemName: card.card.id,
      })
    }
    if (snapshot.reviewLogs.length > 0) {
      onProgress?.({
        stage: 'apply',
        message: `Applying ${snapshot.reviewLogs.length} review history entr${snapshot.reviewLogs.length === 1 ? 'y' : 'ies'}.`,
        current: snapshot.reviewLogs.length,
        total: snapshot.reviewLogs.length,
        itemType: 'review',
      })
    }
    this.database.applySnapshot(snapshot)

    while (true) {
      const downloadedSha256 = new Set(
        snapshot.media.filter((media) => this.database.hasMediaHash(media.sha256)).map((media) => media.sha256)
      )
      const batch = selectAvailableMediaBatch(
        snapshot.media,
        downloadedSha256,
        getAvailableSnapshotMedia(response, snapshot.media)
      )

      if (batch.length > 0) {
        onProgress?.({
          stage: 'snapshot-download',
          message: `Downloading available media batch ${downloadedSha256.size + 1}-${Math.min(downloadedSha256.size + batch.length, snapshot.media.length)}/${snapshot.media.length}.`,
          current: downloadedSha256.size,
          total: snapshot.media.length,
          itemType: 'media',
          itemName: batch[0]?.originalName,
        })
        await Promise.all(batch.map((media) => this.downloadMediaBlob(media)))
        const downloadedMediaCount = snapshot.media.filter((media) =>
          this.database.hasMediaHash(media.sha256)
        ).length
        onProgress?.({
          stage: 'snapshot-download',
          message: `Saved media ${downloadedMediaCount}/${snapshot.media.length}.`,
          current: downloadedMediaCount,
          total: snapshot.media.length,
          itemType: 'media',
          itemName: batch[batch.length - 1]?.originalName,
        })
      }

      const downloadedMediaCount = snapshot.media.filter((media) =>
        this.database.hasMediaHash(media.sha256)
      ).length
      if (downloadedMediaCount === snapshot.media.length && response.uploadComplete !== false) break

      if (batch.length === 0) {
        onProgress?.({
          stage: 'snapshot-download',
          message: `Waiting for the next uploaded media batch. Saved ${downloadedMediaCount}/${snapshot.media.length}.`,
          current: downloadedMediaCount,
          total: snapshot.media.length,
          itemType: 'media',
        })
        await new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_POLL_DELAY_MS))
      }

      const nextResponse = await this.syncHostRequest<SyncSnapshotResponse>('/sync/snapshot', {
        method: 'GET',
        token,
      })
      if (!nextResponse.snapshot) {
        throw new Error('The full snapshot is no longer available. Restart pairing to continue.')
      }
      response = nextResponse
    }

    // Confirm receipt so the host can clean up the snapshot bundle and its media.
    onProgress?.({ stage: 'ack', message: 'Acknowledging initial snapshot.' })
    await this.syncHostRequest<{ ok: boolean }>('/sync/snapshot/ack', {
      method: 'POST',
      token,
      body: {},
    })
    this.saveStoredSyncSettings({ ...this.getStoredSyncSettings(), receiveSnapshotPending: false })
    return true
  }

  /**
   * Uploads one media file, resuming from whatever the host already holds.
   *
   * Transfers retry indefinitely: a phone that loses signal mid-file should
   * continue when it returns, not surface an error the user has to act on.
   */
  private async uploadMediaBlob(media: SyncMediaRecord, onProgress?: (sent: number) => void): Promise<void> {
    const data = this.database.readMediaBytesByHash(media.sha256)
    if (!data) throw new Error(`Media ${media.originalName} is missing from local storage.`)

    await this.blobs.upload({
      blob: {
        sha256: media.sha256,
        byteSize: data.length,
        mimeType: media.mimeType,
        originalName: media.originalName,
      },
      read: async (offset, length) => data.subarray(offset, offset + length),
      onProgress: (progress) => onProgress?.(progress.transferred),
    })
  }

  private async downloadMediaBlob(media: SyncMediaRecord, onProgress?: (received: number) => void): Promise<void> {
    if (this.database.hasMediaHash(media.sha256)) return

    // A partially downloaded file is staged beside the media store so an
    // interrupted download continues from its byte offset instead of restarting.
    const partialPath = this.mediaPartialPath(media.sha256)
    const startOffset = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0

    await this.blobs.download({
      blob: {
        sha256: media.sha256,
        byteSize: media.byteSize,
        mimeType: media.mimeType,
        originalName: media.originalName,
      },
      startOffset,
      write: async (chunk, offset) => {
        if (offset === 0) fs.writeFileSync(partialPath, chunk)
        else fs.appendFileSync(partialPath, chunk)
      },
      onProgress: (progress) => onProgress?.(progress.transferred),
    })

    const data = fs.readFileSync(partialPath)
    try {
      this.database.saveMediaBlob(media, data)
    } finally {
      fs.rmSync(partialPath, { force: true })
    }
  }

  /**
   * Fetches one published deck's media file.
   *
   * Prefers the resumable blob route, which streams raw bytes and continues an
   * interrupted download from its offset. Decks published before the host
   * indexed their media have no blob reference yet, so a 404 falls back to the
   * original base64 route rather than failing the download.
   */
  private async fetchPublishedMedia(media: GlobalDeckMedia): Promise<Buffer> {
    const partialPath = this.mediaPartialPath(media.sha256)
    const startOffset = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0

    try {
      await this.blobs.download({
        blob: {
          sha256: media.sha256,
          byteSize: media.byteSize,
          mimeType: media.mimeType,
          originalName: media.originalName,
        },
        startOffset,
        write: async (chunk, offset) => {
          if (offset === 0) fs.writeFileSync(partialPath, chunk)
          else fs.appendFileSync(partialPath, chunk)
        },
      })
      const data = fs.readFileSync(partialPath)
      fs.rmSync(partialPath, { force: true })
      return data
    } catch (error) {
      fs.rmSync(partialPath, { force: true })
      const status = (error as { status?: number | null }).status
      if (status !== 404 && status !== 401) throw error
      const blob = await this.globalDecks.downloadMedia(media.sha256)
      return Buffer.from(blob.dataBase64, 'base64')
    }
  }

  private mediaPartialPath(sha256: string): string {
    const partialDir = path.join(os.tmpdir(), 'onami-partial-media')
    fs.mkdirSync(partialDir, { recursive: true })
    return path.join(partialDir, `${sha256}.part`)
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
      seedSnapshotTargetDeviceId: null,
      receiveSnapshotPending: false,
      syncRequested: false,
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
    this.scheduleAutoSync()
  }

  private scheduleAutoSync(): void {
    const stored = this.getStoredSyncSettings()
    if (!stored.syncGroupId) return
    if (this.autoSyncTimer) return

    this.autoSyncTimer = setTimeout(() => {
      this.autoSyncTimer = null
      void this.syncNow().catch(() => {
        // Background sync is best-effort. Manual sync still reports failures.
      })
    }, 500)
    this.autoSyncTimer.unref?.()
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

  /**
   * Talks to the sync host through the shared transport.
   *
   * The previous implementation aborted every request after ten seconds,
   * including media uploads of tens of megabytes, which is why a large transfer
   * on a slow connection could never finish and always began again. Requests
   * are now abandoned only when they stop making progress, and retried with
   * backoff when the failure could succeed later.
   *
   * Control-plane calls keep a low attempt ceiling so the user is not left
   * staring at a pairing screen; transfers pass their own unlimited policy.
   */
  private syncHostRequest<T>(
    path: string,
    options: { method: 'GET' | 'POST'; body?: unknown; token?: string; attempts?: number }
  ): Promise<T> {
    return this.transport
      .request({
        method: options.method,
        path,
        json: options.body,
        // Always anonymous at the transport level: these callers already hold a
        // token when they need one, and letting the transport fetch one here
        // would make `/devices/token` ask itself for a token to call itself.
        anonymous: true,
        headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
        retry: { maxAttempts: options.attempts ?? 4 },
      })
      .then((response) => response.json<T>())
  }

  /** Lazily built so a host URL change is picked up without a restart. */
  private get transport(): Transport {
    if (!this.transportInstance) {
      this.transportInstance = createTransport({
        hostUrl: () => this.getStoredSyncSettings().hostUrl,
        token: () => this.getValidSyncDeviceToken(),
      })
    }
    return this.transportInstance
  }

  private get blobs(): BlobClient {
    if (!this.blobClientInstance) {
      this.blobClientInstance = createBlobClient({ transport: this.transport })
    }
    return this.blobClientInstance
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
