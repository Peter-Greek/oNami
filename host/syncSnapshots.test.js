import { describe, expect, it } from 'vitest'

import {
  canDeviceReceiveSnapshot,
  decodeSyncSnapshot,
  encodeSyncSnapshot,
  listAvailableSnapshotMedia,
} from './syncSnapshots.js'

describe('targeted sync snapshots', () => {
  it('round-trips snapshot content without exposing routing metadata', () => {
    const original = { version: 1, decks: [{ id: 'deck-1' }], cards: [], reviewLogs: [], media: [] }
    expect(decodeSyncSnapshot(encodeSyncSnapshot(original, 'phone-2', false))).toEqual({
      snapshot: original,
      targetDeviceId: 'phone-2',
      uploadComplete: false,
    })
  })

  it('treats legacy snapshots without transfer metadata as complete', () => {
    const original = { version: 1, decks: [], cards: [], reviewLogs: [], media: [] }
    expect(decodeSyncSnapshot(original)).toEqual({
      snapshot: original,
      targetDeviceId: null,
      uploadComplete: true,
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

  it('reports only manifest media that is already stored', () => {
    expect(
      listAvailableSnapshotMedia(
        [{ sha256: 'a' }, { sha256: 'b' }, { sha256: 'b' }, { sha256: 'c' }],
        ['b', 'c', 'unrelated']
      )
    ).toEqual(['b', 'c'])
  })
})
