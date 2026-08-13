const TARGET_DEVICE_FIELD = '__onamiTargetDeviceId'
const UPLOAD_COMPLETE_FIELD = '__onamiUploadComplete'

export const encodeSyncSnapshot = (snapshot, targetDeviceId, uploadComplete = true) => ({
  ...snapshot,
  [TARGET_DEVICE_FIELD]: targetDeviceId ?? null,
  [UPLOAD_COMPLETE_FIELD]: uploadComplete,
})

export const decodeSyncSnapshot = (payload) => {
  const snapshot = { ...payload }
  const rawTargetDeviceId = snapshot[TARGET_DEVICE_FIELD]
  const hasUploadComplete = Object.prototype.hasOwnProperty.call(snapshot, UPLOAD_COMPLETE_FIELD)
  const rawUploadComplete = snapshot[UPLOAD_COMPLETE_FIELD]
  delete snapshot[TARGET_DEVICE_FIELD]
  delete snapshot[UPLOAD_COMPLETE_FIELD]
  return {
    snapshot,
    targetDeviceId: typeof rawTargetDeviceId === 'string' ? rawTargetDeviceId : null,
    // Legacy snapshots were only published after every media blob was uploaded.
    uploadComplete: hasUploadComplete ? rawUploadComplete === true : true,
  }
}

export const canDeviceReceiveSnapshot = ({ sourceDeviceId, targetDeviceId, deviceId }) =>
  sourceDeviceId !== deviceId && (!targetDeviceId || targetDeviceId === deviceId)

export const listAvailableSnapshotMedia = (snapshotMedia, storedSha256) => {
  const stored = new Set(storedSha256)
  return [...new Set(snapshotMedia.map((item) => item?.sha256))]
    .filter((sha256) => typeof sha256 === 'string' && stored.has(sha256))
}
