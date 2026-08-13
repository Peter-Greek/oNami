import type { SyncConfirmPairingResult } from './types'

export interface PairingSnapshotPlan {
  uploadTargetDeviceId: string | null
  downloadPending: boolean
}

export const getPairingSnapshotPlan = (
  result: SyncConfirmPairingResult,
  deviceId: string
): PairingSnapshotPlan => {
  if (!result.completed || !result.snapshotSourceDeviceId || !result.snapshotTargetDeviceId) {
    return { uploadTargetDeviceId: null, downloadPending: false }
  }

  if (result.snapshotSourceDeviceId === deviceId) {
    return { uploadTargetDeviceId: result.snapshotTargetDeviceId, downloadPending: false }
  }

  return {
    uploadTargetDeviceId: null,
    downloadPending: result.snapshotTargetDeviceId === deviceId,
  }
}
