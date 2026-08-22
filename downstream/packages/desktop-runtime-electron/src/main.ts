/** Trusted Electron main-process runtime for DSH-GUI. */

import { readFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  safeStorage,
  session as electronSession,
  utilityProcess,
  type Session,
} from 'electron'
import {
  DESKTOP_RENDERER_ORIGIN,
  type DesktopProductInfo,
  type DesktopUpdateStatus,
} from '@acosmi/dsh-desktop-carrier-electron/protocol'
import {
  ProtectedSecretVault,
  SessionSecretVault,
  loadOrCreateVaultProfileId,
  type DesktopSecretPersistence,
  type DesktopSecretVault,
} from '@acosmi/dsh-desktop-secrets/vault'
import { checkDesktopUpdate, type ReleaseIndexPolicy } from '@acosmi/dsh-desktop-update'
import { DESKTOP_AUTHORITY, DESKTOP_SCHEME, type DesktopChannel } from './index.ts'
import {
  acceptRendererOneWayMessage,
  IPC,
  parseRendererId,
} from './messages.ts'
import { DesktopUtilityBroker } from './broker.ts'
import { parseDesktopAssetManifest, verifyDesktopAsset } from './assets.ts'
import { assertTrustedSender } from './renderer-stream.ts'
import {
  handleRendererProductInfo,
  handleRendererStreamNext,
  handleRendererStreamOpen,
  handleRendererUnary,
  handleRendererUpdateCheck,
} from './renderer-ipc.ts'
import { createDesktopUtilityEnvironment } from './environment.ts'
import { resolveDesktopSecretPersistence } from './secret-persistence.ts'
import {
  canFocusExistingWindow,
  desktopActivateAction,
  shouldPromptRendererRestart,
} from './lifecycle.ts'

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ')

let schemeRegistered = false

/** Build-time/runtime update roots. Absence keeps updates disabled. Only an explicit check exists until a signed feed implements download and apply. */
export interface DesktopUpdateOptions {
  readonly mode: 'manual'
  readonly indexUrl: string
  readonly publicKeys: Readonly<Record<string, string>>
}

/** Channel identity compiled from the release ledger into the application. */
export interface DesktopRuntimeIdentity {
  readonly productName: string
  readonly bundleId: string
  readonly windowsAumid: string
  readonly protocol: string
  readonly userDataDirectory: string
  readonly harnessDirectory: string
  readonly vaultFilename: string
  readonly profileFilename: string
  readonly secretNamespace: string
  readonly oauthIssuer: 'https://acosmi.com'
}

/** Inputs owned by the thin channel-specific application entry. */
export interface DesktopMainOptions {
  readonly channel: DesktopChannel
  readonly identity: DesktopRuntimeIdentity
  readonly preloadPath: string
  readonly utilityPath: string
  readonly rendererRoot: string
  readonly rendererAssetManifest: string
  /** Read-only preset roster shipped with this application build. */
  readonly presetRoot: string
  readonly productInfo: Omit<DesktopProductInfo, 'version' | 'electronVersion' | 'updateMode' | 'secretStorage'>
  readonly update?: DesktopUpdateOptions
  readonly development?: boolean
}

/** Register the privileged application scheme before Electron becomes ready. */
export function registerDesktopScheme(): void {
  if (schemeRegistered) return
  schemeRegistered = true
  protocol.registerSchemesAsPrivileged([{
    scheme: DESKTOP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true,
      stream: true,
    },
  }])
}

/** Run the complete desktop lifecycle until Electron exits. */
export async function runDesktopMain(options: DesktopMainOptions): Promise<void> {
  validateMainOptions(options)
  const identity = options.identity
  app.setName(identity.productName)
  app.setPath('userData', join(app.getPath('appData'), identity.userDataDirectory))
  if (process.platform === 'win32') app.setAppUserModelId(identity.windowsAumid)
  if (!app.requestSingleInstanceLock({ channel: options.channel })) {
    app.quit()
    return
  }

  let window: BrowserWindow | undefined
  let broker: DesktopUtilityBroker | undefined
  let vaultPersistence: DesktopSecretPersistence | undefined
  let stopping = false
  const partition = `persist:dsh-gui-${options.channel}`
  const windowLive = (): boolean => window !== undefined && !window.isDestroyed()
  const beginApplicationTeardown = (): void => {
    stopping = true
    removeIpcHandlers()
  }
  const openWindow = (): void => {
    if (stopping || broker === undefined || vaultPersistence === undefined) return
    window = createDesktopWindow(options, broker, partition, () => stopping)
    installIpcHandlers(window, broker, options, vaultPersistence)
  }
  app.on('second-instance', () => {
    if (!canFocusExistingWindow(stopping, windowLive()) || window === undefined) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  app.on('activate', () => {
    const action = desktopActivateAction(stopping, windowLive())
    if (action === 'ignore') return
    if (action === 'show') {
      window?.show()
      return
    }
    openWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !stopping) app.quit()
  })
  app.on('before-quit', event => {
    if (stopping) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    beginApplicationTeardown()
    void (broker?.shutdown() ?? Promise.resolve())
      .catch((_shutdownFailure) => {
        console.error('[dsh-gui] shutdown failed; details omitted')
      })
      .finally(() => app.exit(0))
  })

  try {
    await app.whenReady()
    const userData = app.getPath('userData')
    const harnessHome = join(userData, identity.harnessDirectory)
    await Promise.all([
      mkdir(userData, { recursive: true, mode: 0o700 }),
      mkdir(harnessHome, { recursive: true, mode: 0o700 }),
    ])
    const vault = await createSecretVault(options, userData)
    vaultPersistence = vault.persistence
    const appSession = electronSession.fromPartition(partition)
    await installResourceProtocol(appSession, options.rendererRoot, options.rendererAssetManifest)
    hardenSession(appSession)
    const child = utilityProcess.fork(options.utilityPath, [], {
      serviceName: `${identity.productName} Harness Host`,
      env: createDesktopUtilityEnvironment({
        inherited: process.env,
        platform: process.platform,
        home: harnessHome,
        workspace: app.getPath('documents'),
        channel: options.channel,
        presetRoot: options.presetRoot,
        secretPersistence: vault.persistence,
      }),
      execArgv: [],
    })
    broker = new DesktopUtilityBroker(child, vault, () => window, beginApplicationTeardown)
    await broker.ready()
    openWindow()
  } catch (_startupFailure) {
    console.error('[dsh-gui] startup failed; details omitted')
    dialog.showErrorBox(identity.productName, 'The desktop application could not start its local Harness Host.')
    beginApplicationTeardown()
    await broker?.shutdown().catch(() => undefined)
    app.exit(1)
  }
}

function createDesktopWindow(
  options: DesktopMainOptions,
  broker: DesktopUtilityBroker,
  partition: string,
  stopping: () => boolean,
): BrowserWindow {
  const productName = options.identity.productName
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 940,
    minHeight: 640,
    show: false,
    title: productName,
    backgroundColor: '#101114',
    webPreferences: {
      preload: options.preloadPath,
      partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: options.development === true && !app.isPackaged,
      spellcheck: true,
    },
  })
  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (options.development === true && !app.isPackaged) {
    window.webContents.on('console-message', details => {
      console.error(`[dsh-gui] renderer console event (${details.level}); details omitted`)
    })
    window.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      console.error(`[dsh-gui] renderer load failed (${String(code)}, main=${String(mainFrame)}); details omitted`)
    })
    window.webContents.on('preload-error', () => {
      console.error('[dsh-gui] preload failed; details omitted')
    })
  }
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== `${DESKTOP_RENDERER_ORIGIN}/index.html`) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  const closeRendererStreams = (): void => {
    for (const streamId of activeStreams) broker.closeStream(streamId)
    activeStreams.clear()
  }
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) closeRendererStreams()
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    closeRendererStreams()
    if (!shouldPromptRendererRestart(stopping(), details.reason)) return
    void dialog.showMessageBox(window, {
      type: 'error',
      title: productName,
      message: 'The interface process stopped unexpectedly.',
      detail: `Restart ${productName} to reconnect to the local Harness Host.`,
    })
  })
  window.on('closed', closeRendererStreams)
  void window.loadURL(`${DESKTOP_RENDERER_ORIGIN}/index.html`)
  return window
}

const activeStreams = new Set<string>()

function installIpcHandlers(
  window: BrowserWindow,
  broker: DesktopUtilityBroker,
  options: DesktopMainOptions,
  vaultPersistence: DesktopSecretPersistence,
): void {
  removeIpcHandlers()
  ipcMain.handle(IPC.request, (event, raw) => handleRendererUnary(event, window, broker, raw))
  ipcMain.handle(IPC.streamOpen, (event, raw) => (
    handleRendererStreamOpen(event, window, broker, activeStreams, raw)
  ))
  ipcMain.handle(IPC.streamNext, (event, raw) => (
    handleRendererStreamNext(event, window, broker, activeStreams, raw)
  ))
  ipcMain.handle(IPC.productInfo, event => (
    handleRendererProductInfo(event, window, () => productInfo(options, vaultPersistence))
  ))
  ipcMain.handle(IPC.checkForUpdates, event => (
    handleRendererUpdateCheck(event, window, () => checkForUpdates(options))
  ))
  ipcMain.on(IPC.cancel, (event, raw) => {
    const requestId = acceptRendererOneWayMessage(() => {
      assertTrustedSender(event, window)
      return parseRendererId(raw)
    })
    if (requestId !== undefined) broker.cancel(requestId)
  })
  ipcMain.on(IPC.streamClose, (event, raw) => {
    const streamId = acceptRendererOneWayMessage(() => {
      assertTrustedSender(event, window)
      return parseRendererId(raw)
    })
    if (streamId === undefined) return
    if (!activeStreams.delete(streamId)) return
    broker.closeStream(streamId)
  })
}

function removeIpcHandlers(): void {
  for (const channel of [IPC.request, IPC.streamOpen, IPC.streamNext, IPC.productInfo, IPC.checkForUpdates]) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.removeAllListeners(IPC.cancel)
  ipcMain.removeAllListeners(IPC.streamClose)
}

async function installResourceProtocol(
  appSession: Session,
  rendererRoot: string,
  manifestPath: string,
): Promise<void> {
  const root = resolve(rendererRoot)
  const files = parseDesktopAssetManifest(readFileSync(manifestPath, 'utf8'))
  appSession.protocol.handle(DESKTOP_SCHEME, async request => {
    try {
      if (request.method !== 'GET') return new Response('method not allowed', { status: 405 })
      const url = new URL(request.url)
      if (url.protocol !== `${DESKTOP_SCHEME}:` || url.hostname !== DESKTOP_AUTHORITY
        || url.username !== '' || url.password !== '' || url.hash !== '') {
        return new Response('not found', { status: 404 })
      }
      const resource = decodeResourcePath(url.pathname)
      const filename = resolve(root, resource)
      const rel = relative(root, filename)
      if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return new Response('not found', { status: 404 })
      const body = await readFile(filename)
      verifyDesktopAsset(files, resource, url.search, body)
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': contentType(resource),
          'content-security-policy': CSP,
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-resource-policy': 'same-origin',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        },
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

function hardenSession(appSession: Session): void {
  appSession.setPermissionCheckHandler(() => false)
  appSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  appSession.on('will-download', event => event.preventDefault())
  appSession.webRequest.onBeforeRequest({
    urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'file://*/*'],
  }, (_details, callback) => callback({ cancel: true }))
}

function decodeResourcePath(pathname: string): string {
  const decoded = decodeURIComponent(pathname)
  const value = decoded === '/' ? 'index.html' : decoded.slice(1)
  if (value.length === 0 || value.includes('\\') || value.includes('\0')
    || value.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('desktop resource path is invalid')
  }
  return value
}

function contentType(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  }
  return types[extension] ?? 'application/octet-stream'
}

function productInfo(
  options: DesktopMainOptions,
  vaultPersistence: DesktopSecretPersistence,
): DesktopProductInfo {
  return {
    ...options.productInfo,
    version: app.getVersion(),
    electronVersion: process.versions.electron,
    secretStorage: vaultPersistence,
    updateMode: options.update?.mode ?? 'disabled',
  }
}

async function createSecretVault(options: DesktopMainOptions, userData: string): Promise<DesktopSecretVault> {
  const persistence = resolveDesktopSecretPersistence(options.productInfo.signing, process.platform, {
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    ...(process.platform === 'linux'
      ? { linuxBackend: safeStorage.getSelectedStorageBackend() }
      : {}),
  })
  if (persistence === 'session-memory') return new SessionSecretVault()
  const identity = options.identity
  const profileId = await loadOrCreateVaultProfileId(join(userData, identity.profileFilename))
  return new ProtectedSecretVault(join(userData, identity.vaultFilename), safeStorage, {
    productId: identity.bundleId,
    channel: options.channel,
    issuer: identity.oauthIssuer,
    profileId,
  })
}

async function checkForUpdates(options: DesktopMainOptions): Promise<DesktopUpdateStatus> {
  const update = options.update
  if (update === undefined) return { status: 'disabled', message: 'No trusted update feed is configured.' }
  const platform = process.platform
  const arch = process.arch
  if ((platform !== 'darwin' && platform !== 'win32') || (arch !== 'arm64' && arch !== 'x64')) {
    return { status: 'error', message: 'Updates are unavailable for this platform.', checkedAt: Date.now() }
  }
  const policy: ReleaseIndexPolicy = {
    productId: options.identity.bundleId,
    channel: options.channel,
    platform,
    arch,
    osVersion: process.getSystemVersion(),
    currentVersion: app.getVersion(),
    publicKeys: update.publicKeys,
  }
  try {
    const result = await checkDesktopUpdate(update.indexUrl, policy, AbortSignal.timeout(15_000))
    return result.status === 'current'
      ? result
      : { status: 'available', version: result.version, checkedAt: result.checkedAt }
  } catch {
    return { status: 'error', message: 'The signed update index could not be verified.', checkedAt: Date.now() }
  }
}

function validateMainOptions(options: DesktopMainOptions): void {
  for (const path of [
    options.preloadPath,
    options.utilityPath,
    options.rendererRoot,
    options.rendererAssetManifest,
    options.presetRoot,
  ]) {
    if (!isAbsolute(path)) throw new Error('desktop runtime paths must be absolute')
  }
  if (options.productInfo.channel !== options.channel) throw new Error('desktop product channel does not match runtime channel')
  const expectedId = options.channel === 'stable'
    ? 'com.acosmi.dsharness.gui'
    : 'com.acosmi.dsharness.gui.canary'
  if (options.identity.bundleId !== expectedId || options.identity.windowsAumid !== expectedId) {
    throw new Error('desktop runtime identity does not match its channel')
  }
  if (options.identity.productName !== (options.channel === 'stable' ? 'DSH-GUI' : 'DSH-GUI Canary')
    || options.identity.userDataDirectory !== (options.channel === 'stable' ? 'DSH-GUI' : 'DSH-GUI Canary')
    || options.identity.secretNamespace !== expectedId
    || options.identity.protocol !== (options.channel === 'stable' ? 'dshgui' : 'dshgui-canary')
    || options.identity.harnessDirectory !== 'harness'
    || options.identity.vaultFilename !== 'secrets.v2.json'
    || options.identity.profileFilename !== 'profile.v1.json') {
    throw new Error('desktop runtime identity ledger contains an invalid channel mapping')
  }
}
