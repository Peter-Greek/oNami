/**
 * A `JobStore` over any key/value slot that can hold JSON.
 *
 * Both platforms already have one — the desktop's `settings` table and the
 * browser's localStorage — so neither needs its own queue implementation, and
 * the durability rules live in one tested place.
 */

import { type JobRecord, type JobStore, pruneJobs } from './jobs'

export interface JsonSlot {
  read(): Promise<unknown> | unknown
  write(value: unknown): Promise<void> | void
}

const isJobRecord = (value: unknown): value is JobRecord => {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<JobRecord>
  return (
    typeof row.id === 'string' &&
    typeof row.kind === 'string' &&
    typeof row.state === 'string' &&
    typeof row.createdAt === 'string' &&
    typeof row.updatedAt === 'string' &&
    typeof row.cursor === 'object' &&
    row.cursor !== null
  )
}

/**
 * Drops anything unreadable rather than throwing. A corrupt entry must not be
 * able to stop every other transfer from resuming.
 */
export const parseJobs = (raw: unknown): JobRecord[] => {
  if (!Array.isArray(raw)) return []
  return raw.filter(isJobRecord).map((job) => ({
    ...job,
    attempts: Number.isInteger(job.attempts) ? job.attempts : 0,
    progress: {
      current: Number.isFinite(job.progress?.current) ? job.progress.current : 0,
      total: Number.isFinite(job.progress?.total) ? job.progress.total : 0,
      unit: job.progress?.unit === 'bytes' ? 'bytes' : 'items',
      message: typeof job.progress?.message === 'string' ? job.progress.message : '',
    },
  }))
}

export const createJsonJobStore = (slot: JsonSlot, keepFinished = 12): JobStore => ({
  list: async () => parseJobs(await slot.read()),

  save: async (job) => {
    const jobs = parseJobs(await slot.read())
    const index = jobs.findIndex((candidate) => candidate.id === job.id)
    if (index >= 0) jobs[index] = job
    else jobs.push(job)
    await slot.write(pruneJobs(jobs, keepFinished))
  },

  remove: async (id) => {
    const jobs = parseJobs(await slot.read())
    await slot.write(jobs.filter((job) => job.id !== id))
  },
})
