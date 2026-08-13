/// <reference types="vite/client" />

import type { OnamiApi } from './shared/types'

declare global {
  interface Window {
    onami: OnamiApi
    onamiAndroid?: {
      setKeepScreenAwake(enabled: boolean): void
      setSystemBarTheme(dark: boolean): void
      updateTransfer(id: string, title: string, message: string, current: number, total: number): void
      pauseTransfer(id: string, title: string, message: string): void
      finishTransfer(id: string, title: string, message: string, succeeded: boolean, hasMore: boolean): void
    }
  }
}
