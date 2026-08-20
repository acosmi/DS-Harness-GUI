// @vitest-environment jsdom
/** Account foreground-resume registration. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcosmiAccountStore } from '../src/client/store.ts'
import { apply } from '../src/client/index.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Acosmi account foreground refresh', () => {
  it('registers the bare account store and refreshes on focus only while the plugin is live', () => {
    const disposers: Array<() => void> = []
    const registrations: Array<{ inject?: () => unknown }> = []
    const resume = vi.spyOn(AcosmiAccountStore.prototype, 'resume').mockResolvedValue()
    const ctx = {
      effect(factory: () => unknown) {
        const disposer = factory()
        if (typeof disposer === 'function') disposers.push(disposer as () => void)
        return disposer
      },
      locale: {
        register: () => () => undefined,
        bind: () => (key: string) => key,
      },
      get: () => ({ api: {} }),
      remote: { acosmiAccount: {} },
      on: () => () => undefined,
      sessions: {
        list: {
          getSnapshot: () => ({ current: undefined }),
          subscribe: () => () => undefined,
        },
      },
      modelDirectories: {},
      logger: { warn: vi.fn() },
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        register: (options: { inject?: () => unknown }) => {
          registrations.push(options)
          return () => undefined
        },
      },
    }

    apply(ctx as never)
    expect(registrations).toHaveLength(2)
    for (const registration of registrations) {
      const face = registration.inject?.() as {
        controller: AcosmiAccountStore
        hooks: { snapshot: AcosmiAccountStore['store'] }
        useSnapshot?: unknown
      }
      expect(face.hooks.snapshot).toBe(face.controller.store)
      expect(face.useSnapshot).toBeUndefined()
    }
    window.dispatchEvent(new Event('focus'))
    expect(resume).toHaveBeenCalledOnce()

    for (const dispose of disposers.reverse()) dispose()
    window.dispatchEvent(new Event('focus'))
    expect(resume).toHaveBeenCalledOnce()
  })
})
