/**
 * The durable transfer queue.
 *
 * The previous design stored a transfer as a status label. "Resuming" it meant
 * setting that label back to queued and calling the same function again, which
 * started from step one — so an interruption at file 770 of 778 cost all 770.
 *
 * Here every job carries a **cursor**: the byte offset reached, the page
 * applied, the index installed. Resuming means reading the cursor and
 * continuing from it. Nothing restarts.
 *
 * This module is pure. Persistence is a port (`JobStore`) so the desktop can
 * keep jobs in SQLite and the Android build in IndexedDB while sharing one
 * state machine and one set of tests.
 */

import { DEFAULT_RETRY_POLICY, type RetryPolicy, nextBackoffMs, shouldRetry } from './transport'

export type JobKind = 'blob-upload' | 'blob-download' | 'deck-publish' | 'deck-install' | 'sync'

export type JobState =
  /** Ready to run as soon as a slot frees up. */
  | 'queued'
  /** Running now. */
  | 'running'
  /** Interrupted by something retryable; will resume itself at `nextAttemptAt`. */
  | 'waiting'
  | 'completed'
  /** Stopped for a reason retrying cannot fix. Needs the user or a new version. */
  | 'failed'

export type ProgressUnit = 'bytes' | 'items'

export interface JobProgress {
  current: number
  total: number
  unit: ProgressUnit
  message: string
}

export interface JobRecord {
  id: string
  kind: JobKind
  targetId: string
  targetName: string
  state: JobState
  /** Where to continue from. The whole point of the queue. */
  cursor: Record<string, unknown>
  progress: JobProgress
  attempts: number
  nextAttemptAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
  result?: unknown
}

export interface JobStore {
  list(): Promise<JobRecord[]>
  save(job: JobRecord): Promise<void>
  remove(id: string): Promise<void>
}

/** How many of each kind may run at once. Blobs parallelise; sync must not. */
export const JOB_CONCURRENCY: Record<JobKind, number> = {
  'blob-upload': 6,
  'blob-download': 6,
  'deck-publish': 1,
  'deck-install': 1,
  sync: 1,
}

export const isTerminal = (state: JobState): boolean => state === 'completed' || state === 'failed'

export const isActive = (job: JobRecord): boolean => !isTerminal(job.state)

const emptyProgress = (unit: ProgressUnit, message: string): JobProgress => ({
  current: 0,
  total: 0,
  unit,
  message,
})

export interface CreateJobInput {
  id: string
  kind: JobKind
  targetId: string
  targetName: string
  cursor?: Record<string, unknown>
  total?: number
  unit?: ProgressUnit
  message?: string
}

export const createJob = (input: CreateJobInput, now: Date = new Date()): JobRecord => {
  const timestamp = now.toISOString()
  return {
    id: input.id,
    kind: input.kind,
    targetId: input.targetId,
    targetName: input.targetName,
    state: 'queued',
    cursor: input.cursor ?? {},
    progress: {
      ...emptyProgress(input.unit ?? 'items', input.message ?? 'Waiting to start.'),
      total: input.total ?? 0,
    },
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

export const markRunning = (job: JobRecord, now: Date = new Date()): JobRecord => ({
  ...job,
  state: 'running',
  nextAttemptAt: null,
  updatedAt: now.toISOString(),
})

/**
 * Records forward movement. Progress is clamped so it can never go backwards:
 * a resumed job that re-reads its offset must not appear to lose ground, which
 * is the single most confusing thing a progress bar can do.
 */
export const advance = (
  job: JobRecord,
  update: { cursor?: Record<string, unknown>; current?: number; total?: number; message?: string },
  now: Date = new Date()
): JobRecord => {
  const total = update.total ?? job.progress.total
  const current = Math.min(
    Math.max(update.current ?? job.progress.current, job.progress.current),
    total > 0 ? total : Number.MAX_SAFE_INTEGER
  )

  return {
    ...job,
    cursor: update.cursor ? { ...job.cursor, ...update.cursor } : job.cursor,
    progress: {
      ...job.progress,
      current,
      total,
      message: update.message ?? job.progress.message,
    },
    updatedAt: now.toISOString(),
  }
}

/**
 * Parks a job after a retryable interruption. The cursor is untouched, so the
 * next attempt continues rather than restarting.
 */
export const markWaiting = (
  job: JobRecord,
  error: string,
  now: Date = new Date(),
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random
): JobRecord => {
  const attempts = job.attempts + 1

  if (!shouldRetry(attempts, policy)) return markFailed(job, error, now)

  const delayMs = nextBackoffMs(attempts, policy, random)
  return {
    ...job,
    state: 'waiting',
    attempts,
    nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
    lastError: error,
    updatedAt: now.toISOString(),
  }
}

export const markCompleted = (job: JobRecord, result: unknown, now: Date = new Date()): JobRecord => ({
  ...job,
  state: 'completed',
  nextAttemptAt: null,
  lastError: null,
  progress: {
    ...job.progress,
    current: job.progress.total > 0 ? job.progress.total : job.progress.current,
    message: 'Finished.',
  },
  result,
  updatedAt: now.toISOString(),
})

export const markFailed = (job: JobRecord, error: string, now: Date = new Date()): JobRecord => ({
  ...job,
  state: 'failed',
  nextAttemptAt: null,
  lastError: error,
  updatedAt: now.toISOString(),
})

/** A job the user explicitly paused stays put until they resume it. */
export const markQueued = (job: JobRecord, now: Date = new Date()): JobRecord => ({
  ...job,
  state: 'queued',
  attempts: 0,
  nextAttemptAt: null,
  updatedAt: now.toISOString(),
})

export const isRunnable = (job: JobRecord, now: Date = new Date()): boolean => {
  if (job.state === 'queued') return true
  if (job.state !== 'waiting') return false
  return !job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= now.getTime()
}

/**
 * Picks what to start next, oldest first, respecting the per-kind limit and
 * counting jobs already running against it.
 */
export const selectRunnable = (
  jobs: JobRecord[],
  now: Date = new Date(),
  concurrency: Record<JobKind, number> = JOB_CONCURRENCY
): JobRecord[] => {
  const running = new Map<JobKind, number>()
  for (const job of jobs) {
    if (job.state === 'running') running.set(job.kind, (running.get(job.kind) ?? 0) + 1)
  }

  const selected: JobRecord[] = []
  for (const job of [...jobs].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    if (!isRunnable(job, now)) continue
    const inFlight = running.get(job.kind) ?? 0
    if (inFlight >= concurrency[job.kind]) continue
    running.set(job.kind, inFlight + 1)
    selected.push(job)
  }
  return selected
}

/**
 * Restores jobs left mid-flight by a crash or a force-stop. A job recorded as
 * `running` has no process behind it after a restart, so it goes back in the
 * queue — keeping its cursor, which is what makes the restart cheap.
 */
export const reviveInterrupted = (jobs: JobRecord[], now: Date = new Date()): JobRecord[] =>
  jobs.map((job) =>
    job.state === 'running'
      ? { ...job, state: 'queued' as const, nextAttemptAt: null, updatedAt: now.toISOString() }
      : job
  )

/** Keeps every unfinished job, and only the most recent finished ones. */
export const pruneJobs = (jobs: JobRecord[], keepFinished = 12): JobRecord[] => {
  const active = jobs.filter(isActive)
  const finished = jobs
    .filter((job) => isTerminal(job.state))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, keepFinished)
  return [...active, ...finished]
}

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

const formatCount = (progress: JobProgress): string =>
  progress.unit === 'bytes'
    ? `${formatBytes(progress.current)} of ${formatBytes(progress.total)}`
    : `${progress.current.toLocaleString()} of ${progress.total.toLocaleString()}`

const jobNoun = (kind: JobKind): string => {
  switch (kind) {
    case 'blob-upload':
    case 'deck-publish':
      return 'Uploading'
    case 'blob-download':
    case 'deck-install':
      return 'Downloading'
    case 'sync':
      return 'Syncing'
  }
}

export interface JobDescription {
  title: string
  detail: string
  /** True when the job continues on its own and the user need do nothing. */
  automatic: boolean
}

/**
 * The sentence the user reads.
 *
 * A waiting job must never read as a failure, because it is not one: the cursor
 * is intact and it will continue by itself. The old UI said things like
 * "Sync will resume next time oNami opens" next to a state it then reset, which
 * is why interruptions felt like data loss.
 */
export const describeJob = (job: JobRecord): JobDescription => {
  const title = job.kind === 'sync' ? 'Syncing your library' : `${jobNoun(job.kind)} ${job.targetName}`
  const hasProgress = job.progress.total > 0
  const done = hasProgress ? formatCount(job.progress) : null

  switch (job.state) {
    case 'queued':
      return { title, detail: done ? `Waiting to continue — ${done} done.` : 'Waiting to start.', automatic: true }
    case 'running':
      return { title, detail: done ? `${done}.` : job.progress.message, automatic: true }
    case 'waiting':
      return {
        title,
        detail: done
          ? `Interrupted — ${done} kept. Continuing automatically.`
          : 'Interrupted. Continuing automatically.',
        automatic: true,
      }
    case 'completed':
      return { title, detail: 'Finished.', automatic: false }
    case 'failed':
      return {
        title,
        detail: job.lastError ? `Stopped: ${job.lastError}` : 'Stopped.',
        automatic: false,
      }
  }
}
