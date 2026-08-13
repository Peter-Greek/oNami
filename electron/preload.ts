import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type { OnamiApi, SyncProgressEvent, TransferProgressEvent } from '../src/shared/types'

const api: OnamiApi = {
  decks: {
    create: (input) => ipcRenderer.invoke('decks:create', input),
    delete: (deckId) => ipcRenderer.invoke('decks:delete', deckId),
    resetScheduling: (deckId) => ipcRenderer.invoke('decks:reset-scheduling', deckId),
    list: () => ipcRenderer.invoke('decks:list'),
    get: (deckId) => ipcRenderer.invoke('decks:get', deckId),
    selectApkg: () => ipcRenderer.invoke('decks:select-apkg'),
    importApkg: (filePath, options) => ipcRenderer.invoke('decks:import-apkg', filePath, options),
  },
  globalDecks: {
    list: (search) => ipcRenderer.invoke('global-decks:list', search),
    publish: (localDeckId) => ipcRenderer.invoke('global-decks:publish', localDeckId),
    heart: (globalDeckId, hearted) => ipcRenderer.invoke('global-decks:heart', globalDeckId, hearted),
    addToLibrary: (globalDeckId) => ipcRenderer.invoke('global-decks:add-to-library', globalDeckId),
  },
  cards: {
    create: (input) => ipcRenderer.invoke('cards:create', input),
    update: (input) => ipcRenderer.invoke('cards:update', input),
    delete: (cardId) => ipcRenderer.invoke('cards:delete', cardId),
  },
  study: {
    startSession: (deckId, mode, settings) =>
      ipcRenderer.invoke('study:start-session', deckId, mode, settings),
    answer: (input) => ipcRenderer.invoke('study:answer', input),
  },
  ai: {
    getSettings: () => ipcRenderer.invoke('ai:get-settings'),
    saveSettings: (input) => ipcRenderer.invoke('ai:save-settings', input),
    generateCards: (input, options) => ipcRenderer.invoke('ai:generate-cards', input, options),
  },
  stats: {
    get: (filter) => ipcRenderer.invoke('stats:get', filter),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (input) => ipcRenderer.invoke('settings:save', input),
  },
  sync: {
    getStatus: () => ipcRenderer.invoke('sync:get-status'),
    saveSettings: (input) => ipcRenderer.invoke('sync:save-settings', input),
    checkHealth: () => ipcRenderer.invoke('sync:check-health'),
    startPairing: () => ipcRenderer.invoke('sync:start-pairing'),
    joinPairing: (input) => ipcRenderer.invoke('sync:join-pairing', input),
    confirmPairing: (input) => ipcRenderer.invoke('sync:confirm-pairing', input),
    syncNow: (options) => ipcRenderer.invoke('sync:sync-now', options),
    onProgress: (listener) => {
      const wrapped = (_event: IpcRendererEvent, progress: SyncProgressEvent) => listener(progress)
      ipcRenderer.on('sync:progress', wrapped)
      return () => {
        ipcRenderer.removeListener('sync:progress', wrapped)
      }
    },
  },
  transfers: {
    getStatus: () => ipcRenderer.invoke('transfers:get-status'),
    onProgress: (listener) => {
      const wrapped = (_event: IpcRendererEvent, progress: TransferProgressEvent) => listener(progress)
      ipcRenderer.on('transfers:progress', wrapped)
      return () => {
        ipcRenderer.removeListener('transfers:progress', wrapped)
      }
    },
  },
  appWindow: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    close: () => ipcRenderer.invoke('window:close'),
    openDevTools: () => ipcRenderer.invoke('window:open-devtools'),
    onMaximizedChanged: (listener) => {
      const wrapped = (_event: IpcRendererEvent, isMaximized: boolean) => listener(isMaximized)
      ipcRenderer.on('window:maximized-changed', wrapped)
      return () => {
        ipcRenderer.removeListener('window:maximized-changed', wrapped)
      }
    },
  },
}

contextBridge.exposeInMainWorld('onami', api)
