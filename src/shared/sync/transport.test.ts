import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_CHUNK_POLICY,
  DEFAULT_RETRY_POLICY,
  HostRequestError,
  blendThroughput,
  classifyStatus,
  classifyThrown,
  createTransport,
  nextBackoffMs,
  nextChunkBytes,
  shouldRetry,
} from './transport'

describe('classifyStatus', () => {
  it('retries the statuses that can succeed later', () => {
    expect(classifyStatus(500)).toBe('retry')
    expect(classifyStatus(503)).toBe('retry')
    expect(classifyStatus(429)).toBe('retry')
    expect(classifyStatus(408)).toBe('retry')
  })

  it('gives up on a refusal the host will repeat', () => {
    expect(classifyStatus(400)).toBe('fail')
    expect(classifyStatus(401)).toBe('fail')
    expect(classifyStatus(404)).toBe('fail')
    expect(classifyStatus(409)).toBe('fail')
  })
})

describe('classifyThrown', () => {
  it('treats a connection that never answered as retryable', () => {
    expect(classifyThrown(new TypeError('Failed to fetch'))).toBe('retry')
    expect(classifyThrown(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('retry')
  })

  it('preserves a decision already made', () => {
    expect(classifyThrown(new HostRequestError('nope', 400, 'fail'))).toBe('fail')
  })
})

describe('nextBackoffMs', () => {
  it('doubles each attempt', () => {
    const noJitter = () => 0
    expect(nextBackoffMs(1, DEFAULT_RETRY_POLICY, noJitter)).toBe(1000)
    expect(nextBackoffMs(2, DEFAULT_RETRY_POLICY, noJitter)).toBe(2000)
    expect(nextBackoffMs(3, DEFAULT_RETRY_POLICY, noJitter)).toBe(4000)
    expect(nextBackoffMs(4, DEFAULT_RETRY_POLICY, noJitter)).toBe(8000)
  })

  it('settles at the ceiling instead of growing without bound', () => {
    expect(nextBackoffMs(50, DEFAULT_RETRY_POLICY, () => 0)).toBe(DEFAULT_RETRY_POLICY.maxDelayMs)
  })

  it('spreads retries so devices do not reconnect in lockstep', () => {
    expect(nextBackoffMs(3, DEFAULT_RETRY_POLICY, () => 1)).toBe(3000)
    expect(nextBackoffMs(3, DEFAULT_RETRY_POLICY, () => 0.5)).toBe(3500)
  })
})

describe('shouldRetry', () => {
  it('keeps trying forever by default', () => {
    expect(shouldRetry(9999)).toBe(true)
  })

  it('stops at a configured ceiling', () => {
    const policy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 }
    expect(shouldRetry(2, policy)).toBe(true)
    expect(shouldRetry(3, policy)).toBe(false)
  })
})

describe('nextChunkBytes', () => {
  it('starts small when nothing is known about the connection', () => {
    expect(nextChunkBytes(null)).toBe(DEFAULT_CHUNK_POLICY.minBytes)
    expect(nextChunkBytes(0)).toBe(DEFAULT_CHUNK_POLICY.minBytes)
  })

  it('sizes a chunk to take about the target duration', () => {
    expect(nextChunkBytes(1024 * 1024)).toBe(5 * 1024 * 1024)
  })

  it('clamps both ends so one chunk is never trivial or enormous', () => {
    expect(nextChunkBytes(1000)).toBe(DEFAULT_CHUNK_POLICY.minBytes)
    expect(nextChunkBytes(100 * 1024 * 1024)).toBe(DEFAULT_CHUNK_POLICY.maxBytes)
  })
})

describe('blendThroughput', () => {
  it('adopts the first sample and then smooths', () => {
    expect(blendThroughput(null, 1000, 1000)).toBe(1000)
    expect(blendThroughput(1000, 3000, 1000)).toBe(2000)
  })

  it('ignores a sample that measures nothing', () => {
    expect(blendThroughput(1234, 0, 1000)).toBe(1234)
    expect(blendThroughput(1234, 1000, 0)).toBe(1234)
  })
})

/** Builds a transport whose sleeps are instant so retry paths are testable. */
const harness = (responses: Array<() => Promise<Response>>) => {
  const sleeps: number[] = []
  let call = 0
  const transport = createTransport({
    hostUrl: () => 'https://host.test',
    token: () => 'device-token',
    fetch: (async () => {
      const next = responses[Math.min(call, responses.length - 1)]
      call += 1
      return next()
    }) as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    random: () => 0,
  })
  return { transport, sleeps, calls: () => call }
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('createTransport', () => {
  it('sends the bearer token and parses the response', async () => {
    const seen: RequestInit[] = []
    const transport = createTransport({
      hostUrl: () => 'https://host.test',
      token: async () => 'device-token',
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push(init)
        return jsonResponse(200, { ok: true })
      }) as unknown as typeof fetch,
    })

    const response = await transport.request({ method: 'GET', path: '/health' })

    expect(response.json<{ ok: boolean }>()).toEqual({ ok: true })
    expect((seen[0].headers as Record<string, string>).authorization).toBe('Bearer device-token')
  })

  it('omits the token for a public endpoint', async () => {
    const seen: RequestInit[] = []
    const transport = createTransport({
      hostUrl: () => 'https://host.test',
      token: () => 'device-token',
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push(init)
        return jsonResponse(200, {})
      }) as unknown as typeof fetch,
    })

    await transport.request({ method: 'GET', path: '/global-decks', anonymous: true })

    expect((seen[0].headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('retries a server error with growing backoff and then succeeds', async () => {
    const { transport, sleeps, calls } = harness([
      async () => jsonResponse(503, { error: 'busy' }),
      async () => jsonResponse(503, { error: 'busy' }),
      async () => jsonResponse(200, { ok: true }),
    ])

    const response = await transport.request({ method: 'GET', path: '/sync/events' })

    expect(response.json<{ ok: boolean }>()).toEqual({ ok: true })
    expect(sleeps).toEqual([1000, 2000])
    expect(calls()).toBe(3)
  })

  it('retries a connection that never answered', async () => {
    const { transport, sleeps } = harness([
      async () => {
        throw new TypeError('Failed to fetch')
      },
      async () => jsonResponse(200, { ok: true }),
    ])

    await expect(transport.request({ method: 'GET', path: '/health' })).resolves.toBeTruthy()
    expect(sleeps).toEqual([1000])
  })

  it('does not retry a refusal, and surfaces the host message', async () => {
    const { transport, sleeps, calls } = harness([async () => jsonResponse(400, { error: 'sha256 is invalid.' })])

    await expect(transport.request({ method: 'POST', path: '/blobs/check' })).rejects.toThrow('sha256 is invalid.')
    expect(sleeps).toEqual([])
    expect(calls()).toBe(1)
  })

  it('stops after the configured attempts for a per-call policy', async () => {
    const { transport, calls } = harness([async () => jsonResponse(500, { error: 'boom' })])

    await expect(
      transport.request({ method: 'GET', path: '/health', retry: { maxAttempts: 3 } })
    ).rejects.toThrow('boom')
    expect(calls()).toBe(3)
  })

  it('reports each wait so a transfer can explain itself', async () => {
    const onRetry = vi.fn()
    const transport = createTransport({
      hostUrl: () => 'https://host.test',
      fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch,
      sleep: async () => undefined,
      random: () => 0,
      onRetry,
      retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 2 },
    })

    await expect(transport.request({ method: 'GET', path: '/health' })).rejects.toThrow()
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, delayMs: 1000, reason: 'Failed to fetch' })
  })

  it('stops immediately when the caller cancels', async () => {
    const controller = new AbortController()
    controller.abort()
    const { transport, calls } = harness([async () => jsonResponse(200, {})])

    await expect(
      transport.request({ method: 'GET', path: '/health', signal: controller.signal })
    ).rejects.toThrow('Cancelled.')
    expect(calls()).toBe(0)
  })

  it('does not take a slow download for a dead one', async () => {
    // Three chunks, each arriving well after a ten-second wall-clock budget
    // would have expired, but none pausing longer than the stall timeout.
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let index = 0; index < 3; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5))
          controller.enqueue(new Uint8Array([index]))
        }
        controller.close()
      },
    })
    const transport = createTransport({
      hostUrl: () => 'https://host.test',
      fetch: (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch,
      stallTimeoutMs: 50,
    })

    const progress: number[] = []
    const response = await transport.request({
      method: 'GET',
      path: '/blob/abc',
      onProgress: (bytes) => progress.push(bytes),
    })

    expect(Array.from(response.bytes)).toEqual([0, 1, 2])
    expect(progress).toEqual([1, 2, 3])
  })

  it('abandons a download that stops producing bytes', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
        // Never closes and never sends again.
      },
    })
    const transport = createTransport({
      hostUrl: () => 'https://host.test',
      fetch: (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch,
      sleep: async () => undefined,
      random: () => 0,
      stallTimeoutMs: 20,
      retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
    })

    await expect(transport.request({ method: 'GET', path: '/blob/abc' })).rejects.toThrow(
      'The connection stopped responding.'
    )
  })
})
