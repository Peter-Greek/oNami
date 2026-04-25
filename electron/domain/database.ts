import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import mime from 'mime-types'

import type {
  AppStats,
  CardSummary,
  CreateCardInput,
  CreateDeckInput,
  DeckDetail,
  DeckSummary,
  HardCardSummary,
  ReviewRating,
  ReviewStateName,
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

      CREATE INDEX IF NOT EXISTS idx_cards_deck ON cards(deck_id);
      CREATE INDEX IF NOT EXISTS idx_notes_source ON notes(source_guid);
      CREATE INDEX IF NOT EXISTS idx_review_state_due ON review_state(due_at, state);
      CREATE INDEX IF NOT EXISTS idx_review_log_card ON review_log(card_id);
      CREATE INDEX IF NOT EXISTS idx_review_log_reviewed_at ON review_log(reviewed_at);
    `)

    this.ensureColumn('cards', 'stats_reset_at', 'TEXT')
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
