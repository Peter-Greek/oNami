/**
 * The sync model: one keyed, versioned record per thing.
 *
 * The previous design had two unrelated mechanisms. Ongoing changes went
 * through an append-only event log that grew forever — importing a deck queued
 * a fresh event for every card already in the library. A brand new device
 * instead got a one-time snapshot: the whole library built in memory, uploaded
 * as a single row, polled for, then deleted on acknowledgement.
 *
 * Here there is one mechanism. Records are keyed by `(kind, recordId)`, so
 * re-saving a card replaces its row rather than appending another; the store
 * stays the size of the library, not the size of its history. Every write gets
 * a monotonic `version`, and a device pulls everything after the version it
 * last saw.
 *
 * A new device passes version 0 and runs exactly the same loop. There is no
 * snapshot, no handoff, no target device, and no acknowledgement — hydration
 * and ongoing sync are the same code path, and both resume a page at a time.
 *
 * This is plain JavaScript with a hand-written `records.d.ts` beside it: the
 * merge rule has to be byte-identical on the host and on both clients, and the
 * host is plain Node that cannot import TypeScript. Types come from the
 * declaration file, so the clients still get full checking.
 */

/** @type {readonly import('./records').RecordKind[]} */
export const RECORD_KINDS = ['deck', 'card', 'media']

const timeOf = (iso) => {
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Decides whether an incoming write replaces what is already stored.
 *
 * Deletions compare on time alone: rank exists to stop stale scheduling data
 * from clobbering newer study, not to make a studied card undeletable.
 *
 * An exact tie keeps what is stored, which makes re-pushing the same record a
 * no-op and lets a client retry a batch safely.
 */
export const resolveRecordConflict = (existing, incoming) => {
  if (!existing) return 'accept'

  if (existing.deleted || incoming.deleted) {
    return timeOf(incoming.updatedAt) > timeOf(existing.updatedAt) ? 'accept' : 'keep-existing'
  }

  if (incoming.mergeRank !== existing.mergeRank) {
    return incoming.mergeRank > existing.mergeRank ? 'accept' : 'keep-existing'
  }

  return timeOf(incoming.updatedAt) > timeOf(existing.updatedAt) ? 'accept' : 'keep-existing'
}

const isRecordKind = (value) => typeof value === 'string' && RECORD_KINDS.includes(value)

/**
 * Checks envelope shape only. Card HTML and note fields are the app's business;
 * the host routes records without reading them.
 */
export const validateRecordEnvelope = (value, index = 0) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { index, reason: 'record must be an object.' }
  }

  if (!isRecordKind(value.kind)) return { index, reason: 'kind is not supported.' }
  if (typeof value.recordId !== 'string' || !value.recordId.trim()) {
    return { index, reason: 'recordId is required.' }
  }
  if (value.recordId.length > 200) return { index, reason: 'recordId is too long.' }
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    return { index, reason: 'updatedAt must be a valid timestamp.' }
  }
  if (typeof value.deleted !== 'boolean') return { index, reason: 'deleted must be a boolean.' }
  if (!Number.isInteger(value.mergeRank) || value.mergeRank < 0) {
    return { index, reason: 'mergeRank must be a non-negative integer.' }
  }
  if (value.blobRefs !== undefined) {
    if (!Array.isArray(value.blobRefs)) return { index, reason: 'blobRefs must be an array.' }
    if (value.blobRefs.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash))) {
      return { index, reason: 'blobRefs must be sha256 hashes.' }
    }
  }
  return null
}

/**
 * Collapses a batch so one push cannot contain two writes to the same record.
 * Keeps whichever would have won anyway, so the result does not depend on the
 * order a client happened to queue them in.
 */
export const dedupeRecordBatch = (records) => {
  const winners = new Map()
  for (const record of records) {
    const key = `${record.kind}|${record.recordId}`
    const existing = winners.get(key)
    if (!existing || resolveRecordConflict(existing, record) === 'accept') winners.set(key, record)
  }
  return [...winners.values()]
}

/** The cursor to store after applying a page. */
export const nextCursorFrom = (records, fallback) =>
  records.reduce((highest, record) => Math.max(highest, record.version), fallback)

/**
 * Every blob a set of records needs, so a client can ask the host which of them
 * it still has to fetch in one call.
 */
export const collectBlobRefs = (records) => {
  const hashes = new Set()
  for (const record of records) {
    if (record.deleted) continue
    for (const hash of record.blobRefs ?? []) hashes.add(hash.toLowerCase())
  }
  return [...hashes]
}
