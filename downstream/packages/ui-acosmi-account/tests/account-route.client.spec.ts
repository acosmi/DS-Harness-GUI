// @vitest-environment jsdom
/** Login-time account model routing. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { AcosmiAccountStore } from '../src/client/store.ts'

const READY = {
  status: 'ready' as const,
  loginAvailable: true,
  label: 'Acosmi member',
  modelStatus: 'ok',
  pollAfterMs: 60_000,
  updatedAt: 1,
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function loginRemote(): never {
  const result = async () => ({ ok: true, value: { ok: true, account: READY } })
  return {
    describe: async () => ({ ok: true, value: READY }),
    login: result,
    logout: result,
    refresh: result,
  } as never
}

function pluginCtx(options: {
  configured?: boolean
  load: () => Promise<unknown>
  select: (selection: { provider: string; model: string }) => Promise<void>
  current?: string
}) {
  const listListeners: Array<() => void> = []
  const registrations: Array<{ inject?: () => { controller: AcosmiAccountStore } }> = []
  const ctx = {
    effect(factory: () => unknown) {
      const disposer = factory()
      return typeof disposer === 'function' ? disposer : () => undefined
    },
    locale: {
      register: () => () => undefined,
      bind: () => (key: string) => key,
    },
    get: () => ({
      api: {
        credentials: {
          describe: async () => ({
            result: {
              ok: true,
              value: {
                credentials: {
                  DEEPSEEK_API_KEY: { configured: options.configured === true },
                },
              },
            },
          }),
        },
      },
    }),
    remote: { acosmiAccount: loginRemote() },
    on: () => () => undefined,
    sessions: {
      list: {
        getSnapshot: () => ({ current: options.current ?? 'session-1' }),
        subscribe: (fn: () => void) => {
          listListeners.push(fn)
          return () => undefined
        },
      },
    },
    modelDirectories: {
      directoryFor: () => ({
        load: options.load,
        select: options.select,
        store: {
          subscribe: () => () => undefined,
          getSnapshot: () => ({ groups: [], current: null, routable: null }),
        },
      }),
    },
    logger: { warn: vi.fn() },
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register: (face: { inject?: () => { controller: AcosmiAccountStore } }) => {
        registrations.push(face)
        return () => undefined
      },
    },
  }
  return { ctx, listListeners, registrations }
}

describe('Acosmi login model routing', () => {
  it('selects the first account model when the official API key is absent', async () => {
    const load = vi.fn(async () => ({
      current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      routable: true,
      groups: [{ id: 'acosmi', name: 'Acosmi', models: [{ id: 'm1', name: 'M1' }] }],
      failures: [],
    }))
    const select = vi.fn(async () => undefined)
    const { ctx, registrations } = pluginCtx({ load, select })
    apply(ctx as never)
    const { controller } = registrations[0]!.inject!()
    await controller.act('login')
    expect(select).toHaveBeenCalledWith({ provider: 'acosmi', model: 'm1' })
  })

  it('leaves a configured official API route in place', async () => {
    const load = vi.fn()
    const select = vi.fn(async () => undefined)
    const { ctx, registrations } = pluginCtx({ configured: true, load, select })
    apply(ctx as never)
    const { controller } = registrations[0]!.inject!()
    await controller.act('login')
    expect(load).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
  })

  it('does not retry automatic routing after the catalog wait fails', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async () => ({
      current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      routable: true,
      groups: [],
      failures: [],
    }))
    const select = vi.fn(async () => undefined)
    const { ctx, listListeners, registrations } = pluginCtx({ load, select })
    apply(ctx as never)
    const { controller } = registrations[0]!.inject!()
    const login = controller.act('login')
    await vi.runAllTimersAsync()
    await login
    const loads = load.mock.calls.length
    for (const listener of listListeners) listener()
    await Promise.resolve()
    expect(select).not.toHaveBeenCalled()
    expect(load).toHaveBeenCalledTimes(loads)
  })
})
