import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyConnection } from '@deepseek-ai/dsh-client-connection/client'
import { RpcId, type ClientRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  desktopRpcFetch,
  ElectronApiClient,
  installElectronTransport,
} from '../src/client.ts'
import { DesktopHostConnection } from '../src/index.ts'
import { DESKTOP_PROTOCOL_VERSION, type DesktopPreloadBridge, type DesktopUnaryRequest } from '../src/protocol.ts'

function bridge(handler: (request: DesktopUnaryRequest) => Promise<Response>): DesktopPreloadBridge {
  return {
    version: DESKTOP_PROTOCOL_VERSION,
    async request(request) {
      const response = await handler(request)
      return {
        version: DESKTOP_PROTOCOL_VERSION,
        status: response.status,
        headers: [...response.headers.entries()],
        body: await response.arrayBuffer(),
      }
    },
    cancel: vi.fn(),
    openStream: vi.fn(),
    nextStream: vi.fn(),
    closeStream: vi.fn(),
    productInfo: vi.fn(),
    checkForUpdates: vi.fn(),
  }
}

class TestElectronApiClient extends ElectronApiClient {
  openEventStream(signal: AbortSignal): Promise<Response> {
    return this.doFetch(new URL('app://dsh-gui/api/events.mux'), { signal })
  }
}

afterEach(() => {
  delete (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
  vi.unstubAllGlobals()
})

async function mountedDesktopRpc(desktop: DesktopPreloadBridge) {
  vi.stubGlobal('window', { dshDesktop: desktop })
  vi.stubGlobal('location', { hostname: 'dsh-gui', protocol: 'app:', search: '', origin: 'null' })
  installElectronTransport()
  const ctx = new Context()
  await ctx.plugin({ apply: applyConnection, inject: [] })
  const handle = ctx.get('connection')
  if (handle === undefined) throw new Error('ctx.connection not provided')
  return handle.rpc
}

describe('renderer Electron carrier', () => {
  it('carries generic RPC with correlation and rejects malformed targets', async () => {
    const requestSpy = vi.fn(async (request: DesktopUnaryRequest) => {
      const message = JSON.parse(new TextDecoder().decode(request.body)) as ClientRequest
      return Response.json({
        type: 'server-response',
        rpcId: message.rpcId,
        result: { ok: true, value: { accepted: message.payload } },
      })
    })
    const rpc = await mountedDesktopRpc(bridge(requestSpy))
    await expect(rpc.call('/acosmi', 'account/describe', { value: 1 }))
      .resolves.toEqual({ ok: true, value: { accepted: { value: 1 } } })
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      url: 'app://dsh-gui/acosmi/account/describe',
      method: 'POST',
    }))
    await expect(rpc.call('bad', 'describe', {})).rejects.toThrow(/invalid RPC target/)
    await expect(rpc.call('/acosmi', '../secret', {})).rejects.toThrow(/invalid RPC target/)
    await expect(desktopRpcFetch(new URL('https://example.test/acosmi/describe'), {
      method: 'POST',
      body: '{}',
    })).rejects.toThrow(/rejected target/)
  })

  it('carries Typert /api namespace methods and rejects API Proxy unary paths', async () => {
    const requestSpy = vi.fn(async (request: DesktopUnaryRequest) => {
      const message = JSON.parse(new TextDecoder().decode(request.body)) as ClientRequest
      return Response.json({
        type: 'server-response',
        rpcId: message.rpcId,
        result: { ok: true, value: { accepted: message.payload } },
      })
    })
    const rpc = await mountedDesktopRpc(bridge(requestSpy))
    await expect(rpc.call('/api', 'pluginInventory/list', { value: 1 }))
      .resolves.toEqual({ ok: true, value: { accepted: { value: 1 } } })
    await expect(rpc.call('/api', 'acosmiAccount/describe', {}))
      .resolves.toEqual({ ok: true, value: { accepted: {} } })
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      url: 'app://dsh-gui/api/pluginInventory/list',
      method: 'POST',
    }))
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      url: 'app://dsh-gui/api/acosmiAccount/describe',
      method: 'POST',
    }))
    await expect(desktopRpcFetch(new URL('app://dsh-gui/api/host.describe'), {
      method: 'POST',
      body: '{}',
    })).rejects.toThrow(/rejected target/)
    await expect(desktopRpcFetch(new URL('app://dsh-gui/api/events.mux'), {
      method: 'POST',
      body: '{}',
    })).rejects.toThrow(/rejected target/)
  })

  it('suppresses secret-bearing credential and model-discovery envelopes without changing transport bytes', async () => {
    const received: ClientRequest[] = []
    vi.stubGlobal('window', { dshDesktop: bridge(async request => {
      const message = JSON.parse(new TextDecoder().decode(request.body)) as ClientRequest
      received.push(message)
      return Response.json({
        type: 'server-response',
        rpcId: message.rpcId,
        result: {
          ok: true,
          value: message.method === 'llm.discoverModels' ? { models: [] } : {},
        },
      })
    }) })
    const api = new ElectronApiClient()
    const batches: unknown[] = []
    api.subscribeEnvelopes(batch => { batches.push(...batch) })
    await expect(api.credentials.set({ ref: 'DEEPSEEK_API_KEY', value: 'top-secret' }))
      .resolves.toMatchObject({ result: { ok: true } })
    await expect(api.llm.discoverModels({
      settingsNs: 'llm-deepseek',
      apiKey: 'discovery-secret',
    })).resolves.toMatchObject({ result: { ok: true, value: { models: [] } } })
    await Promise.resolve()
    expect(received).toHaveLength(2)
    expect(received[0]).toMatchObject({ method: 'credentials.set', payload: { value: 'top-secret' } })
    expect(received[1]).toMatchObject({
      method: 'llm.discoverModels',
      payload: { apiKey: 'discovery-secret' },
    })
    expect(JSON.stringify(batches)).not.toContain('top-secret')
    expect(JSON.stringify(batches)).not.toContain('discovery-secret')
    expect(JSON.stringify(batches)).not.toContain('credentials.set')
    expect(JSON.stringify(batches)).not.toContain('llm.discoverModels')
  })

  it('propagates cancellation to preload and rejects mismatched RPC responses', async () => {
    let settle!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { settle = resolve })
    const desktop = bridge(() => pending)
    const rpc = await mountedDesktopRpc(desktop)
    const controller = new AbortController()
    const call = rpc.call('/acosmi', 'describe', {}, controller.signal)
    controller.abort(new Error('stop'))
    await expect(call).rejects.toThrow('stop')
    expect(desktop.cancel).toHaveBeenCalledTimes(1)
    settle(Response.json({
      type: 'server-response',
      rpcId: RpcId('different-correlation'),
      result: { ok: true, value: {} },
    }))

    delete (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
    const mismatched = await mountedDesktopRpc(bridge(async () => Response.json({
      type: 'server-response',
      rpcId: RpcId('different-correlation'),
      result: { ok: true, value: {} },
    })))
    await expect(mismatched.call('/acosmi', 'describe', {}))
      .rejects.toThrow(/rpcId mismatch/)
  })

  it('detaches the abort listener after a stream ends naturally', async () => {
    const desktop = bridge(async () => new Response())
    desktop.openStream = vi.fn(async () => ({ ok: true, streamId: '01234567-89ab-cdef' }))
    desktop.nextStream = vi.fn()
      .mockResolvedValueOnce({ type: 'opened', status: 200, headers: [] })
      .mockResolvedValueOnce({ type: 'end' })
    vi.stubGlobal('window', { dshDesktop: desktop })
    const controller = new AbortController()

    const response = await new TestElectronApiClient().openEventStream(controller.signal)
    await expect(response.body?.getReader().read()).resolves.toEqual({ done: true, value: undefined })
    controller.abort(new Error('late abort'))

    expect(desktop.closeStream).not.toHaveBeenCalled()
  })

  it('rejects a contained stream-open failure before pulling stream items', async () => {
    const desktop = bridge(async () => new Response())
    desktop.openStream = vi.fn(async () => ({
      ok: false,
      message: 'The desktop Host could not complete this operation.',
    }))
    vi.stubGlobal('window', { dshDesktop: desktop })

    await expect(new TestElectronApiClient().openEventStream(new AbortController().signal))
      .rejects.toThrow('The desktop Host could not complete this operation.')
    expect(desktop.nextStream).not.toHaveBeenCalled()
    expect(desktop.closeStream).not.toHaveBeenCalled()
  })
})

describe('utility-process Host carrier', () => {
  it('dispatches registered trusted channels and falls back for unclaimed application routes', async () => {
    const context = new Context()
    const connection = new DesktopHostConnection(context)
    const remove = connection.rpc.handle('/acosmi', async (endpoint, payload) => ({
      ok: true,
      value: { endpoint, payload },
    }), { authority: 'trusted-host' })
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('01234567-89ab-cdef'),
      method: 'account/describe',
      payload: { test: true },
    }
    const response = await connection.fetch(new Request('app://dsh-gui/acosmi/account/describe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }), async () => new Response('fallback', { status: 299 }))
    expect(await response.json()).toEqual({
      type: 'server-response',
      rpcId: '01234567-89ab-cdef',
      result: { ok: true, value: { endpoint: 'account/describe', payload: { test: true } } },
    })

    await remove()
    const fallback = await connection.fetch(new Request('app://dsh-gui/acosmi/account/describe', {
      method: 'POST',
    }), async () => new Response('fallback', { status: 299 }))
    expect(fallback.status).toBe(299)
    await context.fiber.dispose()
  })

  it('dispatches the complete generic channel alphabet without accepting path aliases', async () => {
    const context = new Context()
    const connection = new DesktopHostConnection(context)
    const remove = connection.rpc.handle('/rpc~v1', async () => ({ ok: true, value: 'handled' }), {
      authority: 'loopback',
    })
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('01234567-89ab-cdef'),
      method: 'demo.call',
      payload: null,
    }
    const dispatch = (pathname: string): Promise<Response> => connection.fetch(new Request(`app://dsh-gui${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }), async () => new Response('fallback', { status: 299 }))

    await expect(dispatch('/rpc~v1/demo.call').then(response => response.json()))
      .resolves.toMatchObject({ result: { ok: true, value: 'handled' } })
    await expect(dispatch('/rpc~v1//demo.call').then(response => response.status)).resolves.toBe(404)
    await expect(dispatch('/rpc~v1/demo.call/').then(response => response.status)).resolves.toBe(404)
    await remove()
    await context.fiber.dispose()
  })

  it('claims Typert /api namespace methods and falls back for API Proxy methods', async () => {
    const context = new Context()
    const connection = new DesktopHostConnection(context)
    const remove = connection.rpc.intercept(
      '/api',
      endpoint => endpoint.includes('/'),
      async (endpoint, payload) => ({ ok: true, value: { endpoint, payload } }),
      { authority: 'trusted-host' },
    )
    const inventory: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('01234567-89ab-cdef'),
      method: 'pluginInventory/list',
      payload: { test: true },
    }
    const claimed = await connection.fetch(new Request('app://dsh-gui/api/pluginInventory/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(inventory),
    }), async () => new Response('fallback', { status: 299 }))
    expect(await claimed.json()).toEqual({
      type: 'server-response',
      rpcId: '01234567-89ab-cdef',
      result: { ok: true, value: { endpoint: 'pluginInventory/list', payload: { test: true } } },
    })

    const describe: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('01234567-89ab-cdef'),
      method: 'host.describe',
      payload: null,
    }
    const fallback = await connection.fetch(new Request('app://dsh-gui/api/host.describe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(describe),
    }), async () => new Response('fallback', { status: 299 }))
    expect(fallback.status).toBe(299)
    await remove()
    await context.fiber.dispose()
  })

  it('rejects malformed channels, methods, envelopes, and duplicate registration', async () => {
    const context = new Context()
    const connection = new DesktopHostConnection(context)
    expect(() => connection.rpc.handle('bad', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
    })).toThrow(/rejected channel/)
    const remove = connection.rpc.handle('/safe', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
    })
    expect(() => connection.rpc.handle('/safe', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
    })).toThrow(/already registered/)
    const malformed = await connection.fetch(new Request('app://dsh-gui/safe/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    }), async () => new Response('fallback'))
    expect(malformed.status).toBe(400)
    const unknown = await connection.fetch(new Request('app://dsh-gui/only-one-part'), async () => new Response('fallback'))
    expect(unknown.status).toBe(404)
    await remove()
    await context.fiber.dispose()
  })
})
