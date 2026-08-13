const TARGET_DEVICE_FIELD = '__onamiTargetDeviceId'

export const encodeSyncSnapshot = (snapshot, targetDeviceId) => ({
  ...snapshot,
  [TARGET_DEVICE_FIELD]: targetDeviceId ?? null,
})

export const decodeSyncSnapshot = (payload) => {
  const snapshot = { ...payload }
  const rawTargetDeviceId = snapshot[TARGET_DEVICE_FIELD]
  delete snapshot[TARGET_DEVICE_FIELD]
  return {
    snapshot,
    targetDeviceId: typeof rawTargetDeviceId === 'string' ? rawTargetDeviceId : null,
  }
}

export const canDeviceReceiveSnapshot = ({ sourceDeviceId, targetDeviceId, deviceId }) =>
  sourceDeviceId !== deviceId && (!targetDeviceId || targetDeviceId === deviceId)
