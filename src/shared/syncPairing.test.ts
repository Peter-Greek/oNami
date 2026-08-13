import { describe, expect, it } from 'vitest'

import { getPairingSnapshotPlan } from './syncPairing'

const completedPairing = {
  completed: true,
  syncGroupId: 'group-1',
  mode: 'merge' as const,
  snapshotSourceDeviceId: 'phone-1',
  snapshotTargetDeviceId: 'phone-2',
}

describe('pairing snapshot plans', () => {
  it('makes the source upload a full snapshot for the joining phone', () => {
    expect(getPairingSnapshotPlan(completedPairing, 'phone-1')).toEqual({
      uploadTargetDeviceId: 'phone-2',
      downloadPending: false,
    })
  })

  it('keeps the joining phone waiting for the complete snapshot', () => {
    expect(getPairingSnapshotPlan(completedPairing, 'phone-2')).toEqual({
      uploadTargetDeviceId: null,
      downloadPending: true,
    })
  })

  it('does nothing until both devices have confirmed', () => {
    expect(
      getPairingSnapshotPlan(
        { ...completedPairing, completed: false, syncGroupId: null },
        'phone-1'
      )
    ).toEqual({ uploadTargetDeviceId: null, downloadPending: false })
  })
})
