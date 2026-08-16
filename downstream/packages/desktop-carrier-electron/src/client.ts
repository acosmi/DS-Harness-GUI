/** Browser-side API Proxy and generic RPC carrier over the isolated preload API. */

import type { ClientConnectionRpc, ConnectionCarrier } from '@deepseek-ai/dsh-client-connection/carrier'
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import {
  RpcId,
  serverResponseSchema,
  type ClientRequest,
  type RpcMessage,
  type ServerResponse,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  DESKTOP_PROTOCOL_VERSION,
  DESKTOP_RENDERER_ORIGIN,
  isDesktopRendererUrl,
  type DesktopStreamItem,
  type DesktopUnaryRequest,
} from './protocol.ts'

const SECRET_METHODS = new Set([
  'credentials.set',
  'llm.discoverModels',
  'settings.update',
  'settings.replace',
  'settings.mutate',
])

/** API Proxy client whose physical fetch is Electron IPC rather than a network socket. */
export class ElectronApiClient extends AbstractApiClient {
  protected override resolveBase(): string {
    return DESKTOP_RENDERER_ORIGIN
  }

  protected override onEnvelope(message: RpcMessage): void {
    if (message.type === 'client-request' && SECRET_METHODS.has(message.method)) return
    super.onEnvelope(message)
  }

  protected override async doFetch(input: URL, init?: RequestInit): Promise<Response> {
    assertDesktopTarget(input)
    if (init?.method === undefined || init.method === 'GET') return this.openStream(input, init?.signal ?? undefined)
    if (init.method !== 'POST' || typeof init.body !== 'string') {
      throw new Error('desktop carrier accepts JSON POST requests only')
    }
    const requestId = crypto.randomUUID()
    const body = new TextEncoder().encode(init.body)
    const request: DesktopUnaryRequest = {
      version: DESKTOP_PROTOCOL_VERSION,
      requestId,
      url: input.href,
      method: 'POST',
      headers: [...new Headers(init.headers).entries()],
      body: body.buffer,
    }
    const signal = init.signal ?? undefined
    const abort = (): void => { window.dshDesktop.cancel(requestId) }
    if (signal?.aborted === true) throw abortReason(signal)
    const response = await waitForAbort(window.dshDesktop.request(request), signal, abort)
    return new Response(response.body, { status: response.status, headers: response.headers.map(row => [...row]) })
  }

  private async openStream(input: URL, signal: AbortSignal | undefined): Promise<Response> {
    if (signal?.aborted === true) throw abortReason(signal)
    const opening = window.dshDesktop.openStream(input.href).then((result) => {
      if (!result.ok) throw new Error(result.message)
      const streamId = result.streamId
      if (signal?.aborted === true) window.dshDesktop.closeStream(streamId)
      return streamId
    })
    const streamId = await waitForAbort(opening, signal)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      signal?.removeEventListener('abort', close)
    }
    const close = (): void => {
      if (released) return
      try {
        window.dshDesktop.closeStream(streamId)
      } finally {
        release()
      }
    }
    const first = await waitForAbort(window.dshDesktop.nextStream(streamId), signal, close)
    if (first.type !== 'opened') {
      close()
      throw new Error(first.type === 'error' ? first.message : 'desktop stream closed before opening')
    }
    signal?.addEventListener('abort', close, { once: true })
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const item = await waitForAbort(window.dshDesktop.nextStream(streamId), signal, close)
          if (consumeStreamItem(item, controller)) release()
        } catch (error) {
          close()
          throw error
        }
      },
      cancel: close,
    })
    return new Response(body, { status: first.status, headers: first.headers.map(row => [...row]) })
  }
}

/** Create the injection value consumed by the upstream connection plugin. */
export function createElectronConnectionCarrier(): ConnectionCarrier {
  const api = new ElectronApiClient()
  return { api, rpc: createElectronRpc(), isLoopback: true }
}

function createElectronRpc(): ClientConnectionRpc {
  return {
    async call(channel, endpoint, payload, signal) {
      assertRpcTarget(channel, endpoint)
      const rpcId = RpcId(crypto.randomUUID())
      const message: ClientRequest = { type: 'client-request', rpcId, method: endpoint, payload }
      const requestId = crypto.randomUUID()
      const encoded = new TextEncoder().encode(JSON.stringify(message))
      const request: DesktopUnaryRequest = {
        version: DESKTOP_PROTOCOL_VERSION,
        requestId,
        url: `${DESKTOP_RENDERER_ORIGIN}${channel}/${endpoint}`,
        method: 'POST',
        headers: [['content-type', 'application/json']],
        body: encoded.buffer,
      }
      const abort = (): void => { window.dshDesktop.cancel(requestId) }
      if (signal?.aborted === true) throw abortReason(signal)
      const raw = await waitForAbort(window.dshDesktop.request(request), signal, abort)
      if (raw.status < 200 || raw.status >= 300) {
        throw new Error(`desktop RPC transport failure: HTTP ${String(raw.status)}`)
      }
      const response = serverResponseSchema.parse(JSON.parse(new TextDecoder().decode(raw.body))) as ServerResponse
      if (response.rpcId !== rpcId) throw new Error(`desktop RPC correlation mismatch for ${endpoint}`)
      return response.result
    },
  }
}

function consumeStreamItem(item: DesktopStreamItem, controller: ReadableStreamDefaultController<Uint8Array>): boolean {
  switch (item.type) {
    case 'chunk':
      controller.enqueue(new Uint8Array(item.data))
      return false
    case 'end':
      controller.close()
      return true
    case 'error':
      controller.error(new Error(item.message))
      return true
    case 'opened':
      throw new Error('desktop stream emitted duplicate open metadata')
  }
}

function assertDesktopTarget(url: URL): void {
  if (!isDesktopRendererUrl(url) || url.search !== '' || url.hash !== ''
    || !url.pathname.startsWith('/api/')) {
    throw new Error('desktop carrier rejected target')
  }
}

function assertRpcTarget(channel: string, endpoint: string): void {
  if (!/^\/[A-Za-z0-9._~-]+$/.test(channel)
    || endpoint.length === 0
    || endpoint.split('/').some(segment => segment === '.' || segment === '..'
      || !/^[A-Za-z0-9_$.-]+$/.test(segment))) {
    throw new Error('desktop carrier rejected malformed RPC target')
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('desktop request aborted')
}

async function waitForAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  cancel?: () => void,
): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) {
    cancel?.()
    throw abortReason(signal)
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      cancel?.()
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort)
    })
  })
}
