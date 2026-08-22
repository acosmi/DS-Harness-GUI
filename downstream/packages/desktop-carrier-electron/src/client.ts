/** Browser-side API Proxy and generic RPC carrier over the isolated preload API. */

import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { RpcFetch } from '@deepseek-ai/dsh-client-connection/client'
import type { RpcMessage } from '@deepseek-ai/dsh-host-apiproxy/api'
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

/** Official connection plugin uses this host when `location.origin` is null. */
const INTERNAL_RPC_ORIGIN = 'http://dsh.internal'

interface DesktopTransportGlobal {
  __DSH_TRANSPORT__?: {
    createApiClient(): ElectronApiClient
    fetch: RpcFetch
  }
}

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
    assertDesktopApiTarget(input)
    if (init?.method === undefined || init.method === 'GET') return this.openStream(input, init?.signal ?? undefined)
    return postDesktopUnary(input, init)
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

/**
 * Install the official `__DSH_TRANSPORT__` hooks so the upstream connection
 * plugin uses Electron IPC instead of HTTP and WebSocket.
 * @returns disposer that removes the hooks.
 */
export function installElectronTransport(): () => void {
  const target = globalThis as DesktopTransportGlobal
  if (target.__DSH_TRANSPORT__ !== undefined) {
    throw new Error('desktop transport is already installed')
  }
  const api = new ElectronApiClient()
  target.__DSH_TRANSPORT__ = {
    createApiClient: () => api,
    fetch: desktopRpcFetch,
  }
  return () => {
    delete target.__DSH_TRANSPORT__
  }
}

/** Unary IPC fetch used as `ClientTransportHooks.fetch` for generic RPC. */
export async function desktopRpcFetch(input: URL, init?: RequestInit): Promise<Response> {
  const url = rewriteInternalRpcUrl(input)
  assertDesktopUnaryTarget(url)
  return postDesktopUnary(url, init)
}

function rewriteInternalRpcUrl(input: URL): URL {
  const internal = new URL(INTERNAL_RPC_ORIGIN)
  if (input.protocol === internal.protocol && input.hostname === internal.hostname) {
    return new URL(`${input.pathname}${input.search}`, `${DESKTOP_RENDERER_ORIGIN}/`)
  }
  return input
}

async function postDesktopUnary(input: URL, init?: RequestInit): Promise<Response> {
  if (init?.method !== 'POST' || typeof init.body !== 'string') {
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

function assertDesktopApiTarget(url: URL): void {
  if (!isDesktopRendererUrl(url) || url.search !== '' || url.hash !== ''
    || !url.pathname.startsWith('/api/')) {
    throw new Error('desktop carrier rejected target')
  }
}

function assertDesktopUnaryTarget(url: URL): void {
  if (!isDesktopRendererUrl(url) || url.search !== '' || url.hash !== '') {
    throw new Error('desktop carrier rejected target')
  }
  if (url.pathname.startsWith('/api/')) {
    throw new Error('desktop carrier rejected target')
  }
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2
    || !/^[A-Za-z0-9._~-]+$/.test(parts[0] ?? '')
    || parts.slice(1).some(part => part === '.' || part === '..' || !/^[A-Za-z0-9_$.-]+$/.test(part))) {
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
