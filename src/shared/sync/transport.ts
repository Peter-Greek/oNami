/**
 * The one place oNami talks to the sync host.
 *
 * Both clients previously wrapped every request in a fixed ten-second abort,
 * including media uploads of tens of megabytes. A large file on a slow link
 * could not finish inside that window, so it aborted, the transfer was marked
 * failed, and the next attempt began again from the start.
 *
 * Two rules replace that:
 *
 *  - Nothing is abandoned for taking a long time. A request is only abandoned
 *    when it stops making progress, measured by a stall timer that resets on
 *    every byte that moves.
 *  - A failure that could plausibly succeed later is retried with exponential
 *    backoff rather than surfacing to the user as an error.
 *
 * Upload progress is invisible to `fetch`, so chunk size is adapted to the
 * measured throughput instead: each chunk aims to take a few seconds, which
 * keeps the stall timer meaningful and caps what one interruption can cost.
 */

export interface RetryPolicy {
  /** Delay before the first retry. Each further attempt doubles it. */
  baseDelayMs: number
  /** Ceiling on the delay, so a long outage settles into steady polling. */
  maxDelayMs: number
  /** Fraction of the delay randomised, so many devices do not retry in lockstep. */
  jitterRatio: number
  /**
   * Attempts before a retryable failure is reported. A transfer that must
   * survive a commute needs this high; `null` means keep trying forever.
   */
  maxAttempts: number | null
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60 * 1000,
  jitterRatio: 0.25,
  maxAttempts: null,
}

export interface ChunkPolicy {
  minBytes: number
  maxBytes: number
  /** How long one chunk should ideally take, which sets the size. */
  targetSeconds: number
}

export const DEFAULT_CHUNK_POLICY: ChunkPolicy = {
  minBytes: 256 * 1024,
  maxBytes: 8 * 1024 * 1024,
  targetSeconds: 5,
}

/** No progress for this long means the connection is gone, however slow it was. */
export const DEFAULT_STALL_TIMEOUT_MS = 30_000

export type FailureKind = 'retry' | 'fail'

export class HostRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly kind: FailureKind,
    readonly body?: unknown
  ) {
    super(message)
    this.name = 'HostRequestError'
  }
}

/**
 * Whether a status code is worth trying again.
 *
 * A 4xx means the host understood and refused, so repeating it changes nothing
 * — except 408 and 429, which explicitly invite a retry. Everything at 5xx is
 * the host having a bad moment.
 */
export const classifyStatus = (status: number): FailureKind => {
  if (status === 408 || status === 429) return 'retry'
  if (status >= 500) return 'retry'
  return 'fail'
}

/** A transport-level throw means the request never got an answer, so retry. */
export const classifyThrown = (error: unknown): FailureKind => {
  if (error instanceof HostRequestError) return error.kind
  if (error instanceof Error && error.name === 'AbortError') return 'retry'
  return 'retry'
}

/**
 * Delay before attempt number `attempt` (1 is the first retry). Doubles up to
 * the ceiling, then randomises downward by the jitter ratio.
 */
export const nextBackoffMs = (
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random
): number => {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1)
  const capped = Math.min(exponential, policy.maxDelayMs)
  const jitter = capped * policy.jitterRatio * random()
  return Math.round(capped - jitter)
}

export const shouldRetry = (attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): boolean =>
  policy.maxAttempts === null || attempt < policy.maxAttempts

/**
 * Chunk size for the next upload, from the throughput seen so far. Starts at
 * the minimum when nothing is known yet, so a first chunk on a bad connection
 * is cheap to lose.
 */
export const nextChunkBytes = (
  observedBytesPerSecond: number | null,
  policy: ChunkPolicy = DEFAULT_CHUNK_POLICY
): number => {
  if (observedBytesPerSecond === null || !Number.isFinite(observedBytesPerSecond) || observedBytesPerSecond <= 0) {
    return policy.minBytes
  }
  const target = observedBytesPerSecond * policy.targetSeconds
  return Math.round(Math.min(policy.maxBytes, Math.max(policy.minBytes, target)))
}

/** Rolling throughput estimate, smoothed so one fast chunk cannot spike it. */
export const blendThroughput = (
  previous: number | null,
  sampleBytes: number,
  sampleMs: number,
  smoothing = 0.5
): number | null => {
  if (sampleMs <= 0 || sampleBytes <= 0) return previous
  const sample = (sampleBytes / sampleMs) * 1000
  if (previous === null) return sample
  return previous * (1 - smoothing) + sample * smoothing
}

export interface TransportOptions {
  hostUrl: () => string
  token?: () => Promise<string | null> | string | null
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  now?: () => number
  retry?: RetryPolicy
  stallTimeoutMs?: number
  /** Called before each retry so a transfer can explain the wait to the user. */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void
}

export interface RequestOptions {
  method: 'GET' | 'HEAD' | 'POST' | 'PATCH'
  path: string
  json?: unknown
  body?: Uint8Array
  headers?: Record<string, string>
  /** Skips the bearer token, for endpoints that are public. */
  anonymous?: boolean
  signal?: AbortSignal
  /** Retries are per-call: a cheap probe should not block for five minutes. */
  retry?: Partial<RetryPolicy>
  onProgress?: (bytes: number) => void
}

export interface HostResponse {
  status: number
  headers: Headers
  bytes: Uint8Array
  json: <T>() => T
}

const textDecoder = new TextDecoder()

const isAbort = (signal: AbortSignal | undefined) => Boolean(signal?.aborted)

/**
 * Reads a response body while resetting the stall timer on each chunk, so a
 * slow-but-alive download is never mistaken for a dead one.
 */
const readBodyWithStallTimeout = async (
  response: Response,
  stallTimeoutMs: number,
  onProgress: ((bytes: number) => void) | undefined,
  externalSignal: AbortSignal | undefined
): Promise<Uint8Array> => {
  if (!response.body) return new Uint8Array(await response.arrayBuffer())

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    while (true) {
      let stallTimer: ReturnType<typeof setTimeout> | undefined
      const stalled = new Promise<never>((_resolve, reject) => {
        stallTimer = setTimeout(
          () => reject(new HostRequestError('The connection stopped responding.', null, 'retry')),
          stallTimeoutMs
        )
      })

      try {
        const result = await Promise.race([reader.read(), stalled])
        if (result.done) break
        chunks.push(result.value)
        total += result.value.length
        onProgress?.(total)
        if (isAbort(externalSignal)) throw new HostRequestError('Cancelled.', null, 'fail')
      } finally {
        if (stallTimer) clearTimeout(stallTimer)
      }
    }
  } finally {
    reader.releaseLock()
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

export interface Transport {
  request(options: RequestOptions): Promise<HostResponse>
}

export const createTransport = (options: TransportOptions): Transport => {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const random = options.random ?? Math.random
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS

  const attemptOnce = async (request: RequestOptions): Promise<HostResponse> => {
    const headers: Record<string, string> = { ...request.headers }

    if (!request.anonymous && options.token) {
      const token = await options.token()
      if (token) headers.authorization = `Bearer ${token}`
    }
    if (request.json !== undefined) headers['content-type'] = 'application/json'

    // The stall timer covers the wait for response headers too, so a host that
    // accepts a connection and then goes silent is caught.
    const controller = new AbortController()
    const abortExternally = () => controller.abort()
    request.signal?.addEventListener('abort', abortExternally, { once: true })
    const headerTimer = setTimeout(() => controller.abort(), stallTimeoutMs)

    let response: Response
    try {
      response = await doFetch(`${options.hostUrl()}${request.path}`, {
        method: request.method,
        headers,
        body: request.json !== undefined ? JSON.stringify(request.json) : (request.body as BodyInit | undefined),
        signal: controller.signal,
      })
    } catch (error) {
      if (isAbort(request.signal)) throw new HostRequestError('Cancelled.', null, 'fail')
      throw new HostRequestError(
        error instanceof Error ? error.message : String(error),
        null,
        'retry'
      )
    } finally {
      clearTimeout(headerTimer)
      request.signal?.removeEventListener('abort', abortExternally)
    }

    const bytes =
      request.method === 'HEAD'
        ? new Uint8Array()
        : await readBodyWithStallTimeout(response, stallTimeoutMs, request.onProgress, request.signal)

    const parse = <T,>(): T => {
      if (bytes.length === 0) return {} as T
      try {
        return JSON.parse(textDecoder.decode(bytes)) as T
      } catch {
        throw new HostRequestError('The sync host returned a response oNami could not read.', response.status, 'retry')
      }
    }

    if (!response.ok) {
      let message = `The sync host returned HTTP ${response.status}.`
      let body: unknown
      try {
        body = parse<{ error?: string }>()
        if (body && typeof (body as { error?: string }).error === 'string') {
          message = (body as { error: string }).error
        }
      } catch {
        // A body that will not parse does not change how the status is handled.
      }
      throw new HostRequestError(message, response.status, classifyStatus(response.status), body)
    }

    return { status: response.status, headers: response.headers, bytes, json: parse }
  }

  const request = async (input: RequestOptions): Promise<HostResponse> => {
    const policy = { ...(options.retry ?? DEFAULT_RETRY_POLICY), ...input.retry }
    let attempt = 0

    while (true) {
      if (isAbort(input.signal)) throw new HostRequestError('Cancelled.', null, 'fail')

      try {
        return await attemptOnce(input)
      } catch (error) {
        const kind = classifyThrown(error)
        attempt += 1

        if (kind === 'fail' || !shouldRetry(attempt, policy) || isAbort(input.signal)) throw error

        const delayMs = nextBackoffMs(attempt, policy, random)
        options.onRetry?.({
          attempt,
          delayMs,
          reason: error instanceof Error ? error.message : String(error),
        })
        await sleep(delayMs)
      }
    }
  }

  return { request }
}
