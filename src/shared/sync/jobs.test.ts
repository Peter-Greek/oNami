import { describe, expect, it } from 'vitest'

import {
  type JobRecord,
  advance,
  createJob,
  describeJob,
  formatBytes,
  isRunnable,
  markCompleted,
  markFailed,
  markQueued,
  markRunning,
  markWaiting,
  pruneJobs,
  reviveInterrupted,
  selectRunnable,
} from './jobs'
import { DEFAULT_RETRY_POLICY } from './transport'

const at = (iso: string) => new Date(iso)
const T0 = at('2026-08-15T12:00:00.000Z')

const job = (overrides: Partial<JobRecord> = {}): JobRecord => ({
  ...createJob(
    {
      id: 'job-1',
      kind: 'blob-upload',
      targetId: 'sha-1',
      targetName: 'genki-01.mp3',
      total: 1000,
      unit: 'bytes',
    },
    T0
  ),
  ...overrides,
})

describe('createJob', () => {
  it('starts queued with an empty cursor and no attempts', () => {
    expect(job()).toMatchObject({ state: 'queued', cursor: {}, attempts: 0, nextAttemptAt: null })
  })
})

describe('advance', () => {
  it('records the cursor so a later attempt continues from it', () => {
    const next = advance(job(), { cursor: { offset: 400 }, current: 400 }, T0)

    expect(next.cursor).toEqual({ offset: 400 })
    expect(next.progress.current).toBe(400)
  })

  it('merges into the existing cursor rather than replacing it', () => {
    const started = advance(job(), { cursor: { sha256: 'abc', offset: 100 } }, T0)
    expect(advance(started, { cursor: { offset: 300 } }, T0).cursor).toEqual({ sha256: 'abc', offset: 300 })
  })

  it('never lets progress go backwards', () => {
    const ahead = advance(job(), { current: 800 }, T0)
    expect(advance(ahead, { current: 200 }, T0).progress.current).toBe(800)
  })

  it('never lets progress exceed the total', () => {
    expect(advance(job(), { current: 5000 }, T0).progress.current).toBe(1000)
  })
})

describe('markWaiting', () => {
  it('keeps the cursor and schedules its own continuation', () => {
    const working = advance(markRunning(job(), T0), { cursor: { offset: 640 }, current: 640 }, T0)

    const waiting = markWaiting(working, 'The connection stopped responding.', T0, DEFAULT_RETRY_POLICY, () => 0)

    expect(waiting.state).toBe('waiting')
    expect(waiting.cursor).toEqual({ offset: 640 })
    expect(waiting.progress.current).toBe(640)
    expect(waiting.attempts).toBe(1)
    expect(waiting.nextAttemptAt).toBe('2026-08-15T12:00:01.000Z')
  })

  it('backs off further on each successive interruption', () => {
    let current = job()
    const delays: string[] = []
    for (let index = 0; index < 3; index += 1) {
      current = markWaiting(current, 'offline', T0, DEFAULT_RETRY_POLICY, () => 0)
      delays.push(current.nextAttemptAt as string)
    }

    expect(delays).toEqual([
      '2026-08-15T12:00:01.000Z',
      '2026-08-15T12:00:02.000Z',
      '2026-08-15T12:00:04.000Z',
    ])
  })

  it('gives up only when a retry ceiling says so', () => {
    const policy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 2 }
    const once = markWaiting(job(), 'offline', T0, policy, () => 0)
    const twice = markWaiting(once, 'offline', T0, policy, () => 0)

    expect(once.state).toBe('waiting')
    expect(twice.state).toBe('failed')
    expect(twice.lastError).toBe('offline')
  })
})

describe('isRunnable', () => {
  it('runs a queued job immediately', () => {
    expect(isRunnable(job(), T0)).toBe(true)
  })

  it('holds a waiting job until its backoff has elapsed', () => {
    const waiting = markWaiting(job(), 'offline', T0, DEFAULT_RETRY_POLICY, () => 0)

    expect(isRunnable(waiting, T0)).toBe(false)
    expect(isRunnable(waiting, at('2026-08-15T12:00:01.000Z'))).toBe(true)
  })

  it('never re-runs a finished job', () => {
    expect(isRunnable(markCompleted(job(), null, T0), T0)).toBe(false)
    expect(isRunnable(markFailed(job(), 'nope', T0), T0)).toBe(false)
  })
})

describe('selectRunnable', () => {
  const blob = (id: string, createdAt: string, state: JobRecord['state'] = 'queued') =>
    job({ id, targetId: id, createdAt, state })

  it('starts the oldest jobs first', () => {
    const selected = selectRunnable(
      [blob('c', '2026-08-15T12:00:03.000Z'), blob('a', '2026-08-15T12:00:01.000Z'), blob('b', '2026-08-15T12:00:02.000Z')],
      T0
    )

    expect(selected.map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('respects the per-kind limit and counts what is already running', () => {
    const jobs = [
      ...Array.from({ length: 4 }, (_value, index) => blob(`running-${index}`, `2026-08-15T12:00:0${index}.000Z`, 'running')),
      ...Array.from({ length: 5 }, (_value, index) => blob(`queued-${index}`, `2026-08-15T12:01:0${index}.000Z`)),
    ]

    // Six upload slots, four already occupied, so two more may start.
    expect(selectRunnable(jobs, T0).map((item) => item.id)).toEqual(['queued-0', 'queued-1'])
  })

  it('never runs two syncs at once', () => {
    const jobs = [
      job({ id: 'sync-a', kind: 'sync', createdAt: '2026-08-15T12:00:01.000Z' }),
      job({ id: 'sync-b', kind: 'sync', createdAt: '2026-08-15T12:00:02.000Z' }),
    ]

    expect(selectRunnable(jobs, T0).map((item) => item.id)).toEqual(['sync-a'])
  })

  it('leaves a backing-off job alone', () => {
    const waiting = markWaiting(blob('a', '2026-08-15T12:00:01.000Z'), 'offline', T0, DEFAULT_RETRY_POLICY, () => 0)
    expect(selectRunnable([waiting], T0)).toEqual([])
  })
})

describe('reviveInterrupted', () => {
  it('re-queues a job the app died in the middle of, keeping its cursor', () => {
    const interrupted = advance(markRunning(job(), T0), { cursor: { offset: 512 }, current: 512 }, T0)

    const [revived] = reviveInterrupted([interrupted], T0)

    expect(revived.state).toBe('queued')
    expect(revived.cursor).toEqual({ offset: 512 })
    expect(revived.progress.current).toBe(512)
  })

  it('leaves finished jobs alone', () => {
    const done = markCompleted(job(), null, T0)
    expect(reviveInterrupted([done], T0)[0].state).toBe('completed')
  })
})

describe('markQueued', () => {
  it('clears the backoff so a user-driven retry is immediate', () => {
    const waiting = markWaiting(job(), 'offline', T0, DEFAULT_RETRY_POLICY, () => 0)
    const resumed = markQueued(waiting, T0)

    expect(resumed).toMatchObject({ state: 'queued', attempts: 0, nextAttemptAt: null })
    expect(isRunnable(resumed, T0)).toBe(true)
  })
})

describe('pruneJobs', () => {
  it('keeps every unfinished job and trims the finished history', () => {
    const active = Array.from({ length: 20 }, (_value, index) =>
      job({ id: `active-${index}`, updatedAt: `2026-08-15T12:00:${String(index).padStart(2, '0')}.000Z` })
    )
    const finished = Array.from({ length: 20 }, (_value, index) =>
      markCompleted(job({ id: `done-${index}`, updatedAt: `2026-08-15T13:00:${String(index).padStart(2, '0')}.000Z` }), null, T0)
    )

    const pruned = pruneJobs([...active, ...finished], 5)

    expect(pruned.filter((item) => item.state === 'queued')).toHaveLength(20)
    expect(pruned.filter((item) => item.state === 'completed')).toHaveLength(5)
  })
})

describe('formatBytes', () => {
  it('reads the way a person would say it', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(900)).toBe('900 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(64 * 1024 * 1024)).toBe('64.0 MB')
  })
})

describe('describeJob', () => {
  it('tells an interrupted transfer it kept its progress', () => {
    const working = advance(markRunning(job(), T0), { current: 640 }, T0)
    const waiting = markWaiting(working, 'The connection stopped responding.', T0)

    expect(describeJob(waiting)).toEqual({
      title: 'Uploading genki-01.mp3',
      detail: 'Interrupted — 640 B of 1000 B kept. Continuing automatically.',
      automatic: true,
    })
  })

  it('never describes an automatic continuation as an error', () => {
    const waiting = markWaiting(job(), 'Failed to fetch', T0)
    const description = describeJob(waiting)

    expect(description.automatic).toBe(true)
    expect(description.detail).not.toMatch(/error|fail|reset|restart/i)
  })

  it('says plainly when something needs attention', () => {
    expect(describeJob(markFailed(job(), 'That deck is no longer available.', T0))).toMatchObject({
      detail: 'Stopped: That deck is no longer available.',
      automatic: false,
    })
  })

  it('counts items for record work and bytes for file work', () => {
    const records = advance(
      markRunning(job({ kind: 'sync', targetName: 'oNami', progress: { current: 0, total: 2100, unit: 'items', message: '' } }), T0),
      { current: 340 },
      T0
    )

    expect(describeJob(records)).toMatchObject({ title: 'Syncing your library', detail: '340 of 2,100.' })
  })
})
