/**
 * Resumable media transfer, shared by the desktop and Android builds.
 *
 * Media used to travel as base64 inside JSON: a third more bytes than the file,
 * both ends holding the whole thing in memory, and no way to continue a
 * transfer that stopped. This speaks the host's blob endpoints instead — ask
 * where it stopped, continue from there, in raw binary.
 *
 * The local side is a port so each platform supplies its own storage: the
 * desktop reads and writes files, the Android build stages chunks in IndexedDB.
 */

import {
  DEFAULT_CHUNK_POLICY,
  type ChunkPolicy,
  HostRequestError,
  type Transport,
  blendThroughput,
  nextChunkBytes,
} from './transport'

export interface BlobDescriptor {
  sha256: string
  byteSize: number
  mimeType: string
  /** Shown to the user, so a stalled transfer names a file they recognise. */
  originalName: string
}

export interface BlobCheckPlan {
  present: string[]
  partial: Array<{ sha256: string; offset: number }>
  missing: string[]
}

/** Where a transfer is up to, persisted as a job cursor. */
export interface BlobTransferProgress {
  sha256: string
  transferred: number
  total: number
}

export type BlobProgressReporter = (progress: BlobTransferProgress) => void

/** Supplies the bytes being uploaded, a slice at a time. */
export type BlobReader = (offset: number, length: number) => Promise<Uint8Array>

/** Receives downloaded bytes. Called in order, and must persist before returning. */
export type BlobWriter = (chunk: Uint8Array, offset: number) => Promise<void>

export interface BlobClientOptions {
  transport: Transport
  chunkPolicy?: ChunkPolicy
  now?: () => number
}

export interface UploadBlobInput {
  blob: BlobDescriptor
  read: BlobReader
  onProgress?: BlobProgressReporter
  signal?: AbortSignal
}

export interface DownloadBlobInput {
  blob: BlobDescriptor
  write: BlobWriter
  /** Bytes already stored locally, so a resumed download asks only for the rest. */
  startOffset?: number
  onProgress?: BlobProgressReporter
  signal?: AbortSignal
}

export interface BlobClient {
  check(hashes: string[]): Promise<BlobCheckPlan>
  /** Returns the byte offset the host holds, or null if it has nothing. */
  peek(sha256: string): Promise<{ offset: number; complete: boolean } | null>
  upload(input: UploadBlobInput): Promise<{ bytesSent: number; reused: boolean }>
  download(input: DownloadBlobInput): Promise<{ bytesReceived: number }>
}

const parseOffset = (value: string | null): number => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

export const createBlobClient = (options: BlobClientOptions): BlobClient => {
  const { transport } = options
  const chunkPolicy = options.chunkPolicy ?? DEFAULT_CHUNK_POLICY
  const now = options.now ?? (() => Date.now())

  const peek: BlobClient['peek'] = async (sha256) => {
    try {
      const response = await transport.request({ method: 'HEAD', path: `/blob/${sha256}` })
      return {
        offset: parseOffset(response.headers.get('upload-offset')),
        complete: response.headers.get('upload-complete') === '?1',
      }
    } catch (error) {
      if (error instanceof HostRequestError && error.status === 404) return null
      throw error
    }
  }

  const check: BlobClient['check'] = async (hashes) => {
    if (hashes.length === 0) return { present: [], partial: [], missing: [] }
    const response = await transport.request({
      method: 'POST',
      path: '/blobs/check',
      json: { sha256: hashes },
    })
    const plan = response.json<Partial<BlobCheckPlan>>()
    return {
      present: plan.present ?? [],
      partial: plan.partial ?? [],
      missing: plan.missing ?? [],
    }
  }

  const upload: BlobClient['upload'] = async ({ blob, read, onProgress, signal }) => {
    // Ask where to continue rather than assuming the start. This one call is
    // the difference between resuming and restarting.
    const existing = await peek(blob.sha256)
    if (existing?.complete) {
      onProgress?.({ sha256: blob.sha256, transferred: blob.byteSize, total: blob.byteSize })
      return { bytesSent: 0, reused: true }
    }

    let offset = existing?.offset ?? 0
    let throughput: number | null = null
    let bytesSent = 0

    onProgress?.({ sha256: blob.sha256, transferred: offset, total: blob.byteSize })

    while (offset < blob.byteSize) {
      const length = Math.min(nextChunkBytes(throughput, chunkPolicy), blob.byteSize - offset)
      const chunk = await read(offset, length)
      if (chunk.length === 0) {
        throw new HostRequestError(`${blob.originalName} is missing from local storage.`, null, 'fail')
      }

      const startedAt = now()
      let response
      try {
        response = await transport.request({
          method: 'PATCH',
          path: `/blob/${blob.sha256}`,
          body: chunk,
          headers: {
            'content-type': blob.mimeType || 'application/octet-stream',
            'content-range': `bytes ${offset}-${offset + chunk.length - 1}/${blob.byteSize}`,
          },
          signal,
        })
      } catch (error) {
        // The host answers a mismatched offset with the one to use, so a client
        // that lost track corrects itself in a single round trip.
        if (error instanceof HostRequestError && error.status === 409) {
          const corrected = (error.body as { offset?: number } | undefined)?.offset
          if (typeof corrected === 'number' && corrected !== offset) {
            offset = corrected
            onProgress?.({ sha256: blob.sha256, transferred: offset, total: blob.byteSize })
            continue
          }
        }
        throw error
      }

      throughput = blendThroughput(throughput, chunk.length, now() - startedAt)
      bytesSent += chunk.length

      const result = response.json<{ offset?: number; complete?: boolean }>()
      offset = typeof result.offset === 'number' ? result.offset : offset + chunk.length
      onProgress?.({ sha256: blob.sha256, transferred: offset, total: blob.byteSize })

      if (result.complete) break
    }

    return { bytesSent, reused: false }
  }

  const download: BlobClient['download'] = async ({ blob, write, startOffset = 0, onProgress, signal }) => {
    if (startOffset >= blob.byteSize && blob.byteSize > 0) {
      onProgress?.({ sha256: blob.sha256, transferred: blob.byteSize, total: blob.byteSize })
      return { bytesReceived: 0 }
    }

    onProgress?.({ sha256: blob.sha256, transferred: startOffset, total: blob.byteSize })

    const response = await transport.request({
      method: 'GET',
      path: `/blob/${blob.sha256}`,
      // Asking for the remainder is what makes an interrupted download cheap.
      headers: startOffset > 0 ? { range: `bytes=${startOffset}-` } : {},
      signal,
      onProgress: (bytes) =>
        onProgress?.({ sha256: blob.sha256, transferred: startOffset + bytes, total: blob.byteSize }),
    })

    // A host that ignored the Range header sent the whole file; writing it from
    // the requested offset would corrupt the result, so start over from zero.
    const servedFromStart = startOffset > 0 && response.status !== 206
    const writeOffset = servedFromStart ? 0 : startOffset

    await write(response.bytes, writeOffset)
    onProgress?.({
      sha256: blob.sha256,
      transferred: writeOffset + response.bytes.length,
      total: blob.byteSize,
    })

    return { bytesReceived: response.bytes.length }
  }

  return { check, peek, upload, download }
}
