import type { SyncMediaRecord, SyncSnapshotResponse } from './types'

/**
 * Files moved at once. This was three while every transfer was fragile — one
 * failure anywhere restarted the run, so small batches limited the damage.
 * Transfers now resume from a byte offset, so the batch is sized for
 * throughput instead of for damage control.
 */
export const SNAPSHOT_MEDIA_BATCH_SIZE = 6

export const selectAvailableMediaBatch = (
  media: SyncMediaRecord[],
  downloadedSha256: ReadonlySet<string>,
  availableSha256: ReadonlySet<string>,
  batchSize = SNAPSHOT_MEDIA_BATCH_SIZE
): SyncMediaRecord[] =>
  media
    .filter((item) => !downloadedSha256.has(item.sha256) && availableSha256.has(item.sha256))
    .slice(0, Math.max(1, batchSize))

export const getAvailableSnapshotMedia = (
  response: SyncSnapshotResponse,
  media: SyncMediaRecord[]
): Set<string> => {
  if (Array.isArray(response.availableMediaSha256)) {
    return new Set(response.availableMediaSha256)
  }

  // Older hosts only publish a manifest after every blob is available.
  return response.uploadComplete === false ? new Set() : new Set(media.map((item) => item.sha256))
}
