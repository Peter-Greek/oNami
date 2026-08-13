import { describe, expect, it } from 'vitest'

import { shouldNotifyNativeTransfer } from './transferNotifications'

describe('transfer notifications', () => {
  it('notifies Android when a transfer first completes', () => {
    expect(shouldNotifyNativeTransfer('running', 'completed')).toBe(true)
  })

  it('does not finish the Android foreground service twice', () => {
    expect(shouldNotifyNativeTransfer('completed', 'completed')).toBe(false)
    expect(shouldNotifyNativeTransfer('error', 'error')).toBe(false)
    expect(shouldNotifyNativeTransfer('completed', 'error')).toBe(false)
  })

  it('continues to publish live progress updates', () => {
    expect(shouldNotifyNativeTransfer('queued', 'running')).toBe(true)
    expect(shouldNotifyNativeTransfer('running', 'running')).toBe(true)
    expect(shouldNotifyNativeTransfer('running', 'paused')).toBe(true)
  })
})
