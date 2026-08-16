import { describe, expect, it, vi } from 'vitest'

import { type BlobDescriptor, createBlobClient } from './blobClient'
import { HostRequestError, type RequestOptions, type Transport } from './transport'

const blob = (bytes: Uint8Array, overrides: Partial<BlobDescriptor> = {}): BlobDescriptor => ({
  sha256: 'a'.repeat(64),
  byteSize: bytes.length,
  mimeType: 'audio/mpeg',
  originalName: 'genki-01.mp3',
  ...overrides,
})

const body = new Uint8Array(Array.from({ length: 1000 }, (_value, index) => index % 251))

/**
 * A transport backed by an in-memory host that behaves like the real one:
 * it appends at an offset, rejects a wrong one with the correct offset, and
 * honours Range on download.
 */
const fakeHost = (options: { stored?: Uint8Array; complete?: boolean; interruptAfter?: number } = {}) => {
  const state = {
    received: options.stored ? new Uint8Array(options.stored) : new Uint8Array(),
    complete: options.complete ?? false,
    patches: 0,
    ranges: [] as (string | undefined)[],
  }

  const transport: Transport = {
    request: async (request: RequestOptions) => {
      const headers = new Headers()

      if (request.method === 'HEAD') {
        if (state.received.length === 0 && !state.complete) {
          throw new HostRequestError('Blob not found.', 404, 'fail')
        }
        headers.set('upload-offset', String(state.received.length))
        headers.set('upload-complete', state.complete ? '?1' : '?0')
        return { status: 200, headers, bytes: new Uint8Array(), json: <T,>() => ({}) as T }
      }

      if (request.method === 'PATCH') {
        state.patches += 1
        if (options.interruptAfter !== undefined && state.patches > options.interruptAfter) {
          throw new HostRequestError('The connection stopped responding.', null, 'retry')
        }

        const [, startText] = /bytes (\d+)-(\d+)\/(\d+)/.exec(request.headers?.['content-range'] ?? '') ?? []
        const start = Number(startText)
        if (start !== state.received.length) {
          throw new HostRequestError('Wrong offset.', 409, 'fail', { offset: state.received.length })
        }

        const chunk = request.body as Uint8Array
        const merged = new Uint8Array(state.received.length + chunk.length)
        merged.set(state.received)
        merged.set(chunk, state.received.length)
        state.received = merged

        const total = Number(/\/(\d+)$/.exec(request.headers?.['content-range'] ?? '')?.[1])
        state.complete = state.received.length >= total
        const payload = { offset: state.received.length, complete: state.complete }
        return { status: 200, headers, bytes: new Uint8Array(), json: <T,>() => payload as T }
      }

      if (request.method === 'GET' && request.path.startsWith('/blob/')) {
        const range = request.headers?.range
        state.ranges.push(range)
        const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0
        const slice = state.received.subarray(start)
        request.onProgress?.(slice.length)
        return { status: range ? 206 : 200, headers, bytes: slice, json: <T,>() => ({}) as T }
      }

      const payload = { present: [], partial: [], missing: [] }
      return { status: 200, headers, bytes: new Uint8Array(), json: <T,>() => payload as T }
    },
  }

  return { transport, state }
}

const readFrom = (source: Uint8Array) => async (offset: number, length: number) =>
  source.subarray(offset, offset + length)

describe('upload', () => {
  it('sends a whole blob and reports progress that only moves forward', async () => {
    const { transport, state } = fakeHost()
    const client = createBlobClient({ transport })
    const seen: number[] = []

    const result = await client.upload({
      blob: blob(body),
      read: readFrom(body),
      onProgress: (progress) => seen.push(progress.transferred),
    })

    expect(state.received).toEqual(body)
    expect(state.complete).toBe(true)
    expect(result.reused).toBe(false)
    expect(seen).toEqual([...seen].sort((left, right) => left - right))
    expect(seen.at(-1)).toBe(body.length)
  })

  it('continues from what the host already holds instead of restarting', async () => {
    const { transport, state } = fakeHost({ stored: body.subarray(0, 600) })
    const client = createBlobClient({ transport })
    const reads: number[] = []

    const result = await client.upload({
      blob: blob(body),
      read: async (offset, length) => {
        reads.push(offset)
        return body.subarray(offset, offset + length)
      },
    })

    expect(reads[0]).toBe(600)
    expect(state.received).toEqual(body)
    // Only the remaining 400 bytes crossed the wire.
    expect(result.bytesSent).toBe(400)
  })

  it('skips a blob the host already has in full', async () => {
    const { transport } = fakeHost({ stored: body, complete: true })
    const read = vi.fn()
    const client = createBlobClient({ transport })

    const result = await client.upload({ blob: blob(body), read })

    expect(result).toEqual({ bytesSent: 0, reused: true })
    expect(read).not.toHaveBeenCalled()
  })

  it('corrects itself from the offset a conflict reports', async () => {
    const { transport, state } = fakeHost()
    // The host quietly already holds the first 300 bytes, but HEAD 404s, so the
    // client starts at zero and must recover from the 409.
    state.received = body.subarray(0, 300)
    const client = createBlobClient({ transport })

    await client.upload({ blob: blob(body), read: readFrom(body) })

    expect(state.received).toEqual(body)
  })

  it('surfaces an interruption so the job can keep its cursor and retry', async () => {
    const { transport, state } = fakeHost({ interruptAfter: 1 })
    const client = createBlobClient({ transport, chunkPolicy: { minBytes: 250, maxBytes: 250, targetSeconds: 5 } })
    let lastProgress = 0

    await expect(
      client.upload({
        blob: blob(body),
        read: readFrom(body),
        onProgress: (progress) => {
          lastProgress = progress.transferred
        },
      })
    ).rejects.toThrow('The connection stopped responding.')

    // The bytes that made it are still on the host, so the retry resumes.
    expect(state.received.length).toBe(250)
    expect(lastProgress).toBe(250)
  })

  it('fails clearly when the local file has gone missing', async () => {
    const { transport } = fakeHost()
    const client = createBlobClient({ transport })

    await expect(
      client.upload({ blob: blob(body), read: async () => new Uint8Array() })
    ).rejects.toThrow('genki-01.mp3 is missing from local storage.')
  })

  it('grows its chunk size as the connection proves itself', async () => {
    const { transport } = fakeHost()
    const sizes: number[] = []
    const client = createBlobClient({
      transport: {
        request: async (request) => {
          if (request.method === 'PATCH') sizes.push((request.body as Uint8Array).length)
          return transport.request(request)
        },
      },
      chunkPolicy: { minBytes: 100, maxBytes: 400, targetSeconds: 1 },
      // Every chunk appears to take 100ms, so throughput justifies growth.
      now: (() => {
        let tick = 0
        return () => (tick += 100)
      })(),
    })

    await client.upload({ blob: blob(body), read: readFrom(body) })

    expect(sizes[0]).toBe(100)
    expect(sizes[1]).toBeGreaterThan(sizes[0])
  })
})

describe('download', () => {
  it('writes the whole blob when nothing is stored yet', async () => {
    const { transport } = fakeHost({ stored: body, complete: true })
    const client = createBlobClient({ transport })
    const written: Array<{ offset: number; length: number }> = []

    await client.download({
      blob: blob(body),
      write: async (chunk, offset) => {
        written.push({ offset, length: chunk.length })
      },
    })

    expect(written).toEqual([{ offset: 0, length: 1000 }])
  })

  it('asks only for the bytes it is missing', async () => {
    const { transport, state } = fakeHost({ stored: body, complete: true })
    const client = createBlobClient({ transport })
    let receivedAt = -1

    const result = await client.download({
      blob: blob(body),
      startOffset: 700,
      write: async (_chunk, offset) => {
        receivedAt = offset
      },
    })

    expect(state.ranges).toEqual(['bytes=700-'])
    expect(result.bytesReceived).toBe(300)
    expect(receivedAt).toBe(700)
  })

  it('does nothing when the file is already complete locally', async () => {
    const { transport } = fakeHost({ stored: body, complete: true })
    const write = vi.fn()
    const client = createBlobClient({ transport })

    const result = await client.download({ blob: blob(body), startOffset: 1000, write })

    expect(result.bytesReceived).toBe(0)
    expect(write).not.toHaveBeenCalled()
  })

  it('restarts from zero if the host ignored the range request', async () => {
    // A host or proxy that answers 200 to a Range request sent the whole file.
    const transport: Transport = {
      request: async (request) => {
        request.onProgress?.(body.length)
        return { status: 200, headers: new Headers(), bytes: body, json: <T,>() => ({}) as T }
      },
    }
    const client = createBlobClient({ transport })
    let writtenAt = -1

    await client.download({
      blob: blob(body),
      startOffset: 700,
      write: async (_chunk, offset) => {
        writtenAt = offset
      },
    })

    expect(writtenAt).toBe(0)
  })
})

describe('check', () => {
  it('does not call the host for an empty list', async () => {
    const request = vi.fn()
    const client = createBlobClient({ transport: { request } })

    expect(await client.check([])).toEqual({ present: [], partial: [], missing: [] })
    expect(request).not.toHaveBeenCalled()
  })

  it('fills in anything the host left out of its answer', async () => {
    const client = createBlobClient({
      transport: {
        request: async () => ({
          status: 200,
          headers: new Headers(),
          bytes: new Uint8Array(),
          json: <T,>() => ({ missing: ['b'.repeat(64)] }) as T,
        }),
      },
    })

    expect(await client.check(['b'.repeat(64)])).toEqual({
      present: [],
      partial: [],
      missing: ['b'.repeat(64)],
    })
  })
})
