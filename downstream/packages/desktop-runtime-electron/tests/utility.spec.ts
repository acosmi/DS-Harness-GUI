import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { DesktopUtilityController } from '../src/utility.ts'

class FakeParentPort extends EventEmitter {
  readonly messages: unknown[] = []

  postMessage(message: unknown): void {
    this.messages.push(message)
  }

  send(data: unknown): void {
    this.emit('message', { data })
  }
}

describe('desktop utility shutdown', () => {
  it('aborts and settles a late stream open before reporting shutdown complete', async () => {
    const port = new FakeParentPort()
    const controller = new DesktopUtilityController(port as never)
    const response = Promise.withResolvers<Response>()
    const started = Promise.withResolvers<AbortSignal>()
    const cancel = vi.fn()
    Object.assign(controller, {
      connection: {
        fetch: (request: Request, fallback: (request: Request) => Promise<Response>) => fallback(request),
      },
      fallback: async (request: Request) => {
        started.resolve(request.signal)
        return response.promise
      },
    })

    port.send({ type: 'stream-open', callId: 'open-call', url: 'app://dsh-gui/api/events.host' })
    const signal = await started.promise
    port.send({ type: 'shutdown', callId: 'shutdown-call' })
    expect(signal.aborted).toBe(true)

    response.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })))
    await vi.waitFor(() => expect(port.messages).toHaveLength(2))

    expect(cancel).toHaveBeenCalledOnce()
    expect(port.messages).toContainEqual({
      type: 'reply',
      callId: 'open-call',
      ok: false,
      error: 'The desktop Host could not complete this operation.',
    })
    expect(port.messages).toContainEqual({
      type: 'reply',
      callId: 'shutdown-call',
      ok: true,
      value: undefined,
    })
  })

  it('shares one shutdown transaction across concurrent lifecycle requests', async () => {
    const port = new FakeParentPort()
    const controller = new DesktopUtilityController(port as never)

    port.send({ type: 'shutdown', callId: 'left' })
    port.send({ type: 'shutdown', callId: 'right' })

    await vi.waitFor(() => expect(port.messages).toHaveLength(2))
    expect(port.messages).toEqual(expect.arrayContaining([
      { type: 'reply', callId: 'left', ok: true, value: undefined },
      { type: 'reply', callId: 'right', ok: true, value: undefined },
    ]))
  })

  it('keeps the main-process bridge open until plugin disposal finishes', async () => {
    const port = new FakeParentPort()
    const controller = new DesktopUtilityController(port as never)
    const cleanupStarted = Promise.withResolvers<void>()
    const privateController = controller as unknown as {
      hostCall(type: string, fields: Record<string, unknown>): Promise<unknown>
    }
    Object.assign(controller, {
      ctx: {
        fiber: {
          dispose: async () => {
            const cleanup = privateController.hostCall('secret-request', {
              operation: 'delete',
              key: 'sdk:token',
            })
            cleanupStarted.resolve()
            await cleanup
          },
        },
      },
    })

    port.send({ type: 'shutdown', callId: 'shutdown-call' })
    await cleanupStarted.promise
    const cleanup = port.messages[0] as { callId: string }
    expect(port.messages[0]).toMatchObject({
      type: 'secret-request',
      operation: 'delete',
      key: 'sdk:token',
    })
    port.send({ type: 'host-reply', callId: cleanup.callId, ok: true, value: undefined })

    await vi.waitFor(() => expect(port.messages).toContainEqual({
      type: 'reply',
      callId: 'shutdown-call',
      ok: true,
      value: undefined,
    }))
  })
})
