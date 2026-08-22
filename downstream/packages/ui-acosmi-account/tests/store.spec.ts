import { describe, expect, it, vi } from 'vitest'
import type { AcosmiAccountSnapshot } from '@acosmi/dsh-api-remotes-acosmi/client'
import { AcosmiAccountStore } from '../src/client/store.ts'

const READY: AcosmiAccountSnapshot = {
  status: 'ready',
  loginAvailable: true,
  label: 'Acosmi member',
  modelStatus: 'ok',
  pollAfterMs: 60_000,
  updatedAt: 1,
}

function remote(account: AcosmiAccountSnapshot = READY): never {
  const result = async () => ({ ok: true, value: { ok: true, account } })
  return {
    describe: async () => ({ ok: true, value: account }),
    login: result,
    logout: result,
    refresh: result,
  } as never
}

describe('Acosmi account client state', () => {
  it('runs product model routing after a ready interactive sign-in', async () => {
    const onAuthorized = vi.fn(async () => undefined)
    const store = new AcosmiAccountStore(remote(), onAuthorized)

    await store.act('login')

    expect(onAuthorized).toHaveBeenCalledOnce()
    expect(store.store.getSnapshot()).toEqual({
      phase: 'ready', account: READY, busy: null, error: null,
    })
  })

  it('keeps the connected account visible when automatic route selection fails', async () => {
    const store = new AcosmiAccountStore(remote(), async () => {
      throw new Error('token=plain-secret account=private')
    })

    await store.act('login')

    expect(store.store.getSnapshot()).toEqual({
      phase: 'ready',
      account: READY,
      busy: null,
      error: 'Acosmi sign-in succeeded, but no account model could be selected.',
    })
    expect(JSON.stringify(store.store.getSnapshot())).not.toMatch(/plain-secret|private/u)
  })

  it('does not change routing for refresh or degraded sign-in results', async () => {
    const onAuthorized = vi.fn(async () => undefined)
    const refreshStore = new AcosmiAccountStore(remote(), onAuthorized)
    await refreshStore.act('refresh')

    const degraded = { ...READY, status: 'degraded' as const }
    const loginStore = new AcosmiAccountStore(remote(degraded), onAuthorized)
    await loginStore.act('login')

    expect(onAuthorized).not.toHaveBeenCalled()
  })

  it('does not expose Remote transport error details', async () => {
    const store = new AcosmiAccountStore({
      ...remote(),
      describe: async () => ({
        ok: false,
        error: { message: 'token=plain-secret account=private' },
      }),
    } as never)

    await store.load()

    expect(store.store.getSnapshot().error).toBe('Acosmi account service is temporarily unavailable.')
    expect(JSON.stringify(store.store.getSnapshot())).not.toMatch(/plain-secret|private/u)
  })

  it('does not restart an in-flight projection read on resume', async () => {
    let settle!: (value: { ok: true; value: AcosmiAccountSnapshot }) => void
    const pending = new Promise<{ ok: true; value: AcosmiAccountSnapshot }>(resolve => {
      settle = resolve
    })
    const api = {
      ...remote(),
      describe: vi.fn(() => pending),
      refresh: vi.fn(async () => ({ ok: true, value: { ok: true, account: READY } })),
    }
    const store = new AcosmiAccountStore(api as never)
    const loading = store.load()
    expect(store.store.getSnapshot().phase).toBe('loading')

    await store.resume()
    await store.load()
    await store.act('refresh')
    expect(api.describe).toHaveBeenCalledOnce()
    expect(api.refresh).not.toHaveBeenCalled()

    settle({ ok: true, value: READY })
    await loading
    expect(store.store.getSnapshot()).toEqual({
      phase: 'ready', account: READY, busy: null, error: null,
    })
  })

  it('keeps the previous error visible while a retry is in flight', async () => {
    let settle!: (value: { ok: false; error: { message: string } }) => void
    const pending = new Promise<{ ok: false; error: { message: string } }>(resolve => {
      settle = resolve
    })
    const api = {
      ...remote(),
      describe: vi.fn()
        .mockRejectedValueOnce(new Error('token=plain-secret'))
        .mockImplementationOnce(() => pending),
    }
    const store = new AcosmiAccountStore(api as never)
    await store.load()
    expect(store.store.getSnapshot().error).toBe('Acosmi account service is temporarily unavailable.')

    const retry = store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      phase: 'loading',
      error: 'Acosmi account service is temporarily unavailable.',
    })
    settle({ ok: false, error: { message: 'token=plain-secret' } })
    await retry
    expect(store.store.getSnapshot().phase).toBe('error')
  })

  it('loads the Host projection and refreshes provider data on page open and foreground resume', async () => {
    const api = remote() as {
      describe: ReturnType<typeof vi.fn>
      refresh: ReturnType<typeof vi.fn>
    }
    api.describe = vi.fn(api.describe)
    api.refresh = vi.fn(api.refresh)
    const store = new AcosmiAccountStore(api as never)

    await store.resume()
    expect(api.describe).toHaveBeenCalledOnce()
    expect(api.refresh).toHaveBeenCalledOnce()

    await store.resume()
    expect(api.refresh).toHaveBeenCalledTimes(2)
  })

  it('renders fixed copy for a classified Host action failure', async () => {
    const store = new AcosmiAccountStore({
      ...remote(),
      login: async () => ({
        ok: true,
        value: {
          ok: false,
          code: 'failed',
          reason: 'authorization-timeout',
          message: 'token=plain-secret account=private',
        },
      }),
    } as never)

    await store.act('login')

    expect(store.store.getSnapshot().error).toBe('Acosmi account operation could not be completed.')
    expect(JSON.stringify(store.store.getSnapshot())).not.toMatch(/plain-secret|private/u)
  })
})
