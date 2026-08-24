import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppServices } from './appServices'
import { OnamiDatabase } from './database'

/**
 * A paired install with a few new cards. Pairing matters: the automatic sync
 * that follows a queued record is skipped outright on an unpaired device, so
 * without it there would be nothing to hold back.
 */
const createPairedServices = (cardCount: number) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onami-services-'))
  const database = new OnamiDatabase(path.join(dir, 'onami.sqlite'), path.join(dir, 'media'))
  database.setSettingsValue('sync.settings', {
    hostUrl: 'http://127.0.0.1:1',
    deviceId: 'device-1',
    deviceName: 'Test device',
    publicKey: null,
    privateKey: null,
    syncGroupId: 'group-1',
    deviceToken: null,
    deviceTokenExpiresAt: null,
    libraryQueued: true,
    syncRequested: false,
  })

  const services = new AppServices(database)
  const deck = services.createDeck({ name: 'Japanese' })
  for (let index = 0; index < cardCount; index += 1) {
    services.createCard({
      deckId: deck.id,
      noteType: 'basic',
      frontHtml: `front ${index}`,
      backHtml: `back ${index}`,
    })
  }

  return { services, database, deck, dir }
}

describe('AppServices study sessions and automatic sync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('holds the sync a session queues until the session ends', () => {
    const { services, database, deck, dir } = createPairedServices(3)

    try {
      const syncNow = vi.spyOn(services, 'syncNow').mockResolvedValue({
        pushedEvents: 0,
        pulledEvents: 0,
        appliedEvents: 0,
        pendingEvents: 0,
        lastHostCursor: 0,
        backedUpEvents: 0,
        lastBackedUpAt: null,
      })

      const session = services.startSession(deck.id, 'learn-new', { limit: 3, newEvery: 1 })
      expect(session.cards).toHaveLength(3)

      // Answering the first card queues its scheduling, which would otherwise
      // sync 500ms later - on top of the second card.
      services.answer({ sessionId: session.id, cardId: session.cards[0].id, rating: 'good' })
      vi.advanceTimersByTime(5_000)
      expect(syncNow).not.toHaveBeenCalled()

      // The session is still there, so the second card answers normally.
      expect(() =>
        services.answer({ sessionId: session.id, cardId: session.cards[1].id, rating: 'good' })
      ).not.toThrow()
      vi.advanceTimersByTime(5_000)
      expect(syncNow).not.toHaveBeenCalled()

      // Answering the last card ends the session, which releases the sync.
      const last = services.answer({
        sessionId: session.id,
        cardId: session.cards[2].id,
        rating: 'good',
      })
      expect(last.sessionComplete).toBe(true)
      vi.advanceTimersByTime(500)
      expect(syncNow).toHaveBeenCalledTimes(1)
    } finally {
      database.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('releases the held sync when the session is abandoned instead of finished', () => {
    const { services, database, deck, dir } = createPairedServices(3)

    try {
      const syncNow = vi.spyOn(services, 'syncNow').mockResolvedValue({
        pushedEvents: 0,
        pulledEvents: 0,
        appliedEvents: 0,
        pendingEvents: 0,
        lastHostCursor: 0,
        backedUpEvents: 0,
        lastBackedUpAt: null,
      })

      const session = services.startSession(deck.id, 'learn-new', { limit: 3, newEvery: 1 })
      services.answer({ sessionId: session.id, cardId: session.cards[0].id, rating: 'good' })
      vi.advanceTimersByTime(5_000)
      expect(syncNow).not.toHaveBeenCalled()

      services.endSession(session.id)
      vi.advanceTimersByTime(500)
      expect(syncNow).toHaveBeenCalledTimes(1)

      // Ending a session that is already gone is a no-op, not a second sync.
      services.endSession(session.id)
      vi.advanceTimersByTime(5_000)
      expect(syncNow).toHaveBeenCalledTimes(1)
    } finally {
      database.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
