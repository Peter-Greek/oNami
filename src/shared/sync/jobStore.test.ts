import { describe, expect, it } from 'vitest'

import { createJob, markCompleted } from './jobs'
import { createJsonJobStore, parseJobs } from './jobStore'

const T0 = new Date('2026-08-15T12:00:00.000Z')

const memorySlot = (initial: unknown = []) => {
  let value = initial
  return {
    read: () => value,
    write: (next: unknown) => {
      value = next
    },
    peek: () => value,
  }
}

const sample = (id = 'job-1') =>
  createJob({ id, kind: 'blob-upload', targetId: 'sha', targetName: 'clip.mp3' }, T0)

describe('parseJobs', () => {
  it('returns nothing for a slot that never held jobs', () => {
    expect(parseJobs(null)).toEqual([])
    expect(parseJobs('not json')).toEqual([])
    expect(parseJobs({})).toEqual([])
  })

  it('drops corrupt entries but keeps the readable ones', () => {
    const parsed = parseJobs([sample('good'), { id: 'bad' }, null, 42])

    expect(parsed.map((job) => job.id)).toEqual(['good'])
  })

  it('repairs a job whose progress went missing', () => {
    const damaged = { ...sample(), progress: undefined, attempts: 'lots' }

    expect(parseJobs([damaged])[0]).toMatchObject({
      attempts: 0,
      progress: { current: 0, total: 0, unit: 'items', message: '' },
    })
  })
})

describe('createJsonJobStore', () => {
  it('adds a job and reads it back', async () => {
    const slot = memorySlot()
    const store = createJsonJobStore(slot)

    await store.save(sample())

    expect((await store.list()).map((job) => job.id)).toEqual(['job-1'])
  })

  it('replaces a job in place rather than appending a duplicate', async () => {
    const slot = memorySlot()
    const store = createJsonJobStore(slot)
    await store.save(sample())

    await store.save(markCompleted(sample(), null, T0))

    const jobs = await store.list()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].state).toBe('completed')
  })

  it('removes a job', async () => {
    const slot = memorySlot()
    const store = createJsonJobStore(slot)
    await store.save(sample('a'))
    await store.save(sample('b'))

    await store.remove('a')

    expect((await store.list()).map((job) => job.id)).toEqual(['b'])
  })

  it('keeps every unfinished job while trimming finished history', async () => {
    const slot = memorySlot()
    const store = createJsonJobStore(slot, 2)

    for (let index = 0; index < 5; index += 1) {
      await store.save({
        ...markCompleted(sample(`done-${index}`), null, T0),
        updatedAt: `2026-08-15T12:0${index}:00.000Z`,
      })
    }
    await store.save(sample('pending'))

    const jobs = await store.list()
    expect(jobs.filter((job) => job.state === 'queued').map((job) => job.id)).toEqual(['pending'])
    expect(jobs.filter((job) => job.state === 'completed')).toHaveLength(2)
  })
})
