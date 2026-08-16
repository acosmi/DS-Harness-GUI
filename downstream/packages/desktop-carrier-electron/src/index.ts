/** Host-side generic Connection registry and Fetch dispatcher for Electron. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  ConnectionRpcEndpointMatcher,
  ConnectionRpcHandler,
  ConnectionRpcHandlerOptions,
  HostConnectionHandle,
  HostConnectionRpc,
} from '@deepseek-ai/dsh-client-connection'
import {
  RpcId,
  clientRequestSchema,
  type ClientRequest,
  type RpcError,
  type RpcId as RpcIdType,
  type RpcResult,
  type ServerResponse,
} from '@deepseek-ai/dsh-host-apiproxy/api'

interface Registration {
  readonly matches: ConnectionRpcEndpointMatcher
  readonly handler: ConnectionRpcHandler
  readonly options: ConnectionRpcHandlerOptions
}

/** Desktop Host Connection service; physical dispatch is called by the utility-process bridge. */
export class DesktopHostConnection extends Service implements HostConnectionHandle {
  private readonly channels = new Map<string, Registration>()

  /** @param ctx - root context prepared before the plugin tree mounts. */
  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler, options) => this.register(owner, channel, () => true, handler, options),
      intercept: (channel, matches, handler, options) =>
        this.register(owner, channel, matches, handler, options),
    }
  }

  /**
   * Dispatch one validated application request through a registered logical
   * channel or the API Proxy fallback.
   * @param request - application-origin request from main.
   * @param fallback - API Proxy Fetch handler.
   * @returns carrier response.
   */
  async fetch(request: Request, fallback: (request: Request) => Promise<Response>): Promise<Response> {
    const url = new URL(request.url)
    const target = resolveTarget(url.pathname)
    if (target === undefined) return new Response('not found', { status: 404 })
    const registration = this.channels.get(target.channel)
    if (registration === undefined || !registration.matches(target.endpoint)) return fallback(request)
    if (registration.options.authority !== 'loopback' && registration.options.authority !== 'trusted-host') {
      return new Response('forbidden', { status: 403 })
    }
    return dispatchRpc(target.endpoint, request, registration.handler)
  }

  private register(
    owner: Context,
    channel: string,
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    assertChannel(channel)
    return owner.effect(() => {
      if (this.channels.has(channel)) throw new Error(`desktop connection channel ${channel} is already registered`)
      this.channels.set(channel, { matches, handler, options })
      return () => { this.channels.delete(channel) }
    }, `desktop-connection:${channel}`)
  }
}

/** Install the desktop Host connection service in the utility-process tree. */
export function apply(ctx: Context): void {
  new DesktopHostConnection(ctx)
}

async function dispatchRpc(
  endpoint: string,
  request: Request,
  handler: ConnectionRpcHandler,
): Promise<Response> {
  if (request.method !== 'POST' || request.headers.get('content-type')?.split(';', 1)[0] !== 'application/json') {
    return new Response('not found', { status: 404 })
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('body is not JSON', { status: 400 })
  }
  const parsed = clientRequestSchema.safeParse(body)
  if (!parsed.success) return failure(RpcId('invalid-request'), 'bad-request', 'invalid request envelope')
  const message: ClientRequest = parsed.data
  if (message.method !== endpoint) return failure(message.rpcId, 'bad-request', 'method does not match endpoint')
  try {
    return response(message.rpcId, await handler(endpoint, message.payload, request.signal))
  } catch {
    return failure(message.rpcId, 'internal', 'desktop RPC handler failed')
  }
}

function response(rpcId: RpcIdType, result: RpcResult<unknown>): Response {
  const body: ServerResponse = { type: 'server-response', rpcId, result }
  return Response.json(body)
}

function failure(rpcId: RpcIdType, code: RpcError['code'], message: string): Response {
  const details = code === 'bad-request' ? { issues: [] } : {}
  return response(rpcId, { ok: false, error: { code, message, details } as RpcError })
}

function resolveTarget(pathname: string): { channel: string; endpoint: string } | undefined {
  if (!pathname.startsWith('/')) return undefined
  const parts = pathname.slice(1).split('/')
  if (parts.length < 2
    || !/^[A-Za-z0-9._~-]+$/.test(parts[0] ?? '')
    || parts.slice(1).some(part => !/^[A-Za-z0-9_$.-]+$/.test(part))) return undefined
  return { channel: `/${parts[0]}`, endpoint: parts.slice(1).join('/') }
}

function assertChannel(channel: string): void {
  if (!/^\/[A-Za-z0-9._~-]+$/.test(channel)) throw new Error(`desktop connection rejected channel ${channel}`)
}
