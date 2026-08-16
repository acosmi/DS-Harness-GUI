// @vitest-environment jsdom
/** Account foreground-resume registration. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcosmiAccountStore } from '../src/client/store.ts'
import { apply } from '../src/client/index.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Acosmi account foreground refresh', () => {
  it('refreshes on window focus only while the client plugin is live', () => {
    const disposers: Array<() => void> = []
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
      slots: { inject: vi.fn() },
    }

    apply(ctx as never)
    window.dispatchEvent(new Event('focus'))
    expect(resume).toHaveBeenCalledOnce()

    for (const dispose of disposers.reverse()) dispose()
    window.dispatchEvent(new Event('focus'))
    expect(resume).toHaveBeenCalledOnce()
  })
})
