import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import mime from 'mime-types'

import {
  buildLibraryRecords,
  readCardRecord,
  readDeckRecord,
  readMediaRecord,
} from '../../src/shared/sync/recordMapping'
import type { StoredSyncRecord, SyncRecordEnvelope } from '../../src/shared/sync/records'
import type {
  AppStats,
  CardSummary,
  CreateCardInput,
  CreateDeckInput,
  DeckDetail,
  DeckSummary,
  HardCardSummary,
  NoteTypeName,
  ReviewRating,
  ReviewStateName,
  SyncCardUpsertPayload,
  SyncDeckUpsertPayload,
  SyncDeckRecord,
  SyncEntityType,
  SyncEventPayload,
  SyncEventRecord,
  SyncEventType,
  SyncMediaRecord,
  SyncReviewAnswerPayload,
  SyncReviewLogRecord,
  UpdateCardInput,
} from '../../src/shared/types'

type SqliteDatabase = Database.Database
type Row = Record<string, unknown>

interface ReviewLogEntry {
  cardId: string
  reviewedAt: string
  rating: ReviewRating
  elapsedMs: number
  revealMs: number
  answerMs: number
}

interface CardPerformanceAccumulator {
  card: CardSummary
  reviewCount: number
  againCount: number
  easyCount: number
  totalReviewMs: number
  reviewMsCount: number
  totalRevealMs: number
  revealMsCount: number
  againToEasyDurations: number[]
  pendingAgainAt: number | null
}

export interface ImportedReviewState {
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

export interface ImportedNoteInput {
  deckId: string
  noteType: string
  fields: Record<string, string>
  tags: string[]
  sourceGuid: string
}

export interface ImportedCardInput {
  noteId: string
  deckId: string
  templateOrd: number
  frontHtml: string
  backHtml: string
  mediaRefs: string[]
  sourceCardId: string
  reviewState: ImportedReviewState | null
}

export interface UpsertNoteResult {
  id: string
  updated: boolean
}

export interface MediaRecord {
  id: string
  originalName: string
  storedPath: string
  mimeType: string
  hash: string
}

export interface RemoteSyncEvent extends SyncEventRecord {
  hostEventId: number
}

export interface SyncBackupSummary {
  backedUpEvents: number
  lastBackedUpAt: string | null
}

const nowIso = () => new Date().toISOString()

const json = <T>(value: T): string => JSON.stringify(value)

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || value.length === 0) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const toStringValue = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  return String(value)
}

const toNumber = (value: unknown, fallback = 0): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const createDefaultReviewState = (): ImportedReviewState => ({
  dueAt: null,
  state: 'New',
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
})

export class OnamiDatabase {
  private db: SqliteDatabase

  constructor(dbPath: string, private readonly mediaDir: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    fs.mkdirSync(mediaDir, { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
    this.ensureReviewStateSeeds()
    this.ensureDefaultDeck()
  }

  close(): void {
    this.db.close()
  }

  getMediaPath(mediaId: string): string | null {
    const row = this.db
      .prepare('SELECT stored_path FROM media WHERE id = ?')
      .get(mediaId) as Row | undefined
    return row ? toStringValue(row.stored_path) : null
  }

  createDeck(input: CreateDeckInput): DeckSummary {
    const name = input.name.trim()
    if (!name) throw new Error('Deck name is required.')

    const id = randomUUID()
    const timestamp = nowIso()
    this.db
      .prepare(
        `INSERT INTO decks (id, parent_id, name, source, source_id, created_at, updated_at)
         VALUES (?, ?, ?, 'local', ?, ?, ?)`
      )
      .run(id, input.parentId ?? null, name, `local:${id}`, timestamp, timestamp)
    return this.getDeckSummary(id)
  }

  listDecks(): DeckSummary[] {
    const rows = this.deckSummaryRows().all({ now: nowIso() }) as Row[]
    return rows.map((row) => this.rowToDeckSummary(row))
  }

  getDeck(deckId: string): DeckDetail {
    const cards = this.listCards(deckId)
    const deck = this.getDeckSummary(deckId)
    const now = Date.now()
    const reviewed = cards.filter((card) => card.reps > 0)
    return {
      ...deck,
      totalCards: cards.length,
      newCards: cards.filter((card) => card.state === 'New').length,
      dueCards: cards.filter((card) => card.state !== 'New' && card.dueAt && Date.parse(card.dueAt) <= now).length,
      learningCards: cards.filter((card) => card.state === 'Learning').length,
      reviewCards: cards.filter((card) => card.state === 'Review' || card.state === 'Relearning').length,
      successRate: reviewed.length
        ? reviewed.reduce((sum, card) => sum + card.successRate, 0) / reviewed.length
        : 0,
      cards,
    }
  }

  getDeckSummary(deckId: string): DeckSummary {
    const row = this.deckSummaryRows('WHERE d.id = @deckId').get({
      now: nowIso(),
      deckId,
    }) as Row | undefined
    if (!row) throw new Error('Deck not found.')
    return this.rowToDeckSummary(row)
  }

  findDeckBySource(source: string, sourceId: string): DeckSummary | null {
    const row = this.db
      .prepare('SELECT id FROM decks WHERE source = ? AND source_id = ?')
      .get(source, sourceId) as Row | undefined
    return row ? this.getDeckSummary(toStringValue(row.id)) : null
  }

  upsertImportedDeck(input: {
    name: string
    parentId: string | null
    source: string
    sourceId: string
  }): DeckSummary {
    const existing = this.findDeckBySource(input.source, input.sourceId)
    const timestamp = nowIso()
    if (existing) {
      this.db
        .prepare(
          `UPDATE decks
           SET name = ?, parent_id = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(input.name, input.parentId, timestamp, existing.id)
      return this.getDeckSummary(existing.id)
    }

    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO decks (id, parent_id, name, source, source_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.parentId, input.name, input.source, input.sourceId, timestamp, timestamp)
    return this.getDeckSummary(id)
  }

  listCards(deckId?: string): CardSummary[] {
    const where = deckId
      ? `WHERE c.deck_id IN (
          WITH RECURSIVE deck_tree(id) AS (
            SELECT @deckId
            UNION ALL
            SELECT d.id
            FROM decks d
            JOIN deck_tree dt ON d.parent_id = dt.id
          )
          SELECT id FROM deck_tree
        )`
      : ''
    const rows = this.db
      .prepare(
        `SELECT
          c.id,
          c.note_id,
          c.deck_id,
          d.name AS deck_name,
          c.template_ord,
          c.front_html,
          c.back_html,
          n.tags_json,
          COALESCE(rs.state, 'New') AS state,
          rs.due_at,
          COALESCE(rs.reps, 0) AS reps,
          COALESCE(rs.lapses, 0) AS lapses,
          COALESCE(rs.success_rate, 0) AS success_rate,
          rs.last_rating,
          rs.last_reviewed_at
         FROM cards c
         JOIN notes n ON n.id = c.note_id
         JOIN decks d ON d.id = c.deck_id
         LEFT JOIN review_state rs ON rs.card_id = c.id
         ${where}
         ORDER BY d.name, c.template_ord, c.created_at`
      )
      .all({ deckId }) as Row[]
    return rows.map((row) => this.rowToCardSummary(row))
  }

  /**
   * Note type per card id for a deck and its children. `CardSummary` does not
   * carry the note type, but publishing a deck needs it so cloze cards stay
   * cloze cards for whoever adds the deck to their library.
   */
  listCardNoteTypes(deckId: string): Map<string, NoteTypeName> {
    const rows = this.db
      .prepare(
        `SELECT c.id, n.note_type
         FROM cards c
         JOIN notes n ON n.id = c.note_id
         WHERE c.deck_id IN (
           WITH RECURSIVE deck_tree(id) AS (
             SELECT @deckId
             UNION ALL
             SELECT d.id
             FROM decks d
             JOIN deck_tree dt ON d.parent_id = dt.id
           )
           SELECT id FROM deck_tree
         )`
      )
      .all({ deckId }) as Row[]

    const noteTypes = new Map<string, NoteTypeName>()
    for (const row of rows) {
      const noteType = toStringValue(row.note_type)
      noteTypes.set(
        toStringValue(row.id),
        noteType === 'cloze' || noteType === 'imported' ? noteType : 'basic'
      )
    }
    return noteTypes
  }

  getCard(cardId: string): CardSummary {
    const card = this.listCards().find((candidate) => candidate.id === cardId)
    if (!card) throw new Error('Card not found.')
    return card
  }

  getReviewState(cardId: string): ImportedReviewState | null {
    const row = this.db
      .prepare('SELECT * FROM review_state WHERE card_id = ?')
      .get(cardId) as Row | undefined
    if (!row) return null
    return this.rowToImportedReviewState(row)
  }

  createCard(input: CreateCardInput): CardSummary {
    this.assertDeck(input.deckId)
    const timestamp = nowIso()
    const noteId = randomUUID()
    const cardId = randomUUID()
    const tags = input.tags ?? []
    const fields = input.fields ?? {
      Front: input.frontHtml,
      Back: input.backHtml,
    }

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO notes
            (id, deck_id, note_type, fields_json, tags_json, source_guid, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          noteId,
          input.deckId,
          input.noteType,
          json(fields),
          json(tags),
          `local:${noteId}`,
          timestamp,
          timestamp
        )

      this.db
        .prepare(
          `INSERT INTO cards
            (id, note_id, deck_id, template_ord, front_html, back_html, media_refs_json, source_card_id, created_at, updated_at)
           VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          cardId,
          noteId,
          input.deckId,
          input.frontHtml,
          input.backHtml,
          json([]),
          `local:${cardId}`,
          timestamp,
          timestamp
        )

      const defaultState = createDefaultReviewState()
      this.upsertReviewStateSeed(cardId, defaultState)
      this.upsertReviewState(cardId, defaultState)
    })
    tx()
    return this.getCard(cardId)
  }

  updateCard(input: UpdateCardInput): CardSummary {
    const existing = this.getCard(input.id)
    if (input.deckId) this.assertDeck(input.deckId)
    const timestamp = nowIso()
    const front = input.frontHtml ?? existing.frontHtml
    const back = input.backHtml ?? existing.backHtml
    const deckId = input.deckId ?? existing.deckId
    const tags = input.tags ?? existing.tags

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE cards
           SET deck_id = ?, front_html = ?, back_html = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(deckId, front, back, timestamp, input.id)
      this.db
        .prepare(
          `UPDATE notes
           SET deck_id = ?, fields_json = ?, tags_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(deckId, json({ Front: front, Back: back }), json(tags), timestamp, existing.noteId)
    })
    tx()
    return this.getCard(input.id)
  }

  deleteCard(cardId: string): void {
    const card = this.getCard(cardId)
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM cards WHERE id = ?').run(cardId)
      this.db.prepare('DELETE FROM notes WHERE id = ?').run(card.noteId)
    })
    tx()
  }

  deleteDeck(deckId: string): void {
    this.assertDeck(deckId)
    const ids = this.getDeckTreeIds(deckId)
    const placeholders = ids.map(() => '?').join(',')

    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM decks WHERE id IN (${placeholders})`).run(...ids)
      this.ensureDefaultDeck()
    })
    tx()
  }

  upsertImportedNote(input: ImportedNoteInput): UpsertNoteResult {
    const existing = this.db
      .prepare('SELECT id FROM notes WHERE source_guid = ?')
      .get(input.sourceGuid) as Row | undefined
    const timestamp = nowIso()

    if (existing) {
      const id = toStringValue(existing.id)
      this.db
        .prepare(
          `UPDATE notes
           SET deck_id = ?, note_type = ?, fields_json = ?, tags_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(input.deckId, input.noteType, json(input.fields), json(input.tags), timestamp, id)
      return { id, updated: true }
    }

    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO notes
          (id, deck_id, note_type, fields_json, tags_json, source_guid, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.deckId,
        input.noteType,
        json(input.fields),
        json(input.tags),
        input.sourceGuid,
        timestamp,
        timestamp
      )
    return { id, updated: false }
  }

  upsertImportedCard(input: ImportedCardInput, preserveScheduling: boolean): string {
    const existing = this.db
      .prepare('SELECT id FROM cards WHERE source_card_id = ?')
      .get(input.sourceCardId) as Row | undefined
    const timestamp = nowIso()
    const mediaJson = json(input.mediaRefs)
    const seedState = preserveScheduling && input.reviewState ? input.reviewState : createDefaultReviewState()

    if (existing) {
      const id = toStringValue(existing.id)
      this.db
        .prepare(
          `UPDATE cards
           SET note_id = ?, deck_id = ?, template_ord = ?, front_html = ?, back_html = ?,
               media_refs_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.noteId,
          input.deckId,
          input.templateOrd,
          input.frontHtml,
          input.backHtml,
          mediaJson,
          timestamp,
          id
        )
      this.upsertReviewStateSeed(id, seedState)
      if (preserveScheduling && input.reviewState) this.upsertReviewState(id, input.reviewState)
      else this.resetReviewState(id)
      return id
    }

    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO cards
          (id, note_id, deck_id, template_ord, front_html, back_html, media_refs_json, source_card_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.noteId,
        input.deckId,
        input.templateOrd,
        input.frontHtml,
        input.backHtml,
        mediaJson,
        input.sourceCardId,
        timestamp,
        timestamp
      )
    this.upsertReviewStateSeed(id, seedState)
    if (preserveScheduling && input.reviewState) this.upsertReviewState(id, input.reviewState)
    else this.resetReviewState(id)
    return id
  }

  importTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  upsertMediaFromFile(originalName: string, tempPath: string): MediaRecord {
    const data = fs.readFileSync(tempPath)
    const hash = createHash('sha256').update(data).digest('hex')
    const existing = this.db.prepare('SELECT * FROM media WHERE hash = ?').get(hash) as
      | Row
      | undefined
    if (existing) return this.rowToMedia(existing)

    const id = randomUUID()
    const ext = path.extname(originalName) || `.${mime.extension(mime.lookup(originalName) || '') || 'bin'}`
    const storedPath = path.join(this.mediaDir, `${hash}${ext.toLowerCase()}`)
    if (!fs.existsSync(storedPath)) fs.copyFileSync(tempPath, storedPath)

    this.db
      .prepare(
        `INSERT INTO media (id, original_name, stored_path, mime_type, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, originalName, storedPath, mime.lookup(originalName) || 'application/octet-stream', hash, nowIso())
    return {
      id,
      originalName,
      storedPath,
      mimeType: mime.lookup(originalName) || 'application/octet-stream',
      hash,
    }
  }

  upsertReviewState(cardId: string, state: ImportedReviewState): void {
    this.db
      .prepare(
        `INSERT INTO review_state
          (card_id, due_at, state, stability, difficulty, elapsed_days, scheduled_days,
           learning_steps, reps, lapses, success_rate, last_rating, last_reviewed_at)
         VALUES
          (@cardId, @dueAt, @state, @stability, @difficulty, @elapsedDays, @scheduledDays,
           @learningSteps, @reps, @lapses, @successRate, @lastRating, @lastReviewedAt)
         ON CONFLICT(card_id) DO UPDATE SET
          due_at = excluded.due_at,
          state = excluded.state,
          stability = excluded.stability,
          difficulty = excluded.difficulty,
          elapsed_days = excluded.elapsed_days,
          scheduled_days = excluded.scheduled_days,
          learning_steps = excluded.learning_steps,
          reps = excluded.reps,
          lapses = excluded.lapses,
          success_rate = excluded.success_rate,
          last_rating = excluded.last_rating,
          last_reviewed_at = excluded.last_reviewed_at`
      )
      .run({ cardId, ...state })
  }

  upsertReviewStateSeed(cardId: string, state: ImportedReviewState): void {
    this.db
      .prepare(
        `INSERT INTO review_state_seed
          (card_id, due_at, state, stability, difficulty, elapsed_days, scheduled_days,
           learning_steps, reps, lapses, success_rate, last_rating, last_reviewed_at)
         VALUES
          (@cardId, @dueAt, @state, @stability, @difficulty, @elapsedDays, @scheduledDays,
           @learningSteps, @reps, @lapses, @successRate, @lastRating, @lastReviewedAt)
         ON CONFLICT(card_id) DO UPDATE SET
          due_at = excluded.due_at,
          state = excluded.state,
          stability = excluded.stability,
          difficulty = excluded.difficulty,
          elapsed_days = excluded.elapsed_days,
          scheduled_days = excluded.scheduled_days,
          learning_steps = excluded.learning_steps,
          reps = excluded.reps,
          lapses = excluded.lapses,
          success_rate = excluded.success_rate,
          last_rating = excluded.last_rating,
          last_reviewed_at = excluded.last_reviewed_at`
      )
      .run({ cardId, ...state })
  }

  getReviewStateSeed(cardId: string): ImportedReviewState | null {
    const row = this.db
      .prepare('SELECT * FROM review_state_seed WHERE card_id = ?')
      .get(cardId) as Row | undefined
    return row ? this.rowToImportedReviewState(row) : null
  }

  resetReviewState(cardId: string): void {
    this.upsertReviewState(cardId, createDefaultReviewState())
  }

  markCardReviewDue(cardId: string, dueAt = nowIso()): void {
    const current = this.getReviewState(cardId) ?? createDefaultReviewState()
    this.upsertReviewState(cardId, {
      ...current,
      dueAt,
      state: current.state === 'New' ? 'Learning' : current.state,
    })
  }

  recordDeckUnitTestScore(deckId: string, score: number, testedAt = nowIso()): void {
    this.assertDeck(deckId)
    const normalizedScore = Math.min(1, Math.max(0, score))
    this.db
      .prepare(
        `UPDATE decks
         SET unit_test_score = ?, unit_tested_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(normalizedScore, testedAt, testedAt, deckId)
  }

  resetDeckScheduling(deckId: string): void {
    this.assertDeck(deckId)
    const cardIds = this.getCardIdsForDeckTree(deckId)
    if (cardIds.length === 0) return

    const timestamp = nowIso()
    const tx = this.db.transaction(() => {
      for (const cardId of cardIds) {
        const seed = this.getReviewStateSeed(cardId) ?? createDefaultReviewState()
        this.upsertReviewState(cardId, seed)
      }
      const placeholders = cardIds.map(() => '?').join(',')
      this.db
        .prepare(`UPDATE cards SET stats_reset_at = ? WHERE id IN (${placeholders})`)
        .run(timestamp, ...cardIds)
    })
    tx()
  }

  logReview(input: {
    cardId: string
    reviewedAt: string
    rating: ReviewRating
    elapsedMs: number
    revealMs: number
    answerMs: number
    previousDueAt: string | null
    nextDueAt: string | null
  }): void {
    this.db
      .prepare(
        `INSERT INTO review_log
          (id, card_id, reviewed_at, rating, elapsed_ms, reveal_ms, answer_ms, previous_due_at, next_due_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        input.cardId,
        input.reviewedAt,
        input.rating,
        input.elapsedMs,
        input.revealMs,
        input.answerMs,
        input.previousDueAt,
        input.nextDueAt
      )
  }

  getSettingsValue<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
      | Row
      | undefined
    return row ? parseJson<T>(row.value_json, fallback) : fallback
  }

  setSettingsValue<T>(key: string, value: T): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at`
      )
      .run(key, json(value), nowIso())
  }

  enqueueSyncEvent(input: {
    deviceId: string
    entityType: SyncEntityType
    entityId: string
    eventType: SyncEventType
    payload: SyncEventPayload
  }): SyncEventRecord {
    const timestamp = nowIso()
    const eventId = randomUUID()
    const row = this.db
      .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM sync_outbox WHERE device_id = ?')
      .get(input.deviceId) as Row
    const sequence = toNumber(row.next_sequence, 1)

    this.db
      .prepare(
        `INSERT INTO sync_outbox
          (event_id, device_id, sequence, entity_type, entity_id, event_type, payload_json, created_at, pushed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        eventId,
        input.deviceId,
        sequence,
        input.entityType,
        input.entityId,
        input.eventType,
        json(input.payload),
        timestamp
      )

    return {
      eventId,
      sourceDeviceId: input.deviceId,
      sequence,
      entityType: input.entityType,
      entityId: input.entityId,
      eventType: input.eventType,
      payload: input.payload,
      createdAt: timestamp,
    }
  }

  listPendingSyncEvents(limit = 100): SyncEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM sync_outbox
         WHERE pushed_at IS NULL
         ORDER BY sequence
         LIMIT ?`
      )
      .all(limit) as Row[]
    return rows.map((row) => this.rowToSyncEvent(row))
  }

  markSyncEventsPushed(eventIds: string[]): void {
    if (eventIds.length === 0) return
    const placeholders = eventIds.map(() => '?').join(',')
    this.db
      .prepare(`UPDATE sync_outbox SET pushed_at = ? WHERE event_id IN (${placeholders})`)
      .run(nowIso(), ...eventIds)
  }

  getPendingSyncEventCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM sync_outbox WHERE pushed_at IS NULL')
      .get() as Row
    return toNumber(row.count)
  }

  getSyncBackupSummary(): SyncBackupSummary {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS backed_up_events, MAX(pushed_at) AS last_backed_up_at
         FROM sync_outbox
         WHERE pushed_at IS NOT NULL`
      )
      .get() as Row
    return {
      backedUpEvents: toNumber(row.backed_up_events),
      lastBackedUpAt: row.last_backed_up_at ? toStringValue(row.last_backed_up_at) : null,
    }
  }

  getSyncHostCursor(): number {
    const row = this.db
      .prepare("SELECT last_host_event_id FROM sync_cursor WHERE id = 'host'")
      .get() as Row | undefined
    return row ? toNumber(row.last_host_event_id) : 0
  }

  setSyncHostCursor(cursor: number): void {
    this.db
      .prepare(
        `INSERT INTO sync_cursor (id, last_host_event_id, updated_at)
         VALUES ('host', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          last_host_event_id = MAX(sync_cursor.last_host_event_id, excluded.last_host_event_id),
          updated_at = excluded.updated_at`
      )
      .run(cursor, nowIso())
  }

  // ---- Records ----
  //
  // The outbox is keyed by what a record describes, so queueing the same card
  // twice replaces the pending row. The old event outbox appended per edit,
  // which is why importing a deck queued an event for every card already in the
  // library and the host's event table grew without bound.

  enqueueRecord(record: SyncRecordEnvelope): void {
    this.db
      .prepare(
        `INSERT INTO record_outbox
          (record_key, kind, record_id, updated_at, deleted, merge_rank, payload_json, blob_refs_json, queued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(record_key) DO UPDATE SET
          updated_at = excluded.updated_at,
          deleted = excluded.deleted,
          merge_rank = excluded.merge_rank,
          payload_json = excluded.payload_json,
          blob_refs_json = excluded.blob_refs_json,
          queued_at = excluded.queued_at`
      )
      .run(
        `${record.kind}|${record.recordId}`,
        record.kind,
        record.recordId,
        record.updatedAt,
        record.deleted ? 1 : 0,
        record.mergeRank,
        json(record.payload),
        json(record.blobRefs ?? []),
        nowIso()
      )
  }

  enqueueRecords(records: SyncRecordEnvelope[]): void {
    const tx = this.db.transaction(() => {
      for (const record of records) this.enqueueRecord(record)
    })
    tx()
  }

  listPendingRecords(limit = 500): SyncRecordEnvelope[] {
    const rows = this.db
      .prepare('SELECT * FROM record_outbox ORDER BY queued_at, record_key LIMIT ?')
      .all(limit) as Row[]
    return rows.map((row) => ({
      kind: toStringValue(row.kind) as SyncRecordEnvelope['kind'],
      recordId: toStringValue(row.record_id),
      updatedAt: toStringValue(row.updated_at),
      deleted: toNumber(row.deleted) === 1,
      mergeRank: toNumber(row.merge_rank),
      payload: JSON.parse(toStringValue(row.payload_json)) as unknown,
      blobRefs: JSON.parse(toStringValue(row.blob_refs_json)) as string[],
    }))
  }

  /**
   * Clears rows only if nothing re-queued them while the push was in flight.
   * Matching on the queued content, not just the key, means an edit made during
   * a slow upload is not silently dropped.
   */
  markRecordsPushed(records: SyncRecordEnvelope[]): void {
    if (records.length === 0) return
    const statement = this.db.prepare(
      'DELETE FROM record_outbox WHERE record_key = ? AND updated_at = ? AND merge_rank = ?'
    )
    const tx = this.db.transaction(() => {
      for (const record of records) {
        statement.run(`${record.kind}|${record.recordId}`, record.updatedAt, record.mergeRank)
      }
    })
    tx()
  }

  getPendingRecordCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM record_outbox').get() as Row
    return toNumber(row.count)
  }

  getRecordCursor(): number {
    const row = this.db
      .prepare("SELECT last_host_event_id FROM sync_cursor WHERE id = 'records'")
      .get() as Row | undefined
    return row ? toNumber(row.last_host_event_id) : 0
  }

  setRecordCursor(cursor: number): void {
    this.db
      .prepare(
        `INSERT INTO sync_cursor (id, last_host_event_id, updated_at)
         VALUES ('records', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          last_host_event_id = MAX(sync_cursor.last_host_event_id, excluded.last_host_event_id),
          updated_at = excluded.updated_at`
      )
      .run(cursor, nowIso())
  }

  getReviewLogCursor(): number {
    const row = this.db
      .prepare("SELECT last_host_event_id FROM sync_cursor WHERE id = 'review-log'")
      .get() as Row | undefined
    return row ? toNumber(row.last_host_event_id) : 0
  }

  setReviewLogCursor(cursor: number): void {
    this.db
      .prepare(
        `INSERT INTO sync_cursor (id, last_host_event_id, updated_at)
         VALUES ('review-log', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          last_host_event_id = MAX(sync_cursor.last_host_event_id, excluded.last_host_event_id),
          updated_at = excluded.updated_at`
      )
      .run(cursor, nowIso())
  }

  /** Everything this library holds, for a device that has never pushed. */
  buildLibraryRecords(): SyncRecordEnvelope[] {
    return buildLibraryRecords({
      decks: this.listSyncDeckPayloads().map((payload) => payload.deck),
      cards: this.listSyncCardPayloads(),
      media: this.listMediaRecords(),
    })
  }

  /**
   * Applies one page of records inside a single transaction, so an interrupted
   * sync leaves the library consistent and the cursor un-advanced.
   *
   * A record whose payload cannot be read is skipped rather than thrown, so one
   * bad row cannot wedge sync for every device in the group.
   */
  applyRecordPage(records: StoredSyncRecord[]): { applied: number; skipped: number } {
    let applied = 0
    let skipped = 0

    const tx = this.db.transaction(() => {
      for (const record of records) {
        if (record.kind === 'deck') {
          if (record.deleted) {
            this.deleteDeckIfPresent(record.recordId)
          } else {
            const deck = readDeckRecord(record)
            if (!deck) {
              skipped += 1
              continue
            }
            this.applyDeckUpsert({ version: 1, deck })
          }
        } else if (record.kind === 'card') {
          if (record.deleted) {
            this.deleteCardIfPresent(record.recordId)
          } else {
            const payload = readCardRecord(record)
            if (!payload) {
              skipped += 1
              continue
            }
            this.applyCardUpsert(payload)
          }
        } else if (record.kind === 'media') {
          const media = readMediaRecord(record)
          if (!media) {
            skipped += 1
            continue
          }
          if (record.deleted) this.db.prepare('DELETE FROM media_index WHERE sha256 = ?').run(media.sha256)
          else this.upsertMediaIndex(media)
        } else {
          skipped += 1
          continue
        }
        applied += 1
      }
    })

    tx()
    return { applied, skipped }
  }

  private upsertMediaIndex(media: SyncMediaRecord): void {
    this.db
      .prepare(
        `INSERT INTO media_index (sha256, media_id, mime_type, byte_size, original_name, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(sha256) DO UPDATE SET
          media_id = excluded.media_id,
          mime_type = excluded.mime_type,
          byte_size = excluded.byte_size,
          original_name = excluded.original_name,
          updated_at = excluded.updated_at`
      )
      .run(media.sha256, media.id, media.mimeType, media.byteSize, media.originalName, nowIso())
  }

  /**
   * Media this library is supposed to have but does not. Derived by comparing
   * what records described against what is actually stored, so it is correct
   * after any interruption without tracking a separate download queue.
   */
  listMissingMedia(): SyncMediaRecord[] {
    const rows = this.db
      .prepare(
        `SELECT i.sha256, i.media_id, i.mime_type, i.byte_size, i.original_name
         FROM media_index i
         WHERE NOT EXISTS (SELECT 1 FROM media m WHERE m.hash = i.sha256)`
      )
      .all() as Row[]
    return rows.map((row) => ({
      id: toStringValue(row.media_id),
      sha256: toStringValue(row.sha256),
      mimeType: toStringValue(row.mime_type),
      byteSize: toNumber(row.byte_size),
      originalName: toStringValue(row.original_name),
    }))
  }

  /** Reviews not yet sent, matched against what the host has acknowledged. */
  listUnsentReviewLogs(limit = 500): SyncReviewLogRecord[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.card_id, r.reviewed_at, r.rating, r.elapsed_ms,
            COALESCE(r.reveal_ms, 0) AS reveal_ms, COALESCE(r.answer_ms, 0) AS answer_ms,
            r.previous_due_at, r.next_due_at
         FROM review_log r
         WHERE NOT EXISTS (SELECT 1 FROM review_log_sent s WHERE s.id = r.id)
         ORDER BY r.reviewed_at
         LIMIT ?`
      )
      .all(limit) as Row[]
    return rows.map((row) => ({
      id: toStringValue(row.id),
      cardId: toStringValue(row.card_id),
      reviewedAt: toStringValue(row.reviewed_at),
      rating: toStringValue(row.rating) as ReviewRating,
      elapsedMs: toNumber(row.elapsed_ms),
      revealMs: toNumber(row.reveal_ms),
      answerMs: toNumber(row.answer_ms),
      previousDueAt: row.previous_due_at ? toStringValue(row.previous_due_at) : null,
      nextDueAt: row.next_due_at ? toStringValue(row.next_due_at) : null,
    }))
  }

  markReviewLogsSent(ids: string[]): void {
    if (ids.length === 0) return
    const statement = this.db.prepare(
      'INSERT OR IGNORE INTO review_log_sent (id, sent_at) VALUES (?, ?)'
    )
    const tx = this.db.transaction(() => {
      const timestamp = nowIso()
      for (const id of ids) statement.run(id, timestamp)
    })
    tx()
  }

  applyReviewLogEntries(entries: SyncReviewLogRecord[]): number {
    let applied = 0
    const tx = this.db.transaction(() => {
      for (const entry of entries) {
        if (!this.hasCard(entry.cardId)) continue
        this.insertReviewLogRecord(entry)
        // A review that arrived from elsewhere must not be pushed back out.
        this.db.prepare('INSERT OR IGNORE INTO review_log_sent (id, sent_at) VALUES (?, ?)').run(entry.id, nowIso())
        applied += 1
      }
    })
    tx()
    return applied
  }

  buildDeckSyncPayload(deckId: string): SyncDeckUpsertPayload {
    const row = this.db.prepare('SELECT * FROM decks WHERE id = ?').get(deckId) as Row | undefined
    if (!row) throw new Error('Deck not found.')
    return {
      version: 1,
      deck: this.rowToSyncDeckRecord(row),
    }
  }

  buildCardSyncPayload(cardId: string): SyncCardUpsertPayload {
    const row = this.db
      .prepare(
        `SELECT
          c.*,
          n.deck_id AS note_deck_id,
          n.note_type,
          n.fields_json,
          n.tags_json,
          n.source_guid,
          n.created_at AS note_created_at,
          n.updated_at AS note_updated_at
         FROM cards c
         JOIN notes n ON n.id = c.note_id
         WHERE c.id = ?`
      )
      .get(cardId) as Row | undefined
    if (!row) throw new Error('Card not found.')
    return {
      version: 1,
      note: {
        id: toStringValue(row.note_id),
        deckId: toStringValue(row.note_deck_id),
        noteType: toStringValue(row.note_type),
        fields: parseJson<Record<string, string>>(row.fields_json, {}),
        tags: parseJson<string[]>(row.tags_json, []),
        sourceGuid: row.source_guid ? toStringValue(row.source_guid) : null,
        createdAt: toStringValue(row.note_created_at),
        updatedAt: toStringValue(row.note_updated_at),
      },
      card: {
        id: toStringValue(row.id),
        noteId: toStringValue(row.note_id),
        deckId: toStringValue(row.deck_id),
        templateOrd: toNumber(row.template_ord),
        frontHtml: toStringValue(row.front_html),
        backHtml: toStringValue(row.back_html),
        mediaRefs: parseJson<string[]>(row.media_refs_json, []),
        sourceCardId: row.source_card_id ? toStringValue(row.source_card_id) : null,
        statsResetAt: row.stats_reset_at ? toStringValue(row.stats_reset_at) : null,
        createdAt: toStringValue(row.created_at),
        updatedAt: toStringValue(row.updated_at),
      },
      reviewState: this.getReviewState(cardId) ?? createDefaultReviewState(),
    }
  }

  buildReviewAnswerSyncPayload(input: {
    cardId: string
    reviewedAt: string
    rating: ReviewRating
    elapsedMs: number
    revealMs: number
    answerMs: number
    previousDueAt: string | null
    nextDueAt: string | null
  }): SyncReviewAnswerPayload {
    return {
      version: 1,
      cardId: input.cardId,
      reviewedAt: input.reviewedAt,
      rating: input.rating,
      elapsedMs: input.elapsedMs,
      revealMs: input.revealMs,
      answerMs: input.answerMs,
      previousDueAt: input.previousDueAt,
      nextDueAt: input.nextDueAt,
      reviewState: this.getReviewState(input.cardId) ?? createDefaultReviewState(),
    }
  }

  listSyncDeckPayloads(): SyncDeckUpsertPayload[] {
    const rows = this.db.prepare('SELECT * FROM decks ORDER BY created_at, name').all() as Row[]
    return rows.map((row) => ({
      version: 1,
      deck: this.rowToSyncDeckRecord(row),
    }))
  }

  listSyncCardPayloads(deckId?: string): SyncCardUpsertPayload[] {
    const cards = deckId ? this.listCards(deckId) : this.listCards()
    return cards.map((card) => this.buildCardSyncPayload(card.id))
  }

  applyRemoteSyncEvent(event: RemoteSyncEvent): boolean {
    const existing = this.db.prepare('SELECT event_id FROM sync_inbox WHERE event_id = ?').get(event.eventId) as
      | Row
      | undefined
    if (existing) return false

    const tx = this.db.transaction(() => {
      if (event.eventType === 'deck.upsert') {
        this.applyDeckUpsert(event.payload as SyncDeckUpsertPayload)
      } else if (event.eventType === 'deck.delete') {
        this.deleteDeckIfPresent(event.entityId)
      } else if (event.eventType === 'card.upsert') {
        this.applyCardUpsert(event.payload as SyncCardUpsertPayload)
      } else if (event.eventType === 'card.delete') {
        this.deleteCardIfPresent(event.entityId)
      } else if (event.eventType === 'review.answer') {
        this.applyReviewAnswer(event.eventId, event.payload as SyncReviewAnswerPayload)
      }

      this.db
        .prepare(
          `INSERT INTO sync_inbox (event_id, source_device_id, host_event_id, applied_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(event.eventId, event.sourceDeviceId, event.hostEventId, nowIso())
    })

    tx()
    return true
  }

  listReviewLogRecords(): SyncReviewLogRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, card_id, reviewed_at, rating, elapsed_ms,
          COALESCE(reveal_ms, 0) AS reveal_ms, COALESCE(answer_ms, 0) AS answer_ms,
          previous_due_at, next_due_at
         FROM review_log
         ORDER BY reviewed_at`
      )
      .all() as Row[]
    return rows.map((row) => ({
      id: toStringValue(row.id),
      cardId: toStringValue(row.card_id),
      reviewedAt: toStringValue(row.reviewed_at),
      rating: toStringValue(row.rating) as ReviewRating,
      elapsedMs: toNumber(row.elapsed_ms),
      revealMs: toNumber(row.reveal_ms),
      answerMs: toNumber(row.answer_ms),
      previousDueAt: row.previous_due_at ? toStringValue(row.previous_due_at) : null,
      nextDueAt: row.next_due_at ? toStringValue(row.next_due_at) : null,
    }))
  }

  insertReviewLogRecord(record: SyncReviewLogRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO review_log
          (id, card_id, reviewed_at, rating, elapsed_ms, reveal_ms, answer_ms, previous_due_at, next_due_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.cardId,
        record.reviewedAt,
        record.rating,
        record.elapsedMs,
        record.revealMs,
        record.answerMs,
        record.previousDueAt,
        record.nextDueAt
      )
  }

  listMediaRecords(): SyncMediaRecord[] {
    const rows = this.db.prepare('SELECT * FROM media').all() as Row[]
    const records: SyncMediaRecord[] = []
    for (const row of rows) {
      const storedPath = toStringValue(row.stored_path)
      if (!fs.existsSync(storedPath)) continue
      records.push({
        id: toStringValue(row.id),
        sha256: toStringValue(row.hash),
        mimeType: toStringValue(row.mime_type),
        byteSize: fs.statSync(storedPath).size,
        originalName: toStringValue(row.original_name),
      })
    }
    return records
  }

  readMediaBytesByHash(hash: string): Buffer | null {
    const row = this.db.prepare('SELECT stored_path FROM media WHERE hash = ?').get(hash) as Row | undefined
    if (!row) return null
    const storedPath = toStringValue(row.stored_path)
    return fs.existsSync(storedPath) ? fs.readFileSync(storedPath) : null
  }

  saveGlobalMediaBlob(record: SyncMediaRecord, data: Buffer): string {
    const actualHash = createHash('sha256').update(data).digest('hex')
    if (actualHash !== record.sha256) throw new Error('Global deck media checksum did not match.')
    const existing = this.db.prepare('SELECT * FROM media WHERE hash = ?').get(record.sha256) as Row | undefined
    if (existing) return this.rowToMedia(existing).id

    const idCollision = this.db.prepare('SELECT 1 FROM media WHERE id = ?').get(record.id)
    const id = idCollision ? randomUUID() : record.id
    const ext = path.extname(record.originalName) || `.${mime.extension(record.mimeType || '') || 'bin'}`
    const storedPath = path.join(this.mediaDir, `${record.sha256}${ext.toLowerCase()}`)
    if (!fs.existsSync(storedPath)) fs.writeFileSync(storedPath, data)
    this.db
      .prepare(
        `INSERT INTO media (id, original_name, stored_path, mime_type, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, record.originalName, storedPath, record.mimeType, record.sha256, nowIso())
    return id
  }

  hasMediaHash(hash: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM media WHERE hash = ?').get(hash))
  }

  /** Persist a media blob received from another device, preserving its media id so card references resolve. */
  saveMediaBlob(record: SyncMediaRecord, data: Buffer): void {
    const ext =
      path.extname(record.originalName) || `.${mime.extension(record.mimeType || '') || 'bin'}`
    const storedPath = path.join(this.mediaDir, `${record.sha256}${ext.toLowerCase()}`)
    if (!fs.existsSync(storedPath)) fs.writeFileSync(storedPath, data)

    const byId = this.db.prepare('SELECT id FROM media WHERE id = ?').get(record.id) as Row | undefined
    if (byId) {
      this.db
        .prepare('UPDATE media SET stored_path = ?, mime_type = ?, original_name = ? WHERE id = ?')
        .run(storedPath, record.mimeType, record.originalName, record.id)
      return
    }
    // A different id already owns this content-addressed blob — nothing more to store.
    if (this.hasMediaHash(record.sha256)) return

    this.db
      .prepare(
        `INSERT INTO media (id, original_name, stored_path, mime_type, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(record.id, record.originalName, storedPath, record.mimeType, record.sha256, nowIso())
  }

  getStats(deckId?: string | null): AppStats {
    const allDecks = this.listDecks()
    const scopeDeckIds = deckId ? this.getDeckTreeIds(deckId) : allDecks.map((deck) => deck.id)
    const scopeDeckIdSet = new Set(scopeDeckIds)
    const scopedDecks = allDecks.filter((deck) => scopeDeckIdSet.has(deck.id))
    const cards = deckId ? this.listCards(deckId) : this.listCards()
    const now = Date.now()
    const newCards = cards.filter((card) => card.state === 'New').length
    const dueCards = cards.filter(
      (card) => card.state !== 'New' && card.dueAt !== null && Date.parse(card.dueAt) <= now
    ).length
    const reviewedCards = cards.filter((card) => card.reps > 0)
    const reviewLogs = this.listReviewLogs(deckId ? scopeDeckIds : undefined)
    const statsResetAtByCardId = this.getStatsResetAtByCardId(deckId ? scopeDeckIds : undefined)
    const analyticsReviewLogs = this.filterAnalyticsReviewLogs(reviewLogs, statsResetAtByCardId)
    const { todayStartMs, weekStartMs, monthStartMs } = this.getStudyTimeWindowStarts()
    const studyTime = reviewLogs.reduce(
      (totals, log) => {
        const reviewedAtMs = Date.parse(log.reviewedAt)
        const elapsedMs = Math.max(0, log.elapsedMs)
        totals.overallMs += elapsedMs
        if (reviewedAtMs >= monthStartMs) totals.monthMs += elapsedMs
        if (reviewedAtMs >= weekStartMs) totals.weekMs += elapsedMs
        if (reviewedAtMs >= todayStartMs) totals.todayMs += elapsedMs
        return totals
      },
      {
        todayMs: 0,
        weekMs: 0,
        monthMs: 0,
        overallMs: 0,
      }
    )
    const reviewedToday = reviewLogs.filter((log) => Date.parse(log.reviewedAt) >= todayStartMs).length
    const reviewedThisWeek = reviewLogs.filter((log) => Date.parse(log.reviewedAt) >= weekStartMs).length
    const reviewedThisMonth = reviewLogs.filter((log) => Date.parse(log.reviewedAt) >= monthStartMs).length
    const { currentStreakDays, longestStreakDays } = this.getStudyStreaks(reviewLogs)
    const { summaries: cardPerformance, averageAgainToEasyMs } = this.buildCardPerformance(cards, analyticsReviewLogs)
    const averageReviewMs = this.average(
      analyticsReviewLogs.map((log) => log.elapsedMs).filter((value) => value > 0)
    )
    const averageRevealMs = this.average(
      analyticsReviewLogs.map((log) => log.revealMs).filter((value) => value > 0)
    )
    const completedCards = Math.max(cards.length - newCards, 0)
    const scopeDeck = deckId ? scopedDecks.find((deck) => deck.id === deckId) ?? null : null

    return {
      scopeDeckId: scopeDeck?.id ?? null,
      scopeDeckName: scopeDeck?.name ?? null,
      totalDecks: scopedDecks.length,
      totalCards: cards.length,
      newCards,
      dueCards,
      reviewedToday,
      reviewedThisWeek,
      reviewedThisMonth,
      totalReviews: analyticsReviewLogs.length,
      averageSuccessRate: reviewedCards.length
        ? reviewedCards.reduce((sum, card) => sum + card.successRate, 0) / reviewedCards.length
        : 0,
      streakDays: currentStreakDays,
      longestStreakDays,
      studyTime,
      completion: {
        completedCards,
        totalCards: cards.length,
        completionRatio: cards.length > 0 ? completedCards / cards.length : 0,
        fullyLearned: cards.length > 0 && newCards === 0,
      },
      averageReviewMs,
      averageRevealMs,
      averageAgainToEasyMs,
      unitTestScores: scopedDecks.map((deck) => {
        const children = allDecks.filter((candidate) => candidate.parentId === deck.id)
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
      hardestCards: cardPerformance
        .sort(
          (a, b) =>
            b.difficultyScore - a.difficultyScore ||
            b.againCount - a.againCount ||
            a.successRate - b.successRate
        )
        .slice(0, 5),
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decks (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES decks(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'local',
        source_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source, source_id)
      );

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        note_type TEXT NOT NULL,
        fields_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_guid TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        template_ord INTEGER NOT NULL DEFAULT 0,
        front_html TEXT NOT NULL,
        back_html TEXT NOT NULL,
        media_refs_json TEXT NOT NULL DEFAULT '[]',
        source_card_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS review_state (
        card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
        due_at TEXT,
        state TEXT NOT NULL,
        stability REAL NOT NULL DEFAULT 0,
        difficulty REAL NOT NULL DEFAULT 0,
        elapsed_days INTEGER NOT NULL DEFAULT 0,
        scheduled_days INTEGER NOT NULL DEFAULT 0,
        learning_steps INTEGER NOT NULL DEFAULT 0,
        reps INTEGER NOT NULL DEFAULT 0,
        lapses INTEGER NOT NULL DEFAULT 0,
        success_rate REAL NOT NULL DEFAULT 0,
        last_rating TEXT,
        last_reviewed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS review_state_seed (
        card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
        due_at TEXT,
        state TEXT NOT NULL,
        stability REAL NOT NULL DEFAULT 0,
        difficulty REAL NOT NULL DEFAULT 0,
        elapsed_days INTEGER NOT NULL DEFAULT 0,
        scheduled_days INTEGER NOT NULL DEFAULT 0,
        learning_steps INTEGER NOT NULL DEFAULT 0,
        reps INTEGER NOT NULL DEFAULT 0,
        lapses INTEGER NOT NULL DEFAULT 0,
        success_rate REAL NOT NULL DEFAULT 0,
        last_rating TEXT,
        last_reviewed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS review_log (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        reviewed_at TEXT NOT NULL,
        rating TEXT NOT NULL,
        elapsed_ms INTEGER NOT NULL DEFAULT 0,
        reveal_ms INTEGER NOT NULL DEFAULT 0,
        answer_ms INTEGER NOT NULL DEFAULT 0,
        previous_due_at TEXT,
        next_due_at TEXT
      );

      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY,
        original_name TEXT NOT NULL,
        stored_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_outbox (
        event_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        pushed_at TEXT,
        UNIQUE(device_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS sync_inbox (
        event_id TEXT PRIMARY KEY,
        source_device_id TEXT NOT NULL,
        host_event_id INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_cursor (
        id TEXT PRIMARY KEY,
        last_host_event_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      -- Records waiting to be pushed, keyed by what they describe rather than
      -- appended per edit. Saving the same card twice before a sync replaces
      -- the queued row instead of queueing a second copy, so the outbox stays
      -- the size of what actually changed.
      CREATE TABLE IF NOT EXISTS record_outbox (
        record_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        record_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        merge_rank INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL,
        blob_refs_json TEXT NOT NULL DEFAULT '[]',
        queued_at TEXT NOT NULL
      );

      -- Media this library knows about, learned from media records. A file is
      -- downloaded by reconciling this against what is actually stored, so an
      -- interrupted download is retried without re-reading the record stream.
      -- Reviews already sent to the host, so the append-only review stream is
      -- pushed once each rather than re-sent every sync.
      CREATE TABLE IF NOT EXISTS review_log_sent (
        id TEXT PRIMARY KEY,
        sent_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS media_index (
        sha256 TEXT PRIMARY KEY,
        media_id TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL DEFAULT 0,
        original_name TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cards_deck ON cards(deck_id);
      CREATE INDEX IF NOT EXISTS idx_notes_source ON notes(source_guid);
      CREATE INDEX IF NOT EXISTS idx_review_state_due ON review_state(due_at, state);
      CREATE INDEX IF NOT EXISTS idx_review_log_card ON review_log(card_id);
      CREATE INDEX IF NOT EXISTS idx_review_log_reviewed_at ON review_log(reviewed_at);
      CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending ON sync_outbox(pushed_at, sequence);
      CREATE INDEX IF NOT EXISTS idx_sync_inbox_host_event ON sync_inbox(host_event_id);
      CREATE INDEX IF NOT EXISTS idx_record_outbox_queued ON record_outbox(queued_at);
    `)

    this.ensureColumn('cards', 'stats_reset_at', 'TEXT')
    this.ensureColumn('decks', 'unit_test_score', 'REAL')
    this.ensureColumn('decks', 'unit_tested_at', 'TEXT')
    this.ensureColumn('review_log', 'reveal_ms', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('review_log', 'answer_ms', 'INTEGER NOT NULL DEFAULT 0')
  }

  private ensureDefaultDeck(): void {
    const row = this.db.prepare('SELECT id FROM decks LIMIT 1').get() as Row | undefined
    if (row) return
    const timestamp = nowIso()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO decks (id, parent_id, name, source, source_id, created_at, updated_at)
         VALUES (?, NULL, 'Default', 'local', ?, ?, ?)`
      )
      .run(id, `local:${id}`, timestamp, timestamp)
  }

  private ensureReviewStateSeeds(): void {
    const rows = this.db
      .prepare(
        `SELECT c.id
         FROM cards c
         LEFT JOIN review_state_seed rss ON rss.card_id = c.id
         WHERE rss.card_id IS NULL`
      )
      .all() as Row[]
    if (rows.length === 0) return

    const tx = this.db.transaction(() => {
      for (const row of rows) {
        this.upsertReviewStateSeed(toStringValue(row.id), createDefaultReviewState())
      }
    })
    tx()
  }

  private assertDeck(deckId: string): void {
    const row = this.db.prepare('SELECT id FROM decks WHERE id = ?').get(deckId) as
      | Row
      | undefined
    if (!row) throw new Error('Deck not found.')
  }

  private getDeckTreeIds(deckId: string): string[] {
    this.assertDeck(deckId)
    const rows = this.db
      .prepare(
        `WITH RECURSIVE deck_tree(id) AS (
          SELECT ?
          UNION ALL
          SELECT d.id
          FROM decks d
          JOIN deck_tree dt ON d.parent_id = dt.id
        )
        SELECT id FROM deck_tree`
      )
      .all(deckId) as Row[]
    return rows.map((row) => toStringValue(row.id))
  }

  private getCardIdsForDeckTree(deckId: string): string[] {
    const deckIds = this.getDeckTreeIds(deckId)
    if (deckIds.length === 0) return []
    const placeholders = deckIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT id FROM cards WHERE deck_id IN (${placeholders})`)
      .all(...deckIds) as Row[]
    return rows.map((row) => toStringValue(row.id))
  }

  private listReviewLogs(scopeDeckIds?: string[]): ReviewLogEntry[] {
    if (scopeDeckIds && scopeDeckIds.length === 0) return []
    const placeholders = scopeDeckIds?.map(() => '?').join(',') ?? ''
    const where = scopeDeckIds ? `WHERE c.deck_id IN (${placeholders})` : ''
    const rows = this.db
      .prepare(
        `SELECT
          rl.card_id,
          rl.reviewed_at,
          rl.rating,
          rl.elapsed_ms,
          COALESCE(rl.reveal_ms, 0) AS reveal_ms,
          COALESCE(rl.answer_ms, 0) AS answer_ms
         FROM review_log rl
         JOIN cards c ON c.id = rl.card_id
         ${where}
         ORDER BY rl.card_id, rl.reviewed_at`
      )
      .all(...(scopeDeckIds ?? [])) as Row[]

    return rows.map((row) => ({
      cardId: toStringValue(row.card_id),
      reviewedAt: toStringValue(row.reviewed_at),
      rating: toStringValue(row.rating) as ReviewRating,
      elapsedMs: toNumber(row.elapsed_ms),
      revealMs: toNumber(row.reveal_ms),
      answerMs: toNumber(row.answer_ms),
    }))
  }

  private getStatsResetAtByCardId(scopeDeckIds?: string[]): Map<string, string | null> {
    if (scopeDeckIds && scopeDeckIds.length === 0) return new Map()
    const placeholders = scopeDeckIds?.map(() => '?').join(',') ?? ''
    const where = scopeDeckIds ? `WHERE deck_id IN (${placeholders})` : ''
    const rows = this.db
      .prepare(`SELECT id, stats_reset_at FROM cards ${where}`)
      .all(...(scopeDeckIds ?? [])) as Row[]
    return new Map(
      rows.map((row) => [
        toStringValue(row.id),
        row.stats_reset_at ? toStringValue(row.stats_reset_at) : null,
      ])
    )
  }

  private filterAnalyticsReviewLogs(
    reviewLogs: ReviewLogEntry[],
    statsResetAtByCardId: Map<string, string | null>
  ): ReviewLogEntry[] {
    return reviewLogs.filter((log) => {
      const resetAt = statsResetAtByCardId.get(log.cardId)
      return !resetAt || Date.parse(log.reviewedAt) >= Date.parse(resetAt)
    })
  }

  private getStudyTimeWindowStarts(): {
    todayStartMs: number
    weekStartMs: number
    monthStartMs: number
  } {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const weekStart = new Date(todayStart)
    weekStart.setDate(weekStart.getDate() - weekStart.getDay())
    const monthStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1)
    return {
      todayStartMs: todayStart.getTime(),
      weekStartMs: weekStart.getTime(),
      monthStartMs: monthStart.getTime(),
    }
  }

  private getStudyStreaks(reviewLogs: ReviewLogEntry[]): {
    currentStreakDays: number
    longestStreakDays: number
  } {
    const dayKeys = Array.from(new Set(reviewLogs.map((log) => this.toLocalDayKey(log.reviewedAt)))).sort()
    if (dayKeys.length === 0) return { currentStreakDays: 0, longestStreakDays: 0 }

    let longestStreakDays = 1
    let runningStreak = 1
    for (let index = 1; index < dayKeys.length; index += 1) {
      if (this.dayDiff(dayKeys[index - 1], dayKeys[index]) === 1) runningStreak += 1
      else runningStreak = 1
      longestStreakDays = Math.max(longestStreakDays, runningStreak)
    }

    const todayKey = this.toLocalDayKey(nowIso())
    const lastStudyDay = dayKeys[dayKeys.length - 1]
    if (this.dayDiff(lastStudyDay, todayKey) > 1) {
      return { currentStreakDays: 0, longestStreakDays }
    }

    let currentStreakDays = 1
    for (let index = dayKeys.length - 1; index > 0; index -= 1) {
      if (this.dayDiff(dayKeys[index - 1], dayKeys[index]) === 1) currentStreakDays += 1
      else break
    }

    return { currentStreakDays, longestStreakDays }
  }

  private buildCardPerformance(
    cards: CardSummary[],
    reviewLogs: ReviewLogEntry[]
  ): {
    summaries: HardCardSummary[]
    averageAgainToEasyMs: number | null
  } {
    const cardById = new Map(cards.map((card) => [card.id, card]))
    const accumulators = new Map<string, CardPerformanceAccumulator>()
    const allAgainToEasyDurations: number[] = []

    for (const log of reviewLogs) {
      const card = cardById.get(log.cardId)
      if (!card) continue

      const current = accumulators.get(log.cardId) ?? {
        card,
        reviewCount: 0,
        againCount: 0,
        easyCount: 0,
        totalReviewMs: 0,
        reviewMsCount: 0,
        totalRevealMs: 0,
        revealMsCount: 0,
        againToEasyDurations: [],
        pendingAgainAt: null,
      }

      current.reviewCount += 1
      if (log.elapsedMs > 0) {
        current.totalReviewMs += log.elapsedMs
        current.reviewMsCount += 1
      }
      if (log.revealMs > 0) {
        current.totalRevealMs += log.revealMs
        current.revealMsCount += 1
      }

      if (log.rating === 'again') {
        current.againCount += 1
        current.pendingAgainAt = Date.parse(log.reviewedAt)
      }

      if (log.rating === 'easy') {
        current.easyCount += 1
        if (current.pendingAgainAt !== null) {
          const duration = Date.parse(log.reviewedAt) - current.pendingAgainAt
          if (duration >= 0) {
            current.againToEasyDurations.push(duration)
            allAgainToEasyDurations.push(duration)
          }
          current.pendingAgainAt = null
        }
      }

      accumulators.set(log.cardId, current)
    }

    const summaries = Array.from(accumulators.values()).map((item) => {
      const averageReviewMs = item.reviewMsCount > 0 ? item.totalReviewMs / item.reviewMsCount : 0
      const averageRevealMs = item.revealMsCount > 0 ? item.totalRevealMs / item.revealMsCount : 0
      const averageAgainToEasyMs =
        item.againToEasyDurations.length > 0
          ? item.againToEasyDurations.reduce((sum, value) => sum + value, 0) / item.againToEasyDurations.length
          : null
      const difficultyScore =
        (1 - item.card.successRate) * 100 +
        item.againCount * 8 +
        item.card.lapses * 5 +
        Math.min(averageReviewMs / 1000, 45) * 0.6 +
        (averageAgainToEasyMs ? Math.min(averageAgainToEasyMs / 60000, 180) * 0.7 : 0)

      return {
        cardId: item.card.id,
        deckId: item.card.deckId,
        deckName: item.card.deckName,
        frontHtml: item.card.frontHtml,
        backHtml: item.card.backHtml,
        state: item.card.state,
        dueAt: item.card.dueAt,
        reps: item.card.reps,
        lapses: item.card.lapses,
        successRate: item.card.successRate,
        reviewCount: item.reviewCount,
        againCount: item.againCount,
        easyCount: item.easyCount,
        averageReviewMs,
        averageRevealMs,
        averageAgainToEasyMs,
        difficultyScore,
      }
    })

    return {
      summaries,
      averageAgainToEasyMs:
        allAgainToEasyDurations.length > 0
          ? allAgainToEasyDurations.reduce((sum, value) => sum + value, 0) / allAgainToEasyDurations.length
          : null,
    }
  }

  private average(values: number[]): number {
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
  }

  private toLocalDayKey(value: string): string {
    const date = new Date(value)
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-')
  }

  private dayDiff(previousDayKey: string, nextDayKey: string): number {
    const [previousYear, previousMonth, previousDay] = previousDayKey.split('-').map(Number)
    const [nextYear, nextMonth, nextDay] = nextDayKey.split('-').map(Number)
    const previous = new Date(previousYear, previousMonth - 1, previousDay)
    const next = new Date(nextYear, nextMonth - 1, nextDay)
    return Math.round((next.getTime() - previous.getTime()) / (24 * 60 * 60 * 1000))
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]
    if (columns.some((item) => toStringValue(item.name) === column)) return
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  private deckSummaryRows(where = ''): Database.Statement {
    return this.db.prepare(
      `SELECT
        d.id,
        d.parent_id,
        d.name,
        d.source,
        d.unit_test_score,
        d.unit_tested_at,
        d.created_at,
        d.updated_at,
        COUNT(c.id) AS total_cards,
        SUM(CASE WHEN COALESCE(rs.state, 'New') = 'New' THEN 1 ELSE 0 END) AS new_cards,
        SUM(CASE
          WHEN rs.due_at IS NOT NULL AND rs.due_at <= @now AND COALESCE(rs.state, 'New') <> 'New'
          THEN 1 ELSE 0 END) AS due_cards,
        SUM(CASE
          WHEN COALESCE(rs.state, 'New') IN ('Learning', 'Relearning')
          THEN 1 ELSE 0 END) AS learning_cards,
        SUM(CASE WHEN COALESCE(rs.state, 'New') = 'Review' THEN 1 ELSE 0 END) AS review_cards,
        AVG(CASE WHEN rs.reps > 0 THEN rs.success_rate ELSE NULL END) AS success_rate
       FROM decks d
       LEFT JOIN cards c ON c.deck_id = d.id
       LEFT JOIN review_state rs ON rs.card_id = c.id
       ${where}
       GROUP BY d.id
       ORDER BY d.name COLLATE NOCASE`
    )
  }

  private rowToSyncEvent(row: Row): SyncEventRecord {
    return {
      eventId: toStringValue(row.event_id),
      sourceDeviceId: toStringValue(row.device_id),
      sequence: toNumber(row.sequence),
      entityType: toStringValue(row.entity_type) as SyncEntityType,
      entityId: toStringValue(row.entity_id),
      eventType: toStringValue(row.event_type) as SyncEventType,
      payload: parseJson<SyncEventPayload>(row.payload_json, {}),
      createdAt: toStringValue(row.created_at),
    }
  }

  private rowToSyncDeckRecord(row: Row): SyncDeckRecord {
    return {
      id: toStringValue(row.id),
      parentId: row.parent_id ? toStringValue(row.parent_id) : null,
      name: toStringValue(row.name),
      source: toStringValue(row.source),
      sourceId: row.source_id ? toStringValue(row.source_id) : null,
      unitTestScore: row.unit_test_score === null || row.unit_test_score === undefined
        ? null
        : toNumber(row.unit_test_score),
      unitTestedAt: row.unit_tested_at ? toStringValue(row.unit_tested_at) : null,
      createdAt: toStringValue(row.created_at),
      updatedAt: toStringValue(row.updated_at),
    }
  }

  private applyDeckUpsert(payload: SyncDeckUpsertPayload): void {
    const deck = payload.deck
    const parentId = deck.parentId && this.hasDeck(deck.parentId) ? deck.parentId : null
    const hasUnitTestScore = Object.prototype.hasOwnProperty.call(deck, 'unitTestScore')
    this.db
      .prepare(
        `INSERT INTO decks
          (id, parent_id, name, source, source_id, unit_test_score, unit_tested_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          parent_id = excluded.parent_id,
          name = excluded.name,
          source = excluded.source,
          source_id = excluded.source_id,
          unit_test_score = CASE WHEN ? THEN excluded.unit_test_score ELSE decks.unit_test_score END,
          unit_tested_at = CASE WHEN ? THEN excluded.unit_tested_at ELSE decks.unit_tested_at END,
          updated_at = excluded.updated_at`
      )
      .run(
        deck.id,
        parentId,
        deck.name,
        deck.source,
        deck.sourceId,
        deck.unitTestScore ?? null,
        deck.unitTestedAt ?? null,
        deck.createdAt,
        deck.updatedAt,
        hasUnitTestScore ? 1 : 0,
        hasUnitTestScore ? 1 : 0
      )
  }

  private applyCardUpsert(payload: SyncCardUpsertPayload): void {
    const note = payload.note
    const card = payload.card
    const noteDeckId = this.resolveDeckId(note.deckId)
    const cardDeckId = this.resolveDeckId(card.deckId)

    this.db
      .prepare(
        `INSERT INTO notes
          (id, deck_id, note_type, fields_json, tags_json, source_guid, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          deck_id = excluded.deck_id,
          note_type = excluded.note_type,
          fields_json = excluded.fields_json,
          tags_json = excluded.tags_json,
          source_guid = excluded.source_guid,
          updated_at = excluded.updated_at`
      )
      .run(
        note.id,
        noteDeckId,
        note.noteType,
        json(note.fields),
        json(note.tags),
        note.sourceGuid,
        note.createdAt,
        note.updatedAt
      )

    this.db
      .prepare(
        `INSERT INTO cards
          (id, note_id, deck_id, template_ord, front_html, back_html, media_refs_json,
           source_card_id, created_at, updated_at, stats_reset_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          note_id = excluded.note_id,
          deck_id = excluded.deck_id,
          template_ord = excluded.template_ord,
          front_html = excluded.front_html,
          back_html = excluded.back_html,
          media_refs_json = excluded.media_refs_json,
          source_card_id = excluded.source_card_id,
          updated_at = excluded.updated_at,
          stats_reset_at = excluded.stats_reset_at`
      )
      .run(
        card.id,
        note.id,
        cardDeckId,
        card.templateOrd,
        card.frontHtml,
        card.backHtml,
        json(card.mediaRefs),
        card.sourceCardId,
        card.createdAt,
        card.updatedAt,
        card.statsResetAt
      )

    this.upsertReviewStateSeed(card.id, payload.reviewState)
    this.upsertReviewState(card.id, payload.reviewState)
  }

  private applyReviewAnswer(eventId: string, payload: SyncReviewAnswerPayload): void {
    if (!this.hasCard(payload.cardId)) return
    this.upsertReviewState(payload.cardId, payload.reviewState)
    this.db
      .prepare(
        `INSERT OR IGNORE INTO review_log
          (id, card_id, reviewed_at, rating, elapsed_ms, reveal_ms, answer_ms, previous_due_at, next_due_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        eventId,
        payload.cardId,
        payload.reviewedAt,
        payload.rating,
        payload.elapsedMs,
        payload.revealMs,
        payload.answerMs,
        payload.previousDueAt,
        payload.nextDueAt
      )
  }

  private deleteDeckIfPresent(deckId: string): void {
    this.db.prepare('DELETE FROM decks WHERE id = ?').run(deckId)
    this.ensureDefaultDeck()
  }

  private deleteCardIfPresent(cardId: string): void {
    const row = this.db.prepare('SELECT note_id FROM cards WHERE id = ?').get(cardId) as Row | undefined
    if (!row) return
    const noteId = toStringValue(row.note_id)
    this.db.prepare('DELETE FROM cards WHERE id = ?').run(cardId)
    const remaining = this.db.prepare('SELECT id FROM cards WHERE note_id = ? LIMIT 1').get(noteId) as
      | Row
      | undefined
    if (!remaining) this.db.prepare('DELETE FROM notes WHERE id = ?').run(noteId)
  }

  private hasDeck(deckId: string): boolean {
    const row = this.db.prepare('SELECT id FROM decks WHERE id = ?').get(deckId) as Row | undefined
    return Boolean(row)
  }

  private hasCard(cardId: string): boolean {
    const row = this.db.prepare('SELECT id FROM cards WHERE id = ?').get(cardId) as Row | undefined
    return Boolean(row)
  }

  private resolveDeckId(deckId: string): string {
    if (this.hasDeck(deckId)) return deckId
    this.ensureDefaultDeck()
    const row = this.db.prepare('SELECT id FROM decks ORDER BY created_at LIMIT 1').get() as Row
    return toStringValue(row.id)
  }

  private rowToDeckSummary(row: Row): DeckSummary {
    return {
      id: toStringValue(row.id),
      parentId: row.parent_id ? toStringValue(row.parent_id) : null,
      name: toStringValue(row.name),
      source: toStringValue(row.source),
      totalCards: toNumber(row.total_cards),
      newCards: toNumber(row.new_cards),
      dueCards: toNumber(row.due_cards),
      learningCards: toNumber(row.learning_cards),
      reviewCards: toNumber(row.review_cards),
      successRate: toNumber(row.success_rate),
      unitTestScore: row.unit_test_score === null || row.unit_test_score === undefined
        ? null
        : toNumber(row.unit_test_score),
      unitTestedAt: row.unit_tested_at ? toStringValue(row.unit_tested_at) : null,
      createdAt: toStringValue(row.created_at),
      updatedAt: toStringValue(row.updated_at),
    }
  }

  private rowToImportedReviewState(row: Row): ImportedReviewState {
    return {
      dueAt: row.due_at ? toStringValue(row.due_at) : null,
      state: toStringValue(row.state) as ReviewStateName,
      stability: toNumber(row.stability),
      difficulty: toNumber(row.difficulty),
      elapsedDays: toNumber(row.elapsed_days),
      scheduledDays: toNumber(row.scheduled_days),
      learningSteps: toNumber(row.learning_steps),
      reps: toNumber(row.reps),
      lapses: toNumber(row.lapses),
      successRate: toNumber(row.success_rate),
      lastRating: row.last_rating ? (toStringValue(row.last_rating) as ReviewRating) : null,
      lastReviewedAt: row.last_reviewed_at ? toStringValue(row.last_reviewed_at) : null,
    }
  }

  private rowToCardSummary(row: Row): CardSummary {
    return {
      id: toStringValue(row.id),
      noteId: toStringValue(row.note_id),
      deckId: toStringValue(row.deck_id),
      deckName: toStringValue(row.deck_name),
      templateOrd: toNumber(row.template_ord),
      frontHtml: toStringValue(row.front_html),
      backHtml: toStringValue(row.back_html),
      tags: parseJson<string[]>(row.tags_json, []),
      state: toStringValue(row.state) as ReviewStateName,
      dueAt: row.due_at ? toStringValue(row.due_at) : null,
      reps: toNumber(row.reps),
      lapses: toNumber(row.lapses),
      successRate: toNumber(row.success_rate),
      lastRating: row.last_rating ? (toStringValue(row.last_rating) as ReviewRating) : null,
      lastReviewedAt: row.last_reviewed_at ? toStringValue(row.last_reviewed_at) : null,
    }
  }

  private rowToMedia(row: Row): MediaRecord {
    return {
      id: toStringValue(row.id),
      originalName: toStringValue(row.original_name),
      storedPath: toStringValue(row.stored_path),
      mimeType: toStringValue(row.mime_type),
      hash: toStringValue(row.hash),
    }
  }
}
