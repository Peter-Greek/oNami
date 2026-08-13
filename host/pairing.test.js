import { describe, expect, it } from 'vitest'

import { selectPairingSnapshotDirection } from './pairing.js'

const desktop = { id: 'desktop-1', platform: 'desktop' }
const phone1 = { id: 'phone-1', platform: 'android' }
const phone2 = { id: 'phone-2', platform: 'android' }

describe('pairing snapshot direction', () => {
  it('uses the initiating phone as the source for phone-to-phone merge', () => {
    expect(
      selectPairingSnapshotDirection({ mode: 'merge', initiator: phone1, joiner: phone2 })
    ).toEqual({ snapshotSourceDeviceId: 'phone-1', snapshotTargetDeviceId: 'phone-2' })
  })

  it('preserves desktop-to-phone direction regardless of who started pairing', () => {
    expect(
      selectPairingSnapshotDirection({ mode: 'copy-desktop-to-phone', initiator: phone1, joiner: desktop })
    ).toEqual({ snapshotSourceDeviceId: 'desktop-1', snapshotTargetDeviceId: 'phone-1' })
  })

  it('preserves phone-to-desktop direction regardless of who started pairing', () => {
    expect(
      selectPairingSnapshotDirection({ mode: 'copy-phone-to-desktop', initiator: desktop, joiner: phone1 })
    ).toEqual({ snapshotSourceDeviceId: 'phone-1', snapshotTargetDeviceId: 'desktop-1' })
  })
})
