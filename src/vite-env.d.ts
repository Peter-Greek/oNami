/// <reference types="vite/client" />

import type { OnamiApi } from './shared/types'

declare global {
  interface Window {
    onami: OnamiApi
  }
}
