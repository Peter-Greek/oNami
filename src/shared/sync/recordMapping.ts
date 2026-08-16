/**
 * Converts between oNami's domain data and the record envelopes the host
 * stores. Shared so the desktop and Android builds agree on what a card record
 * is, including the rank that decides conflicts.
 */

import type { StoredSyncRecord, SyncRecordEnvelope } from './records'
import type {
  SyncCardUpsertPayload,
  SyncDeckRecord,
  SyncMediaRecord,
  SyncReviewLogRecord,
} from '../types'

/**
 * A card's rank is its review count.
 *
 * This is the value that stops a device which has been offline from overwriting
 * study done elsewhere: whichever copy has been reviewed more wins, regardless
 * of whose clock is further ahead.
 */
export const cardMergeRank = (payload: SyncCardUpsertPayload): number => {
  const reps = payload.reviewState?.reps
  return Number.isInteger(reps) && reps > 0 ? reps : 0
}

export const deckToRecord = (deck: SyncDeckRecord): SyncRecordEnvelope => ({
  kind: 'deck',
  recordId: deck.id,
  updatedAt: deck.updatedAt,
  deleted: false,
  mergeRank: 0,
  payload: deck,
  blobRefs: [],
})

export const cardToRecord = (payload: SyncCardUpsertPayload): SyncRecordEnvelope => ({
  kind: 'card',
  recordId: payload.card.id,
  updatedAt: payload.card.updatedAt,
  deleted: false,
  mergeRank: cardMergeRank(payload),
  payload,
  blobRefs: [],
})

/**
 * Media records carry the content hash, which is how a device learns what to
 * download. Cards reference media by local id rather than hash, so the media
 * record — not the card — is what ties a library to its files.
 */
export const mediaToRecord = (media: SyncMediaRecord): SyncRecordEnvelope => ({
  kind: 'media',
  recordId: media.id,
  // Media is immutable once imported; its id is derived from its content.
  updatedAt: new Date(0).toISOString(),
  deleted: false,
  mergeRank: 0,
  payload: media,
  blobRefs: [media.sha256],
})

export const tombstone = (
  kind: SyncRecordEnvelope['kind'],
  recordId: string,
  updatedAt = new Date().toISOString()
): SyncRecordEnvelope => ({
  kind,
  recordId,
  updatedAt,
  deleted: true,
  mergeRank: 0,
  payload: {},
  blobRefs: [],
})

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * Reads a deck out of a record. Returns null rather than throwing when the
 * payload is unusable: one malformed record must not stop a whole page from
 * applying, or a single bad row would wedge sync forever.
 */
export const readDeckRecord = (record: StoredSyncRecord): SyncDeckRecord | null => {
  if (!isObject(record.payload)) return null
  const deck = record.payload as unknown as SyncDeckRecord
  if (!asString(deck.id) || !asString(deck.name)) return null
  return deck
}

export const readCardRecord = (record: StoredSyncRecord): SyncCardUpsertPayload | null => {
  if (!isObject(record.payload)) return null
  const payload = record.payload as unknown as SyncCardUpsertPayload
  if (!isObject(payload.card) || !isObject(payload.note) || !isObject(payload.reviewState)) return null
  if (!asString(payload.card.id) || !asString(payload.note.id)) return null
  return payload
}

export const readMediaRecord = (record: StoredSyncRecord): SyncMediaRecord | null => {
  if (!isObject(record.payload)) return null
  const media = record.payload as unknown as SyncMediaRecord
  if (!asString(media.id) || !/^[a-f0-9]{64}$/i.test(asString(media.sha256))) return null
  return { ...media, sha256: media.sha256.toLowerCase() }
}

export const reviewLogToEntry = (log: SyncReviewLogRecord): Record<string, unknown> => ({ ...log })

export const readReviewLogEntry = (value: unknown): SyncReviewLogRecord | null => {
  if (!isObject(value)) return null
  const entry = value as unknown as SyncReviewLogRecord
  if (!asString(entry.id) || !asString(entry.cardId) || !asString(entry.reviewedAt)) return null
  return entry
}

/**
 * Everything in a library as records, for a device that has never pushed.
 *
 * This is the closest thing to the old snapshot, and the difference is the
 * point: it is an ordinary batch of ordinary records, pushed through the
 * ordinary endpoint, and a device that is interrupted resumes from the records
 * it already sent rather than rebuilding the whole bundle.
 */
export const buildLibraryRecords = (library: {
  decks: SyncDeckRecord[]
  cards: SyncCardUpsertPayload[]
  media: SyncMediaRecord[]
}): SyncRecordEnvelope[] => [
  ...library.decks.map(deckToRecord),
  ...library.cards.map(cardToRecord),
  ...library.media.map(mediaToRecord),
]
