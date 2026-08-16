/** Electron utility-process entry for the real Harness Host. */

import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  boot,
  loadOverlayPatches,
} from '@deepseek-ai/dsh-app-boot'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import {
  DESKTOP_PROTOCOL_VERSION,
  MAX_DESKTOP_ACTIVE_STREAMS,
  MAX_DESKTOP_BODY_BYTES,
  MAX_DESKTOP_HOST_CALLS,
  MAX_DESKTOP_PENDING_CALLS,
  type DesktopStreamItem,
  type DesktopUnaryRequest,
  type DesktopUnaryResponse,
} from '@acosmi/dsh-desktop-carrier-electron/protocol'
import { DesktopHostConnection } from '@acosmi/dsh-desktop-carrier-electron'
import {
  provideDesktopSecrets,
  type DesktopSecretBridge,
} from '@acosmi/dsh-desktop-secrets'
import {
  provideDesktopDirectoryPicker,
  type DesktopDirectoryPickerBridge,
} from '@acosmi/dsh-desktop-directory-picker'
import {
  provideAcosmiOAuthBrowser,
  type AcosmiOAuthBrowserBridge,
} from '@acosmi/dsh-account-acosmi'
import {
  assertHostVoid,
  isRecord,
  parseHostBoolean,
  parseHostDirectorySelection,
  parseHostOptionalSecret,
  publicFailure,
  tryPostDesktopMessage,
} from './messages.ts'
import { desktopPresetPatch } from './composition.ts'
import { readBoundedResponseBody } from './body.ts'

interface HostStream {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>
  readonly opened: DesktopStreamItem
  opening: boolean
  pulling: boolean
}

interface PendingHostCall {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

interface PendingUtilityRequest {
  readonly abort: AbortController
  readonly done: Promise<void>
}

interface PendingStreamOpen {
  readonly abort: AbortController
  readonly done: Promise<void>
}

/** Start the utility controller and boot the full plugin tree. */
export async function runDesktopUtility(): Promise<void> {
  const port = process.parentPort
  if (port === undefined) throw new Error('desktop utility requires an Electron parent port')
  const controller = new DesktopUtilityController(port)
  try {
    await controller.start()
  } catch (error) {
    logStartupError(error)
    tryPostDesktopMessage(port, { type: 'fatal' })
    process.exitCode = 1
  }
}

function logStartupError(error: unknown): void {
  void error
  console.error('[dsh-gui] Harness Host startup failed; details omitted')
}

/** Utility-process transaction owner for Host requests, streams, and shutdown. */
export class DesktopUtilityController {
  private readonly hostCalls = new Map<string, PendingHostCall>()
  private readonly requests = new Map<string, PendingUtilityRequest>()
  private readonly streams = new Map<string, HostStream>()
  private readonly openingStreams = new Map<string, PendingStreamOpen>()
  private shuttingDown = false
  private hostBridgeClosed = false
  private shutdownTask: Promise<void> | undefined
  private ctx: Context | undefined
  private connection: DesktopHostConnection | undefined
  private fallback: ((request: Request) => Promise<Response>) | undefined

  /** @param port - Electron parent-port transport owned by the main process. */
  constructor(private readonly port: Electron.ParentPort) {
    port.on('message', event => { void this.route(event.data) })
  }

  async start(): Promise<void> {
    const workspace = process.env.DSH_DESKTOP_WORKSPACE
    if (workspace === undefined || !isAbsolute(workspace)) {
      throw new Error('desktop utility workspace is missing')
    }
    const presetRoot = process.env.DSH_DESKTOP_PRESET_ROOT
    if (presetRoot === undefined || !isAbsolute(presetRoot)) {
      throw new Error('desktop utility preset root is missing')
    }
    process.chdir(workspace)
    const require = createRequire(import.meta.url)
    const channel = process.env.DSH_DESKTOP_CHANNEL
    if (channel !== 'stable' && channel !== 'canary') throw new Error('desktop utility channel is invalid')
    const bundlePackageJson = require.resolve('@acosmi/dsh-desktop-bundle/package.json')
    const bundleRequire = createRequire(pathToFileURL(bundlePackageJson))
    const config = bundleRequire.resolve('@acosmi/dsh-desktop-bundle/cordis.yml')
    const patchFiles = [
      require.resolve('@deepseek-ai/dsh-base/cordis.patch.yml'),
      require.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml'),
      require.resolve('@acosmi/dsh-desktop-bundle/cordis.patch.yml'),
      require.resolve(`@acosmi/dsh-desktop-bundle/cordis.${channel}.patch.yml`),
    ]
    const patches = patchFiles.flatMap(file => loadOverlayPatches('dsh-gui', file))
    patches.push(desktopPresetPatch(presetRoot))
    const persistence = process.env.DSH_DESKTOP_SECRET_PERSISTENCE
    if (persistence !== 'os-protected' && persistence !== 'session-memory') {
      throw new Error('desktop utility secret persistence is invalid')
    }
    const secretBridge: DesktopSecretBridge = {
      persistence,
      getEnvironmentCredential: async ref => parseHostOptionalSecret(await this.hostCall('secret-request', {
        operation: 'environment-get',
        key: ref,
      })),
      hasEnvironmentCredential: async ref => parseHostBoolean(await this.hostCall('secret-request', {
        operation: 'environment-has',
        key: ref,
      })),
      get: async key => parseHostOptionalSecret(await this.hostCall('secret-request', { operation: 'get', key })),
      set: async (key, value) => {
        assertHostVoid(await this.hostCall('secret-request', { operation: 'set', key, value }))
      },
      delete: async key => {
        assertHostVoid(await this.hostCall('secret-request', { operation: 'delete', key }))
      },
    }
    const directoryBridge: DesktopDirectoryPickerBridge = {
      pick: signal => this.pickDirectory(signal),
    }
    const browserBridge: AcosmiOAuthBrowserBridge = {
      open: async url => {
        assertHostVoid(await this.hostCall('external-request', { url }))
      },
    }
    const ctx = await boot(
      'dsh-gui',
      config,
      patches,
      prepared => {
        prepared.loader.internal = {
          version: 'v2',
          import: async (specifier: string) => {
            const filename = bundleRequire.resolve(specifier)
            return import(pathToFileURL(filename).href)
          },
        } as unknown as NonNullable<typeof prepared.loader.internal>
        provideDesktopSecrets(prepared, secretBridge)
        provideDesktopDirectoryPicker(prepared, directoryBridge)
        provideAcosmiOAuthBrowser(prepared, browserBridge)
      },
      pathToFileURL(bundlePackageJson).href,
    )
    const connection = ctx.get('connection')
    const apiProxy = ctx.get('apiProxy')
    if (!(connection instanceof DesktopHostConnection) || apiProxy === undefined) {
      await ctx.fiber.dispose()
      throw new Error('desktop Host composition is missing connection or API Proxy')
    }
    this.ctx = ctx
    this.connection = connection
    this.fallback = toFetchHandler(apiProxy).fetch
    if (!tryPostDesktopMessage(this.port, { type: 'ready' })) {
      await this.shutdown()
      throw new Error('desktop utility parent transport closed during startup')
    }
  }

  private async route(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== 'string') return
    if (message.type === 'host-reply') {
      const callId = message.callId
      if (typeof callId !== 'string') return
      const call = this.hostCalls.get(callId)
      if (call === undefined) return
      this.hostCalls.delete(callId)
      if (message.ok === true) call.resolve(message.value)
      else call.reject(new Error('desktop main operation failed'))
      return
    }
    if (message.type === 'cancel' && typeof message.requestId === 'string') {
      this.requests.get(message.requestId)?.abort.abort('renderer cancelled request')
      return
    }
    if (message.type === 'stream-close' && typeof message.streamId === 'string') {
      await this.closeStream(message.streamId)
      return
    }
    const callId = message.callId
    if (typeof callId !== 'string') return
    let reply: Record<string, unknown>
    try {
      let value: unknown
      if (message.type === 'fetch') value = await this.fetch(message.request)
      else if (message.type === 'stream-open') value = await this.openStream(message.url)
      else if (message.type === 'stream-next') value = await this.nextStream(message.streamId)
      else if (message.type === 'shutdown') value = await this.shutdown()
      else throw new Error('unknown desktop utility operation')
      reply = { type: 'reply', callId, ok: true, value }
    } catch (error) {
      reply = { type: 'reply', callId, ok: false, error: publicFailure(error) }
    }
    if (!tryPostDesktopMessage(this.port, reply)) await this.shutdown()
  }

  private async fetch(value: unknown): Promise<DesktopUnaryResponse> {
    const request = value as DesktopUnaryRequest
    if (!isRecord(value) || request.version !== DESKTOP_PROTOCOL_VERSION
      || typeof request.requestId !== 'string' || typeof request.url !== 'string'
      || request.method !== 'POST' || !Array.isArray(request.headers)
      || !(request.body instanceof ArrayBuffer) || request.body.byteLength > MAX_DESKTOP_BODY_BYTES) {
      throw new Error('utility rejected malformed request')
    }
    if (this.shuttingDown) throw new Error('desktop Host is shutting down')
    if (this.requests.has(request.requestId)) throw new Error('utility rejected a duplicate request id')
    if (this.requests.size >= MAX_DESKTOP_PENDING_CALLS) throw new Error('desktop Host has too many pending requests')
    const abort = new AbortController()
    const settled = Promise.withResolvers<void>()
    this.requests.set(request.requestId, { abort, done: settled.promise })
    try {
      const response = await this.dispatch(new Request(request.url, {
        method: 'POST',
        headers: request.headers.map(row => [row[0], row[1]] as [string, string]),
        body: request.body,
        signal: abort.signal,
      }))
      const body = await readBoundedResponseBody(response, MAX_DESKTOP_BODY_BYTES)
      return {
        version: DESKTOP_PROTOCOL_VERSION,
        status: response.status,
        headers: responseHeaders(response.headers),
        body,
      }
    } finally {
      this.requests.delete(request.requestId)
      settled.resolve()
    }
  }

  private async openStream(value: unknown): Promise<string> {
    if (typeof value !== 'string') throw new Error('utility rejected malformed stream URL')
    if (this.shuttingDown) throw new Error('desktop Host is shutting down')
    if (this.streams.size + this.openingStreams.size >= MAX_DESKTOP_ACTIVE_STREAMS) {
      throw new Error('desktop Host has too many active streams')
    }
    const streamId = randomUUID()
    const abort = new AbortController()
    const settled = Promise.withResolvers<void>()
    this.openingStreams.set(streamId, { abort, done: settled.promise })
    try {
      const response = await this.dispatch(new Request(value, { signal: abort.signal }))
      if (this.shuttingDown) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('desktop Host is shutting down')
      }
      if (response.body === null) throw new Error('desktop Host stream has no body')
      this.streams.set(streamId, {
        reader: response.body.getReader(),
        opened: { type: 'opened', status: response.status, headers: responseHeaders(response.headers) },
        opening: true,
        pulling: false,
      })
      return streamId
    } finally {
      this.openingStreams.delete(streamId)
      settled.resolve()
    }
  }

  private async nextStream(value: unknown): Promise<DesktopStreamItem> {
    if (typeof value !== 'string') throw new Error('utility rejected malformed stream id')
    const stream = this.streams.get(value)
    if (stream === undefined) throw new Error('desktop Host stream is closed')
    if (stream.pulling) throw new Error('desktop Host stream already has a pending pull')
    if (stream.opening) {
      stream.opening = false
      return stream.opened
    }
    stream.pulling = true
    try {
      const item = await stream.reader.read()
      if (item.done) {
        this.streams.delete(value)
        return { type: 'end' }
      }
      if (item.value.byteLength > MAX_DESKTOP_BODY_BYTES) {
        await this.closeStream(value)
        return { type: 'error', message: 'Desktop Host emitted an oversized stream frame.' }
      }
      const copy = new Uint8Array(item.value.byteLength)
      copy.set(item.value)
      return { type: 'chunk', data: copy.buffer }
    } catch {
      this.streams.delete(value)
      return { type: 'error', message: 'Desktop Host stream closed unexpectedly.' }
    } finally {
      stream.pulling = false
    }
  }

  private async closeStream(streamId: string): Promise<void> {
    const stream = this.streams.get(streamId)
    if (stream === undefined) return
    this.streams.delete(streamId)
    await stream.reader.cancel().catch(() => undefined)
  }

  private shutdown(): Promise<void> {
    this.shutdownTask ??= this.shutdownInternal()
    return this.shutdownTask
  }

  private async shutdownInternal(): Promise<void> {
    this.shuttingDown = true
    for (const request of this.requests.values()) request.abort.abort('desktop Host shutting down')
    for (const opening of this.openingStreams.values()) opening.abort.abort('desktop Host shutting down')
    await Promise.all([
      ...[...this.requests.values()].map(request => request.done),
      ...[...this.openingStreams.values()].map(opening => opening.done),
    ])
    await Promise.all([...this.streams.keys()].map(streamId => this.closeStream(streamId)))
    const ctx = this.ctx
    this.ctx = undefined
    this.connection = undefined
    this.fallback = undefined
    try {
      await ctx?.fiber.dispose()
    } finally {
      this.hostBridgeClosed = true
      const hostFailure = new Error('desktop Host is shutting down')
      for (const call of this.hostCalls.values()) call.reject(hostFailure)
      this.hostCalls.clear()
    }
  }

  private dispatch(request: Request): Promise<Response> {
    const connection = this.connection
    const fallback = this.fallback
    if (connection === undefined || fallback === undefined) throw new Error('desktop Host is not ready')
    return connection.fetch(request, fallback)
  }

  private hostCall(type: string, fields: Record<string, unknown>): Promise<unknown> {
    if (this.hostBridgeClosed) return Promise.reject(new Error('desktop Host is shutting down'))
    if (this.hostCalls.size >= MAX_DESKTOP_HOST_CALLS) {
      return Promise.reject(new Error('desktop Host has too many pending main-process operations'))
    }
    const callId = randomUUID()
    return new Promise((resolve, reject) => {
      this.hostCalls.set(callId, { resolve, reject })
      try {
        this.port.postMessage({ type, callId, ...fields })
      } catch (cause) {
        this.hostCalls.delete(callId)
        reject(new Error('desktop main-process operation could not be dispatched', { cause }))
      }
    })
  }

  private async pickDirectory(signal: AbortSignal): Promise<string | null> {
    if (signal.aborted) throw abortError(signal)
    const operation = this.hostCall('directory-request', {}).then(parseHostDirectorySelection)
    return new Promise((resolve, reject) => {
      const abort = (): void => { reject(abortError(signal)) }
      signal.addEventListener('abort', abort, { once: true })
      void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
}

function responseHeaders(headers: Headers): Array<readonly [string, string]> {
  const result: Array<readonly [string, string]> = []
  for (const name of ['content-type', 'content-encoding', 'cache-control']) {
    const value = headers.get(name)
    if (value !== null) result.push([name, value])
  }
  return result
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('directory choice aborted')
}
