import path from 'node:path'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { app, BrowserWindow, dialog, ipcMain, Menu, net, Notification, protocol, type OpenDialogOptions } from 'electron'

import type {
  AiGenerationOptions,
  AnswerInput,
  CreateCardInput,
  CreateDeckInput,
  ImportApkgOptions,
  SaveAppSettingsInput,
  SaveAiSettingsInput,
  SaveSyncSettingsInput,
  StatsFilterInput,
  StudyMode,
  StudySessionSettings,
  SyncConfirmPairingInput,
  SyncJoinPairingInput,
  SyncRunOptions,
  TransferProgressEvent,
  UpdateCardInput,
} from '../src/shared/types'
import type { AppServices } from './domain/appServices'

let mainWindow: BrowserWindow | null = null
let services: AppServices | null = null
const activeTransferIds = new Set<string>()
let quitAfterTransfers = false
let logFilePath = path.join(os.tmpdir(), 'onami-startup.log')

const log = (message: string, error?: unknown): void => {
  const line = `[${new Date().toISOString()}] ${message}${
    error instanceof Error ? `\n${error.stack ?? error.message}` : error ? `\n${String(error)}` : ''
  }\n`
  try {
    if (logFilePath) fs.appendFileSync(logFilePath, line)
  } catch {
    // Logging must never make startup worse.
  }
}

const getServices = (): AppServices => {
  if (!services) throw new Error('Application services are not ready.')
  return services
}

const showTransferNotification = (event: TransferProgressEvent): void => {
  if (event.kind === 'sync' || !Notification.isSupported()) return
  if (event.state !== 'queued' && event.state !== 'completed' && event.state !== 'paused' && event.state !== 'error') {
    return
  }
  new Notification({
    title: event.title,
    body: event.message,
    icon: path.join(__dirname, '../build/icon.png'),
    silent: event.state === 'queued',
  }).show()
}

const handleTransferProgress = (event: TransferProgressEvent): void => {
  if (event.state === 'queued' || event.state === 'running') activeTransferIds.add(event.id)
  else activeTransferIds.delete(event.id)

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send('transfers:progress', event)
  }
  const current = event.current ?? 0
  const total = event.total ?? 0
  if (activeTransferIds.size === 0) mainWindow?.setProgressBar(-1)
  else if (total > 0) mainWindow?.setProgressBar(Math.min(1, Math.max(0, current / total)))
  else mainWindow?.setProgressBar(2, { mode: 'indeterminate' })
  showTransferNotification(event)

  if (quitAfterTransfers && activeTransferIds.size === 0) app.quit()
}

const toggleDevTools = (target: BrowserWindow | null): void => {
  const webContents = target?.webContents
  if (!webContents) return
  if (webContents.isDevToolsOpened()) webContents.closeDevTools()
  else webContents.openDevTools({ mode: 'detach' })
}

const createWindow = (): void => {
  quitAfterTransfers = false
  log('Creating main window')
  mainWindow = new BrowserWindow({
    width: 560,
    height: 920,
    minWidth: 560,
    minHeight: 680,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    icon: path.join(__dirname, '../build/icon.ico'),
    title: 'oNami',
    autoHideMenuBar: true,
    show: false,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: false,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    log(`Loading dev URL ${process.env.VITE_DEV_SERVER_URL}`)
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    const indexPath = path.join(__dirname, '../dist/index.html')
    log(`Loading packaged renderer ${indexPath}`)
    mainWindow.loadFile(indexPath)
  }

  mainWindow.on('closed', () => {
    log('Main window closed')
    mainWindow = null
  })
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', false)
  })
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const opensDevTools = input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')
    if (!opensDevTools) return
    event.preventDefault()
    toggleDevTools(mainWindow)
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.on('page-title-updated', (event) => {
    event.preventDefault()
    mainWindow?.setTitle('oNami')
  })
  mainWindow.webContents.on('did-finish-load', () => log('Renderer finished load'))
  mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
    log(`Renderer failed to load: ${code} ${description} ${validatedUrl}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`Renderer process gone: ${details.reason} ${details.exitCode}`)
  })
}

const registerMediaProtocol = (): void => {
  protocol.handle('onami-media', async (request) => {
    const url = new URL(request.url)
    const mediaId = decodeURIComponent(url.hostname || url.pathname.replace(/^\//, ''))
    const mediaPath = getServices().getMediaPath(mediaId)
    if (!mediaPath) return new Response('Media not found.', { status: 404 })
    return net.fetch(pathToFileURL(mediaPath).toString())
  })
}

const registerIpc = (): void => {
  ipcMain.handle('decks:create', (_event, input: CreateDeckInput) => getServices().createDeck(input))
  ipcMain.handle('decks:delete', (_event, deckId: string) => getServices().deleteDeck(deckId))
  ipcMain.handle('decks:reset-scheduling', (_event, deckId: string) =>
    getServices().resetDeckScheduling(deckId)
  )
  ipcMain.handle('decks:list', () => getServices().listDecks())
  ipcMain.handle('decks:get', (_event, deckId: string) => getServices().getDeck(deckId))
  ipcMain.handle('decks:select-apkg', async () => {
    const options: OpenDialogOptions = {
      title: 'Import Anki package',
      filters: [{ name: 'Anki Package', extensions: ['apkg'] }],
      properties: ['openFile'],
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('decks:import-apkg', (_event, filePath: string, options: ImportApkgOptions) =>
    getServices().importApkg(filePath, options)
  )

  ipcMain.handle('global-decks:list', (_event, search: string) => getServices().listGlobalDecks(search))
  ipcMain.handle('global-decks:publish', (_event, localDeckId: string) =>
    getServices().publishGlobalDeck(localDeckId)
  )
  ipcMain.handle('global-decks:heart', (_event, globalDeckId: string, hearted: boolean) =>
    getServices().heartGlobalDeck(globalDeckId, hearted)
  )
  ipcMain.handle('global-decks:add-to-library', (_event, globalDeckId: string) =>
    getServices().addGlobalDeckToLibrary(globalDeckId)
  )

  ipcMain.handle('cards:create', (_event, input: CreateCardInput) => getServices().createCard(input))
  ipcMain.handle('cards:update', (_event, input: UpdateCardInput) => getServices().updateCard(input))
  ipcMain.handle('cards:delete', (_event, cardId: string) => getServices().deleteCard(cardId))

  ipcMain.handle(
    'study:start-session',
    (_event, deckId: string, mode: StudyMode, settings: StudySessionSettings) =>
      getServices().startSession(deckId, mode, settings)
  )
  ipcMain.handle('study:answer', (_event, input: AnswerInput) => getServices().answer(input))

  ipcMain.handle('ai:get-settings', () => getServices().getAiSettings())
  ipcMain.handle('ai:save-settings', (_event, input: SaveAiSettingsInput) =>
    getServices().saveAiSettings(input)
  )
  ipcMain.handle('ai:generate-cards', (_event, input: string, options: AiGenerationOptions) =>
    getServices().generateCards(input, options)
  )

  ipcMain.handle('stats:get', (_event, filter?: StatsFilterInput) => getServices().getStats(filter))

  ipcMain.handle('settings:get', () => getServices().getAppSettings())
  ipcMain.handle('settings:save', (_event, input: SaveAppSettingsInput) =>
    getServices().saveAppSettings(input)
  )

  ipcMain.handle('sync:get-status', () => getServices().getSyncStatus())
  ipcMain.handle('sync:save-settings', (_event, input: SaveSyncSettingsInput) =>
    getServices().saveSyncSettings(input)
  )
  ipcMain.handle('sync:check-health', () => getServices().checkSyncHealth())
  ipcMain.handle('sync:start-pairing', () => getServices().startSyncPairing())
  ipcMain.handle('sync:join-pairing', (_event, input: SyncJoinPairingInput) =>
    getServices().joinSyncPairing(input)
  )
  ipcMain.handle('sync:confirm-pairing', (_event, input: SyncConfirmPairingInput) =>
    getServices().confirmSyncPairing(input)
  )
  ipcMain.handle('sync:sync-now', (event, options?: SyncRunOptions) =>
    getServices().syncNow(options, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('sync:progress', progress)
    })
  )
  ipcMain.handle('transfers:get-status', () => getServices().getTransferStatus())

  ipcMain.handle('updates:get-status', () => getServices().getUpdateStatus())
  ipcMain.handle('updates:check', () => getServices().checkForUpdate())
  ipcMain.handle('updates:download', () => getServices().downloadUpdate())
  ipcMain.handle('updates:install', async () => {
    const installerPath = await getServices().getVerifiedInstallerPath()
    if (!installerPath) throw new Error('The update installer is not downloaded yet.')

    // Detached, because the installer has to outlive the app it replaces.
    log(`Launching update installer ${installerPath}`)
    spawn(installerPath, [], { detached: true, stdio: 'ignore' }).unref()
    quitAfterTransfers = false
    app.quit()
  })

  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.handle('window:toggle-maximize', (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner) return false
    if (owner.isMaximized()) owner.unmaximize()
    else owner.maximize()
    return owner.isMaximized()
  })
  ipcMain.handle('window:is-maximized', (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })
  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
  ipcMain.handle('window:open-devtools', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.webContents.openDevTools({ mode: 'detach' })
  })
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
log(`Single instance lock: ${gotSingleInstanceLock}`)
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  process.on('uncaughtException', (error) => log('Uncaught exception', error))
  process.on('unhandledRejection', (error) => log('Unhandled rejection', error))

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)

    const userData = app.getPath('userData')
    const logDir = path.join(userData, 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    logFilePath = path.join(logDir, 'main.log')
    log('App ready')

    try {
      const [{ OnamiDatabase }, { AppServices }] = await Promise.all([
        import('./domain/database'),
        import('./domain/appServices'),
      ])
      const database = new OnamiDatabase(path.join(userData, 'onami.sqlite'), path.join(userData, 'media'))
      services = new AppServices(database)
      services.onTransferProgress(handleTransferProgress)
      services.startBackgroundTransfers()
      registerMediaProtocol()
      registerIpc()
      createWindow()
    } catch (error) {
      log('Startup failed', error)
      dialog.showErrorBox('oNami failed to start', error instanceof Error ? error.message : String(error))
      app.quit()
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch((error) => {
    log('App ready failed', error)
    app.quit()
  })
}

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return
  if (activeTransferIds.size > 0) {
    quitAfterTransfers = true
    if (Notification.isSupported()) {
      new Notification({
        title: 'oNami is continuing in the background',
        body: 'Your download, upload, or sync will keep going and oNami will exit when it finishes.',
        icon: path.join(__dirname, '../build/icon.png'),
      }).show()
    }
    return
  }
  app.quit()
})
