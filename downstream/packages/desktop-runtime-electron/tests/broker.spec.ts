import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopUnaryRequest } from '@acosmi/dsh-desktop-carrier-electron/protocol'
import {
  DESKTOP_PROTOCOL_VERSION,
  MAX_DESKTOP_HOST_CALLS,
  MAX_DESKTOP_PENDING_CALLS,
} from '@acosmi/dsh-desktop-carrier-electron/protocol'
import type { DesktopSecretVault } from '@acosmi/dsh-desktop-secrets/vault'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

import { DesktopUtilityBroker } from '../src/broker.ts'

class FakeUtility extends EventEmitter {
  readonly messages: unknown[] = []
  throwOnPost = false
  killCalls = 0
  postMessage(message: unknown): void {
    if (this.throwOnPost) throw new Error('transport closed')
    this.messages.push(message)
  }
  kill(): boolean {
    this.killCalls += 1
    queueMicrotask(() => { this.emit('exit', 0) })
    return true
  }
}

const vault: DesktopSecretVault = {
  persistence: 'session-memory',
  get: async () => undefined,
  set: async () => undefined,
  delete: async () => undefined,
}

const request: DesktopUnaryRequest = {
  version: DESKTOP_PROTOCOL_VERSION,
  requestId: '01234567-89ab-cdef',
  url: 'app://dsh-gui/api/demo.call',
  method: 'POST',
  headers: [],
  body: new ArrayBuffer(0),
}

describe('desktop utility broker capacity', () => {
  it('bridges only the official DeepSeek environment credential', async () => {
    const child = new FakeUtility()
    new DesktopUtilityBroker(child as never, vault, () => undefined)
    const old = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = 'environment-value'
    try {
      child.emit('message', {
        type: 'secret-request',
        callId: '00000000-0000-4000-8000-000000000001',
        operation: 'environment-get',
        key: 'DEEPSEEK_API_KEY',
      })
      child.emit('message', {
        type: 'secret-request',
        callId: '00000000-0000-4000-8000-000000000002',
        operation: 'environment-has',
        key: 'DEEPSEEK_API_KEY',
      })
      child.emit('message', {
        type: 'secret-request',
        callId: '00000000-0000-4000-8000-000000000003',
        operation: 'environment-get',
        key: 'OTHER_TOKEN',
      })
      await vi.waitFor(() => expect(child.messages).toHaveLength(3))
      expect(child.messages).toContainEqual({
        type: 'host-reply',
        callId: '00000000-0000-4000-8000-000000000001',
        ok: true,
        value: 'environment-value',
      })
      expect(child.messages).toContainEqual({
        type: 'host-reply',
        callId: '00000000-0000-4000-8000-000000000002',
        ok: true,
        value: true,
      })
      expect(child.messages).toContainEqual({
        type: 'host-reply',
        callId: '00000000-0000-4000-8000-000000000003',
        ok: true,
        value: undefined,
      })
    } finally {
      if (old === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = old
    }
  })

  it('bounds renderer operations while reserving shutdown capacity', async () => {
    const child = new FakeUtility()
    const broker = new DesktopUtilityBroker(child as never, vault, () => undefined)
    child.emit('message', { type: 'ready' })
    await broker.ready()

    const pending = Array.from({ length: MAX_DESKTOP_PENDING_CALLS }, () => broker.request(request))
    await expect(broker.request(request)).rejects.toThrow(/too many pending operations/)
    const shutdown = broker.shutdown(1_000)
    expect(child.messages).toHaveLength(MAX_DESKTOP_PENDING_CALLS + 1)

    const shutdownMessage = child.messages.at(-1) as { callId: string }
    child.emit('message', { type: 'reply', callId: shutdownMessage.callId, ok: true, value: undefined })
    await shutdown
    expect(child.killCalls).toBe(1)
    await Promise.all(pending.map(operation => operation.catch(() => undefined)))
  })

  it('shares one graceful shutdown and one termination across concurrent callers', async () => {
    const child = new FakeUtility()
    const broker = new DesktopUtilityBroker(child as never, vault, () => undefined)
    child.emit('message', { type: 'ready' })
    await broker.ready()

    const left = broker.shutdown(1_000)
    const right = broker.shutdown(5_000)
    expect(right).toBe(left)
    expect(child.messages).toHaveLength(1)

    const request = child.messages[0] as { callId: string }
    child.emit('message', { type: 'reply', callId: request.callId, ok: true, value: undefined })
    await Promise.all([left, right])
    expect(child.killCalls).toBe(1)
  })

  it('reaches quiescence when shutdown starts before the Host is ready', async () => {
    const child = new FakeUtility()
    const broker = new DesktopUtilityBroker(child as never, vault, () => undefined)

    const shutdown = broker.shutdown(1_000)
    expect(child.messages).toHaveLength(1)
    const request = child.messages[0] as { callId: string }
    expect(child.messages[0]).toMatchObject({ type: 'shutdown' })
    child.emit('message', { type: 'reply', callId: request.callId, ok: true, value: undefined })

    await shutdown
    expect(child.killCalls).toBe(1)
    await expect(broker.ready()).rejects.toThrow(/desktop Host exited/)
  })

  it('closes the owner and drains privileged operations before successful shutdown', async () => {
    const child = new FakeUtility()
    const operation = Promise.withResolvers<void>()
    const owner = { destroy: vi.fn(), isDestroyed: () => false }
    const get = vi.fn(async () => operation.promise.then(() => undefined))
    const broker = new DesktopUtilityBroker(child as never, {
      ...vault,
      get,
    }, () => owner as never)
    child.emit('message', { type: 'ready' })
    await broker.ready()
    child.emit('message', {
      type: 'secret-request',
      callId: '00000000-0000-4000-8000-000000000005',
      operation: 'get',
      key: 'sdk:token',
    })
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce())

    const shutdown = broker.shutdown(1_000)
    expect(owner.destroy).toHaveBeenCalledOnce()
    const shutdownMessage = child.messages.at(-1) as { callId: string }
    child.emit('message', { type: 'reply', callId: shutdownMessage.callId, ok: true, value: undefined })
    await new Promise(resolve => setImmediate(resolve))
    expect(child.killCalls).toBe(0)

    operation.resolve()
    await shutdown
    expect(child.killCalls).toBe(1)
  })

  it('removes a pending entry when transport dispatch throws', async () => {
    const child = new FakeUtility()
    const broker = new DesktopUtilityBroker(child as never, vault, () => undefined)
    child.emit('message', { type: 'ready' })
    await broker.ready()
    child.throwOnPost = true
    await expect(broker.request(request)).rejects.toThrow(/could not be dispatched/)
    child.throwOnPost = false
    const operation = broker.request(request)
    const message = child.messages[0] as { callId: string }
    child.emit('message', { type: 'reply', callId: message.callId, ok: false })
    await expect(operation).rejects.toThrow(/operation failed/)
  })

  it('rejects a malformed successful utility reply before renderer delivery', async () => {
    const child = new FakeUtility()
    const broker = new DesktopUtilityBroker(child as never, vault, () => undefined)
    child.emit('message', { type: 'ready' })
    await broker.ready()
    const operation = broker.request(request)
    const message = child.messages[0] as { callId: string }
    child.emit('message', { type: 'reply', callId: message.callId, ok: true, value: { status: 200 } })
    await expect(operation).rejects.toThrow(/malformed unary response/)
  })

  it('rejects a utility reply with additional envelope fields', async () => {
    const child = new FakeUtility()
    const broker = new DesktopUtilityBroker(child as never, vault, () => undefined)
    child.emit('message', { type: 'ready' })
    await broker.ready()
    const operation = broker.request(request)
    const message = child.messages[0] as { callId: string }
    child.emit('message', {
      type: 'reply',
      callId: message.callId,
      ok: true,
      value: {
        version: DESKTOP_PROTOCOL_VERSION,
        status: 200,
        headers: [],
        body: new ArrayBuffer(0),
      },
      ignored: true,
    })
    await expect(operation).rejects.toThrow(/operation failed/)
  })

  it('independently bounds privileged main-process operations', async () => {
    const child = new FakeUtility()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const get = vi.fn(async () => gate.then(() => undefined))
    new DesktopUtilityBroker(child as never, { ...vault, get }, () => undefined)

    for (let index = 0; index <= MAX_DESKTOP_HOST_CALLS; index += 1) {
      child.emit('message', {
        type: 'secret-request',
        callId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        operation: 'get',
        key: 'credential:DEEPSEEK_API_KEY',
      })
    }
    await vi.waitFor(() => expect(child.messages).toContainEqual({
      type: 'host-reply',
      callId: `00000000-0000-4000-8000-${String(MAX_DESKTOP_HOST_CALLS).padStart(12, '0')}`,
      ok: false,
    }))
    expect(get).toHaveBeenCalledTimes(MAX_DESKTOP_HOST_CALLS)
    release()
    await vi.waitFor(() => expect(child.messages).toHaveLength(MAX_DESKTOP_HOST_CALLS + 1))
  })

  it('rejects extra fields on privileged operation envelopes', async () => {
    const child = new FakeUtility()
    const get = vi.fn(vault.get)
    new DesktopUtilityBroker(child as never, { ...vault, get }, () => undefined)
    child.emit('message', {
      type: 'secret-request',
      callId: '00000000-0000-4000-8000-000000000000',
      operation: 'get',
      key: 'credential:DEEPSEEK_API_KEY',
      ignored: true,
    })
    await vi.waitFor(() => expect(child.messages).toEqual([{
      type: 'host-reply',
      callId: '00000000-0000-4000-8000-000000000000',
      ok: false,
    }]))
    expect(get).not.toHaveBeenCalled()
  })

  it('drops best-effort cancellation and stream closure after transport failure', async () => {
    const child = new FakeUtility()
    const broker = new DesktopUtilityBroker(child as never, vault, () => undefined)
    child.emit('message', { type: 'ready' })
    await broker.ready()
    child.throwOnPost = true
    expect(() => broker.cancel('01234567-89ab-cdef')).not.toThrow()
    expect(() => broker.closeStream('01234567-89ab-cdef')).not.toThrow()
    child.emit('exit', 0)
    expect(() => broker.cancel('01234567-89ab-cdef')).not.toThrow()
    expect(() => broker.closeStream('01234567-89ab-cdef')).not.toThrow()
  })

  it('drops a privileged-operation reply when the utility transport closes', async () => {
    const child = new FakeUtility()
    new DesktopUtilityBroker(child as never, vault, () => undefined)
    child.throwOnPost = true
    child.emit('message', {
      type: 'secret-request',
      callId: '00000000-0000-4000-8000-000000000004',
      operation: 'get',
      key: 'credential:DEEPSEEK_API_KEY',
    })
    await new Promise(resolve => setImmediate(resolve))
    expect(child.messages).toEqual([])
  })
})
