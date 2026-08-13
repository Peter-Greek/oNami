import { describe, expect, it } from 'vitest'

import {
  canDeviceReceiveSnapshot,
  decodeSyncSnapshot,
  encodeSyncSnapshot,
} from './syncSnapshots.js'

describe('targeted sync snapshots', () => {
  it('round-trips snapshot content without exposing routing metadata', () => {
    const original = { version: 1, decks: [{ id: 'deck-1' }], cards: [], reviewLogs: [], media: [] }
    expect(decodeSyncSnapshot(encodeSyncSnapshot(original, 'phone-2'))).toEqual({
      snapshot: original,
      targetDeviceId: 'phone-2',
    })
  })

  it('only lets the intended new phone consume a targeted snapshot', () => {
    const route = { sourceDeviceId: 'phone-1', targetDeviceId: 'phone-2' }
    expect(canDeviceReceiveSnapshot({ ...route, deviceId: 'phone-1' })).toBe(false)
    expect(canDeviceReceiveSnapshot({ ...route, deviceId: 'phone-2' })).toBe(true)
    expect(canDeviceReceiveSnapshot({ ...route, deviceId: 'phone-3' })).toBe(false)
  })

  it('keeps legacy untargeted snapshots compatible with non-source devices', () => {
    expect(
      canDeviceReceiveSnapshot({ sourceDeviceId: 'desktop-1', targetDeviceId: null, deviceId: 'phone-1' })
    ).toBe(true)
  })
})
