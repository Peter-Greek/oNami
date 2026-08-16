/**
 * Content-addressed blob store logic.
 *
 * A blob is identified only by the SHA-256 of its bytes, so the same file
 * uploaded by any device, for any sync group or published deck, is stored once.
 * Uploads are resumable: the client asks how many bytes the host already holds
 * and appends from there, so an interrupted transfer never restarts.
 *
 * Everything here is pure so it can be tested without a database or filesystem.
 * The server owns the IO; this module owns the decisions.
 */

const SHA256_PATTERN = /^[a-f0-9]{64}$/i

/** Scope kinds that can keep a blob alive. A blob with no refs is collectable. */
export const BLOB_SCOPE_KINDS = new Set(['sync-group', 'published-deck'])

export const BLOB_GRACE = {
  /** A complete blob that loses its last reference is kept this long before deletion. */
  unreferencedMs: 24 * 60 * 60 * 1000,
  /** An upload nobody has appended to in this long is abandoned. */
  incompleteMs: 7 * 24 * 60 * 60 * 1000,
}

const invalid = (message) => ({ invalid: true, message })

export const normalizeSha256 = (value) =>
  typeof value === 'string' && SHA256_PATTERN.test(value) ? value.toLowerCase() : null

/**
 * Parses an upload `Content-Range: bytes <start>-<end>/<total>` header.
 * Note this is the response-style grammar with a space, not the `bytes=` used
 * by the `Range` request header.
 */
export const parseContentRange = (header, limits) => {
  if (typeof header !== 'string' || !header.trim()) return invalid('Content-Range is required.')

  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(header.trim())
  if (!match) return invalid('Content-Range must look like "bytes <start>-<end>/<total>".')

  const start = Number(match[1])
  const end = Number(match[2])
  const total = Number(match[3])

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) {
    return invalid('Content-Range values are out of range.')
  }
  if (total <= 0) return invalid('Content-Range total must be positive.')
  if (end < start) return invalid('Content-Range end must not precede its start.')
  if (end >= total) return invalid('Content-Range end must fall inside the total size.')
  if (total > limits.maxBlobBytes) return invalid('The blob is larger than this host accepts.')
  if (end - start + 1 > limits.maxChunkBytes) return invalid('The chunk is larger than this host accepts.')

  return { start, end, total, length: end - start + 1 }
}

/**
 * Decides what a PATCH should do given the range it declares and what the host
 * already holds. `stored` is `null` when the blob is entirely new.
 *
 * `offset` is always the byte the client should send next, so a conflicting
 * client can correct itself in one round trip rather than starting over.
 */
export const resolveBlobPatch = ({ stored, range }) => {
  if (stored?.complete) {
    return { outcome: 'already-complete', offset: stored.byteSize, byteSize: stored.byteSize }
  }

  const offset = stored?.receivedBytes ?? 0

  if (stored && stored.byteSize !== range.total) {
    return {
      outcome: 'size-conflict',
      offset,
      message: `This blob was declared as ${stored.byteSize} bytes and cannot change to ${range.total}.`,
    }
  }

  if (range.start !== offset) {
    return {
      outcome: 'offset-conflict',
      offset,
      message: `Expected the next chunk to start at byte ${offset}.`,
    }
  }

  return {
    outcome: 'append',
    offset,
    byteSize: range.total,
    completes: range.end + 1 === range.total,
  }
}

/**
 * Splits the hashes a client wants to upload into what the host still needs.
 * `partial` carries the resume offset so the client can continue mid-file.
 */
export const planBlobCheck = (requested, stored) => {
  const storedByHash = new Map(stored.map((blob) => [blob.sha256, blob]))
  const plan = { present: [], missing: [], partial: [] }

  for (const sha256 of new Set(requested)) {
    const blob = storedByHash.get(sha256)
    if (!blob) {
      plan.missing.push(sha256)
    } else if (blob.complete) {
      plan.present.push(sha256)
    } else {
      plan.partial.push({ sha256, offset: blob.receivedBytes })
    }
  }

  return plan
}

/**
 * Whether a blob may be deleted. Unlike the snapshot-ack cleanup this replaces,
 * collection never depends on a client confirming anything: a blob that nothing
 * references is reclaimed on its own, so a crashed transfer cannot strand bytes.
 */
export const isBlobCollectable = ({ complete, refCount, updatedAt, now, grace = BLOB_GRACE }) => {
  const idleMs = now - new Date(updatedAt).getTime()
  if (!complete) return idleMs >= grace.incompleteMs
  return refCount === 0 && idleMs >= grace.unreferencedMs
}
