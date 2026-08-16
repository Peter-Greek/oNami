/**
 * Types for `records.js`.
 *
 * The implementation is plain JavaScript because the merge rule must be
 * byte-identical on the host and both clients, and the host is plain Node that
 * cannot import TypeScript. These declarations give the clients full checking
 * against that one implementation.
 */

export type RecordKind = 'deck' | 'card' | 'media'

export declare const RECORD_KINDS: readonly RecordKind[]

/** What a client sends. The host stores this and stamps a version on it. */
export interface SyncRecordEnvelope {
  kind: RecordKind
  recordId: string
  /** The writing device's clock. Used to order writes of equal rank. */
  updatedAt: string
  deleted: boolean
  /**
   * Monotonic rank used to resolve a conflict before falling back to time.
   *
   * For a card this is its review count. Clocks between devices disagree, and
   * plain last-writer-wins lets a desktop that has been closed for a week
   * overwrite reviews done on a phone that morning — silently undoing study,
   * the worst possible outcome in a spaced-repetition app. Ranking by reviews
   * first means the device that has studied more never loses to one that has
   * studied less, whatever the clocks say.
   */
  mergeRank: number
  payload: unknown
  /** Content hashes this record needs before it can render. */
  blobRefs: string[]
}

/** A record as the host returns it. */
export interface StoredSyncRecord extends SyncRecordEnvelope {
  version: number
}

export interface RecordPage {
  records: StoredSyncRecord[]
  nextCursor: number
}

/** One immutable review, in its own append-only stream. */
export interface ReviewLogEntry {
  id: string
  cardId: string
  reviewedAt: string
  rating: number
  elapsedMs: number
  revealMs: number
  answerMs: number
  previousDueAt: string | null
  nextDueAt: string | null
}

export interface ReviewLogPage {
  entries: Array<ReviewLogEntry & { version: number }>
  nextCursor: number
}

export type MergeDecision = 'accept' | 'keep-existing'

export interface RecordValidationError {
  index: number
  reason: string
}

type MergeInput = Pick<SyncRecordEnvelope, 'updatedAt' | 'mergeRank' | 'deleted'>

export declare const resolveRecordConflict: (
  existing: MergeInput | null,
  incoming: MergeInput
) => MergeDecision

export declare const validateRecordEnvelope: (
  value: unknown,
  index?: number
) => RecordValidationError | null

export declare const dedupeRecordBatch: (records: SyncRecordEnvelope[]) => SyncRecordEnvelope[]

export declare const nextCursorFrom: (records: StoredSyncRecord[], fallback: number) => number

export declare const collectBlobRefs: (
  records: Array<Pick<StoredSyncRecord, 'blobRefs' | 'deleted'>>
) => string[]
