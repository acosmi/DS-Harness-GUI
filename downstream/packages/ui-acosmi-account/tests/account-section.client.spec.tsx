// @vitest-environment jsdom
/** Account settings refresh lifecycle. */

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AcosmiAccountSnapshot } from '@acosmi/dsh-api-remotes-acosmi/client'
import { AccountSection } from '../src/client/AccountSection.tsx'
import type { AcosmiAccountStore, AcosmiAccountUiState } from '../src/client/store.ts'

const READY: AcosmiAccountSnapshot = {
  status: 'ready',
  loginAvailable: true,
  label: 'Acosmi member',
  modelStatus: 'ok',
  pollAfterMs: 60_000,
  updatedAt: 1,
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'dshDesktop')
})

describe('Acosmi account settings lifecycle', () => {
  it('refreshes on page open and polls the latest Host projection while the account is active', async () => {
    vi.useFakeTimers()
    Object.defineProperty(window, 'dshDesktop', {
      configurable: true,
      value: { productInfo: async () => ({ ok: false }) },
    })
    const resume = vi.fn(async () => undefined)
    const load = vi.fn(async () => undefined)
    const controller = {
      resume,
      load,
      act: vi.fn(async () => undefined),
    } as unknown as AcosmiAccountStore
    const state: AcosmiAccountUiState = {
      phase: 'ready',
      account: READY,
      busy: null,
      error: null,
    }
    const useSnapshot = (<T,>(selector: (snapshot: AcosmiAccountUiState) => T): T => selector(state))
    const view = render(<AccountSection
      controller={controller}
      useSnapshot={useSnapshot as never}
      t={key => key}
    />)

    expect(resume).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(load).toHaveBeenCalledOnce()

    view.unmount()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(load).toHaveBeenCalledOnce()
  })

  it('does not overlap projection polling with an active account operation', async () => {
    vi.useFakeTimers()
    Object.defineProperty(window, 'dshDesktop', {
      configurable: true,
      value: { productInfo: async () => ({ ok: false }) },
    })
    const load = vi.fn(async () => undefined)
    const controller = {
      resume: vi.fn(async () => undefined),
      load,
      act: vi.fn(async () => undefined),
    } as unknown as AcosmiAccountStore
    const state: AcosmiAccountUiState = {
      phase: 'ready',
      account: READY,
      busy: 'refresh',
      error: null,
    }
    const useSnapshot = (<T,>(selector: (snapshot: AcosmiAccountUiState) => T): T => selector(state))
    render(<AccountSection
      controller={controller}
      useSnapshot={useSnapshot as never}
      t={key => key}
    />)

    await vi.advanceTimersByTimeAsync(120_000)
    expect(load).not.toHaveBeenCalled()
  })
})
