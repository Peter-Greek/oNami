export const selectPairingSnapshotDirection = ({ mode, initiator, joiner }) => {
  if (!initiator || !joiner) {
    return { snapshotSourceDeviceId: null, snapshotTargetDeviceId: null }
  }

  let source = initiator
  let target = joiner
  const devices = [initiator, joiner]

  if (mode === 'copy-desktop-to-phone') {
    source = devices.find((device) => device.platform === 'desktop') ?? initiator
    target = source.id === initiator.id ? joiner : initiator
  } else if (mode === 'copy-phone-to-desktop') {
    source = devices.find((device) => device.platform === 'android') ?? initiator
    target = source.id === initiator.id ? joiner : initiator
  }

  return {
    snapshotSourceDeviceId: source.id,
    snapshotTargetDeviceId: target.id,
  }
}
