/** Main-process broker between renderer IPC and the Harness utility process. */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { realpath } from 'node:fs/promises'
import { shell, type BrowserWindow, type UtilityProcess } from 'electron'
import type {
  DesktopStreamItem,
  DesktopUnaryRequest,
  DesktopUnaryResponse,
} from '@acosmi/dsh-desktop-carrier-electron/protocol'
import {
  MAX_DESKTOP_HOST_CALLS,
  MAX_DESKTOP_PENDING_CALLS,
} from '@acosmi/dsh-desktop-carrier-electron/protocol'
import {
  MAX_DESKTOP_SECRET_VALUE_BYTES,
  type DesktopSecretVault,
} from '@acosmi/dsh-desktop-secrets/vault'
import {
  assertUtilityVoid,
  isRecord,
  parseAcosmiAuthorizationUrl,
  parseUtilityStreamId,
  parseUtilityStreamItem,
  parseUtilityUnaryResponse,
  tryPostDesktopMessage,
} from './messages.ts'

const DESKTOP_ENVIRONMENT_CREDENTIAL = 'DEEPSEEK_API_KEY'

interface PendingCall {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

/** Trusted main-process owner of utility calls, secrets, and native dialogs. */
export class DesktopUtilityBroker {
  private readonly pending = new Map<string, PendingCall>()
  private readonly hostOperations = new Map<string, Promise<void>>()
  private acceptingHostOperations = true
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private readonly readyPromise = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })
  private exitResolve!: () => void
  private readonly exitPromise = new Promise<void>(resolve => { this.exitResolve = resolve })
  private exited = false
  private shutdownTask: Promise<void> | undefined

  /**
   * @param child - Electron utility process running the Harness Host.
   * @param vault - channel-specific secret vault selected by the main process.
   * @param owner - current desktop window for native directory dialogs.
   */
  constructor(
    private readonly child: UtilityProcess,
    private readonly vault: DesktopSecretVault,
    private readonly owner: () => BrowserWindow | undefined,
  ) {
    child.on('message', message => { void this.route(message) })
    child.on('exit', code => {
      this.exited = true
      this.acceptingHostOperations = false
      this.exitResolve()
      const failure = new Error(`desktop Host exited with code ${String(code)}`)
      this.readyReject(failure)
      for (const call of this.pending.values()) call.reject(failure)
      this.pending.clear()
    })
  }

  /** Wait until the complete Harness plugin tree is active. */
  async ready(timeoutMs = 45_000): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        this.readyPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('desktop Host startup timed out')), timeoutMs)
          timer.unref()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Dispatch one unary carrier request. */
  request(request: DesktopUnaryRequest): Promise<DesktopUnaryResponse> {
    return this.invoke({ type: 'fetch', request }).then(parseUtilityUnaryResponse)
  }

  /** Cancel one in-flight request by renderer id. */
  cancel(requestId: string): void {
    this.postIfRunning({ type: 'cancel', requestId })
  }

  /** Open one Host event stream. */
  openStream(url: string): Promise<string> {
    return this.invoke({ type: 'stream-open', url }).then(parseUtilityStreamId)
  }

  /** Pull exactly one item from a Host event stream. */
  nextStream(streamId: string): Promise<DesktopStreamItem> {
    return this.invoke({ type: 'stream-next', streamId }).then(parseUtilityStreamItem)
  }

  /** Close one Host event stream. */
  closeStream(streamId: string): void {
    this.postIfRunning({ type: 'stream-close', streamId })
  }

  /** Dispose the Host tree within a deadline, terminate it once, and wait for process exit. */
  shutdown(timeoutMs = 5_000): Promise<void> {
    if (this.exited) return Promise.resolve()
    this.shutdownTask ??= this.shutdownInternal(timeoutMs)
    return this.shutdownTask
  }

  private async shutdownInternal(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    let failure: unknown
    const current = this.owner()
    try {
      if (current !== undefined && !current.isDestroyed()) current.destroy()
    } catch (error) {
      failure = error
    }
    try {
      await Promise.race([
        this.invoke({ type: 'shutdown' }, true)
          .then(assertUtilityVoid)
          .then(async () => {
            this.acceptingHostOperations = false
            await this.drainHostOperations()
          }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('desktop Host shutdown timed out')), timeoutMs)
          timer.unref()
        }),
      ])
    } catch (error) {
      failure ??= error
    } finally {
      this.acceptingHostOperations = false
      if (timer !== undefined) clearTimeout(timer)
    }
    if (!this.exited) {
      try {
        this.child.kill()
      } catch (error) {
        failure ??= error
      }
    }
    try {
      await this.waitForExit(Math.min(Math.max(timeoutMs, 1), 1_000))
    } catch (error) {
      failure ??= error
    }
    if (failure !== undefined) throw failure
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    if (this.exited) return
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        this.exitPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('desktop Host termination timed out')), timeoutMs)
          timer.unref()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private invoke(message: Record<string, unknown>, lifecyclePriority = false): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error('desktop Host is not running'))
    if (!lifecyclePriority && this.pending.size >= MAX_DESKTOP_PENDING_CALLS) {
      return Promise.reject(new Error('desktop Host has too many pending operations'))
    }
    const callId = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(callId, { resolve, reject })
      try {
        this.child.postMessage({ ...message, callId })
      } catch (cause) {
        this.pending.delete(callId)
        reject(new Error('desktop Host operation could not be dispatched', { cause }))
      }
    })
  }

  private postIfRunning(message: Record<string, unknown>): void {
    if (this.exited) return
    tryPostDesktopMessage(this.child, message)
  }

  private async route(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== 'string') return
    if (message.type === 'ready') {
      this.readyResolve()
      return
    }
    if (message.type === 'fatal') {
      this.readyReject(new Error('desktop Host failed to start'))
      return
    }
    if (message.type === 'reply') {
      const callId = message.callId
      if (typeof callId !== 'string') return
      const call = this.pending.get(callId)
      if (call === undefined) return
      this.pending.delete(callId)
      if (message.ok === true && hasExactKeys(message, ['type', 'callId', 'ok', 'value'])) {
        call.resolve(message.value)
      } else {
        call.reject(new Error('desktop Host operation failed'))
      }
      return
    }
    if (message.type === 'secret-request' || message.type === 'directory-request'
      || message.type === 'external-request') await this.handleHostOperation(message)
  }

  private async handleHostOperation(message: Record<string, unknown>): Promise<void> {
    const callId = message.callId
    if (typeof callId !== 'string' || !validHostCallId(callId)) return
    if (!this.acceptingHostOperations
      || this.hostOperations.has(callId)
      || this.hostOperations.size >= MAX_DESKTOP_HOST_CALLS) {
      this.postIfRunning({ type: 'host-reply', callId, ok: false })
      return
    }
    if (!validHostOperation(message)) {
      this.postIfRunning({ type: 'host-reply', callId, ok: false })
      return
    }
    const operation = (async (): Promise<void> => {
      if (message.type === 'secret-request') await this.handleSecretRequest(message)
      else if (message.type === 'directory-request') await this.handleDirectoryRequest(message)
      else await this.handleExternalRequest(message)
    })()
    this.hostOperations.set(callId, operation)
    await operation.finally(() => {
      if (this.hostOperations.get(callId) === operation) this.hostOperations.delete(callId)
    })
  }

  private async drainHostOperations(): Promise<void> {
    while (this.hostOperations.size > 0) {
      await Promise.allSettled([...this.hostOperations.values()])
    }
  }

  private async handleSecretRequest(message: Record<string, unknown>): Promise<void> {
    const callId = message.callId
    const operation = message.operation
    const key = message.key
    if (typeof callId !== 'string' || typeof operation !== 'string' || typeof key !== 'string') return
    try {
      let value: unknown
      if (operation === 'get') value = await this.vault.get(key)
      else if (operation === 'set' && typeof message.value === 'string') value = await this.vault.set(key, message.value)
      else if (operation === 'delete') value = await this.vault.delete(key)
      else if (operation === 'environment-get') value = environmentCredential(key)
      else if (operation === 'environment-has') value = environmentCredential(key) !== undefined
      else throw new Error('unknown secret operation')
      this.postIfRunning({ type: 'host-reply', callId, ok: true, value })
    } catch {
      this.postIfRunning({ type: 'host-reply', callId, ok: false })
    }
  }

  private async handleDirectoryRequest(message: Record<string, unknown>): Promise<void> {
    const callId = message.callId
    if (typeof callId !== 'string') return
    try {
      const { dialog } = await import('electron')
      const current = this.owner()
      const result = current === undefined
        ? await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
        : await dialog.showOpenDialog(current, { properties: ['openDirectory', 'createDirectory'] })
      const selected = result.canceled || result.filePaths[0] === undefined
        ? null
        : await realpath(result.filePaths[0])
      if (selected !== null && !isAbsolute(selected)) throw new Error('directory chooser returned a relative path')
      this.postIfRunning({ type: 'host-reply', callId, ok: true, value: selected })
    } catch {
      this.postIfRunning({ type: 'host-reply', callId, ok: false })
    }
  }

  private async handleExternalRequest(message: Record<string, unknown>): Promise<void> {
    const callId = message.callId
    if (typeof callId !== 'string') return
    try {
      const url = parseAcosmiAuthorizationUrl(message.url)
      await shell.openExternal(url)
      this.postIfRunning({ type: 'host-reply', callId, ok: true })
    } catch {
      this.postIfRunning({ type: 'host-reply', callId, ok: false })
    }
  }
}

function environmentCredential(ref: string): string | undefined {
  if (ref !== DESKTOP_ENVIRONMENT_CREDENTIAL) return undefined
  const value = process.env[DESKTOP_ENVIRONMENT_CREDENTIAL]
  return value === undefined || value.length === 0 ? undefined : value
}

function validHostOperation(message: Record<string, unknown>): boolean {
  if (message.type === 'directory-request') return hasExactKeys(message, ['type', 'callId'])
  if (message.type === 'external-request') {
    return hasExactKeys(message, ['type', 'callId', 'url']) && typeof message.url === 'string'
  }
  if (message.type !== 'secret-request' || typeof message.operation !== 'string'
    || typeof message.key !== 'string') return false
  if (message.operation === 'set') {
    return hasExactKeys(message, ['type', 'callId', 'operation', 'key', 'value'])
      && typeof message.value === 'string'
      && Buffer.byteLength(message.value, 'utf8') <= MAX_DESKTOP_SECRET_VALUE_BYTES
  }
  return (message.operation === 'get' || message.operation === 'delete'
      || message.operation === 'environment-get' || message.operation === 'environment-has')
    && hasExactKeys(message, ['type', 'callId', 'operation', 'key'])
}

function hasExactKeys(message: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(message).every(key => typeof key === 'string' && keys.includes(key))
    && keys.every(key => Object.hasOwn(message, key))
}

function validHostCallId(value: string): boolean {
  return /^[A-Fa-f0-9-]{16,64}$/u.test(value)
}
