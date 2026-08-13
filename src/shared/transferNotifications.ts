import type { TransferState } from './types'

export const isTerminalTransferState = (state: TransferState): boolean =>
  state === 'completed' || state === 'error'

/**
 * A terminal update may be enriched after completion (for example, with the
 * final sync result). Do not finish the same Android foreground service twice.
 */
export const shouldNotifyNativeTransfer = (previous: TransferState, next: TransferState): boolean =>
  !isTerminalTransferState(previous) || !isTerminalTransferState(next)
