import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { LoginErrCode, LoginEvent, ManagedModel, TokenSet } from '@acosmi/sdk-ts'
import type { DesktopSecretBridge } from '@acosmi/dsh-desktop-secrets'

interface FakeClient {
  authorized: boolean
  isAuthorized(): boolean
  setAutoStripEphemeralHistory(on: boolean): void
  loginWithHandler(
    appName: string,
    scopes: string[],
    handler: (event: LoginEvent) => void,
    options: { skipBrowser?: boolean },
    signal?: AbortSignal,
  ): Promise<void>
  listModelsWithStatus(signal?: AbortSignal, options?: { includeLocked?: boolean }): Promise<{
    models: ManagedModel[]
    status: string
  }>
  getQuotaSummary(signal?: AbortSignal): Promise<{
    freeTotalEtu: number
    paidTotalEtu: number
    nextFreeExpiresAt?: string
    nextPaidExpiresAt?: string
  }>
  getMembership(signal?: AbortSignal): Promise<{ hasActive: boolean; planName: string; expiresAt: string }>
  logout(signal?: AbortSignal): Promise<void>
}

interface FakeSdkConfig {
  readonly store?: { load(): Promise<TokenSet | null> }
}

const mocked = vi.hoisted(() => ({
  create: vi.fn<(config?: FakeSdkConfig) => Promise<unknown>>(),
}))

vi.mock('@acosmi/sdk-ts', async importOriginal => {
  const actual = await importOriginal<typeof import('@acosmi/sdk-ts')>()
  return {
    ...actual,
    Client: class MockSdkClient {
      static create(config?: FakeSdkConfig): Promise<unknown> { return mocked.create(config) }
    },
  }
})

import {
  AcosmiAccountService,
  type AcosmiAccountFailureReason,
  type Config,
} from '../src/index.ts'

const LOGIN_FAILURE_CASES: ReadonlyArray<readonly [LoginErrCode | undefined, AcosmiAccountFailureReason]> = [
  ['discovery_failed', 'oauth-discovery-failed'],
  ['registration_failed', 'oauth-registration-failed'],
  ['browser_open_failed', 'browser-open-failed'],
  ['auth_denied', 'authorization-denied'],
  ['auth_timeout', 'authorization-timeout'],
  ['token_exchange_failed', 'token-exchange-failed'],
  ['ssl_proxy_detected', 'tls-proxy-detected'],
  ['state_mismatch', 'state-mismatch'],
  [undefined, 'oauth-protocol-failed'],
]

class MemorySecrets implements DesktopSecretBridge {
  readonly persistence = 'session-memory' as const
  readonly values = new Map<string, string>()
  async getEnvironmentCredential(): Promise<string | undefined> { return undefined }
  async hasEnvironmentCredential(): Promise<boolean> { return false }
  async get(key: string): Promise<string | undefined> { return this.values.get(key) }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value) }
  async delete(key: string): Promise<void> { this.values.delete(key) }
}

class UnavailableSecrets implements DesktopSecretBridge {
  readonly persistence = 'os-protected' as const
  async getEnvironmentCredential(): Promise<string | undefined> { return undefined }
  async hasEnvironmentCredential(): Promise<boolean> { return false }
  async get(): Promise<string | undefined> { throw new Error('desktop vault: operating-system encryption is unavailable') }
  async set(): Promise<void> { throw new Error('desktop vault: operating-system encryption is unavailable') }
  async delete(): Promise<void> { throw new Error('desktop vault: operating-system encryption is unavailable') }
}

class DeleteFailureSecrets extends MemorySecrets {
  override async delete(): Promise<void> {
    throw new Error('desktop vault: operating-system encryption is unavailable')
  }
}

class FailOnSecondReadSecrets extends MemorySecrets {
  reads = 0

  override async get(key: string): Promise<string | undefined> {
    this.reads++
    if (this.reads > 1) throw new Error('desktop vault: transient second read failed')
    return super.get(key)
  }
}

function fakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  const client: FakeClient = {
    authorized: false,
    isAuthorized() { return this.authorized },
    setAutoStripEphemeralHistory() {},
    async loginWithHandler(_appName, _scopes, handler, _options, signal) {
      handler({
        type: 'auth_url',
        url: `https://acosmi.com/oauth/desktop/authorize?client_id=test&redirect_uri=${encodeURIComponent('http://127.0.0.1:54321/callback')}&response_type=code&code_challenge=${'b'.repeat(43)}&code_challenge_method=S256&state=${'a'.repeat(43)}&scope=ai`,
      })
      await Promise.resolve()
      if (signal?.aborted === true) throw signal.reason
      this.authorized = true
    },
    async listModelsWithStatus() { return { models: [], status: 'ok' } },
    async getQuotaSummary() {
      return {
        freeTotalEtu: 20,
        paidTotalEtu: 40,
        nextFreeExpiresAt: '2026-09-01T00:00:00.000Z',
        nextPaidExpiresAt: '2026-08-20T00:00:00.000Z',
      }
    },
    async getMembership() { return { hasActive: true, planName: 'Pro', expiresAt: '2026-12-01T00:00:00.000Z' } },
    async logout() { this.authorized = false },
    ...overrides,
  }
  return client
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    tokenKey: 'com.acosmi.dsharness.gui:stable:test',
    loginEnabled: true,
    gatewayBaseUrl: 'https://acosmi.com',
    oauthAppName: 'DSH-GUI',
    loginTimeoutMs: 30_000,
    logoutTimeoutMs: 10_000,
    refreshIntervalMs: 300_000,
    refreshJitterMs: 30_000,
    refreshTimeoutMs: 30_000,
    projectionPollIntervalMs: 60_000,
    productVersion: '0.1.0-dev.1',
    ...overrides,
  }
}

async function fixture(client: FakeClient, overrides: Partial<Config> = {}): Promise<{
  context: Context
  service: AcosmiAccountService
  secrets: MemorySecrets
  open: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>
}> {
  mocked.create.mockResolvedValue(client)
  const context = new Context()
  const secrets = new MemorySecrets()
  if (client.authorized) {
    const token: TokenSet = {
      access_token: 'access', refresh_token: 'refresh', expires_at: '2030-01-01T00:00:00.000Z',
      scope: 'ai', client_id: 'client', server_url: 'https://acosmi.com',
    }
    secrets.values.set('com.acosmi.dsharness.gui:stable:test', JSON.stringify(token))
  }
  const open = vi.fn(async (_url: string) => undefined)
  context.provide('desktopSecrets', secrets)
  context.provide('acosmiOAuthBrowser', { open })
  const service = new AcosmiAccountService(context, config(overrides))
  await service.start()
  return { context, service, secrets, open }
}

beforeEach(() => {
  mocked.create.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Acosmi account state machine', () => {
  it('rejects refresh jitter that exceeds the configured base interval', async () => {
    const context = new Context()
    context.provide('desktopSecrets', new MemorySecrets())
    context.provide('acosmiOAuthBrowser', { open: vi.fn(async () => undefined) })

    expect(() => new AcosmiAccountService(context, config({
      refreshIntervalMs: 10_000,
      refreshJitterMs: 10_001,
    }))).toThrow('refreshJitterMs must not exceed refreshIntervalMs')

    await context.fiber.dispose()
  })

  it('starts signed out, runs one browser login, and projects only client-safe account data', async () => {
    const client = fakeClient()
    const login = vi.spyOn(client, 'loginWithHandler')
    const stripEphemeral = vi.spyOn(client, 'setAutoStripEphemeralHistory')
    const { context, service, secrets, open } = await fixture(client)
    const listener = vi.fn()
    service.subscribe(context, listener)
    expect(await service.describe()).toMatchObject({ status: 'signed-out', loginAvailable: true })
    expect(listener).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: 'signed-out' }))

    const [left, right] = await Promise.all([service.login(), service.login()])
    expect(left).toEqual(right)
    expect(left).toMatchObject({
      ok: true,
      account: {
        status: 'ready',
        membership: { planName: 'Pro' },
        quota: { freeRemainingEtu: 20, paidRemainingEtu: 40, nextExpiry: '2026-08-20T00:00:00.000Z' },
      },
    })
    expect(login).toHaveBeenCalledTimes(1)
    expect(stripEphemeral).toHaveBeenCalledOnce()
    expect(stripEphemeral).toHaveBeenCalledWith(true)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(expect.stringContaining('state='))
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ready' }))
    expect(JSON.stringify(left)).not.toContain('access_token')
    expect(secrets.values.size).toBe(0)
    await context.fiber.dispose()
  })

  it('honors the login kill switch while retaining the DeepSeek route and existing tokens', async () => {
    const client = fakeClient()
    const login = vi.spyOn(client, 'loginWithHandler')
    const { context, service, open } = await fixture(client, { loginEnabled: false })
    expect(await service.describe()).toMatchObject({ status: 'login-disabled', loginAvailable: false })
    await expect(service.login()).resolves.toEqual({
      ok: false,
      code: 'login-disabled',
      message: 'Acosmi sign-in is disabled for this build.',
    })
    expect(login).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    await context.fiber.dispose()
  })

  it('isolates unavailable secret storage from Host startup and refuses account login safely', async () => {
    const context = new Context()
    context.provide('desktopSecrets', new UnavailableSecrets())
    context.provide('acosmiOAuthBrowser', { open: vi.fn(async () => undefined) })
    const service = new AcosmiAccountService(context, config())

    await expect(service.start()).resolves.toBeUndefined()
    await expect(service.describe()).resolves.toMatchObject({
      status: 'unavailable',
      message: 'Secure account storage is unavailable.',
    })
    await expect(service.login()).resolves.toEqual({
      ok: false,
      code: 'failed',
      reason: 'secure-storage-unavailable',
      message: 'Secure account storage is unavailable.',
    })
    await expect(service.describe()).resolves.toMatchObject({
      status: 'unavailable',
      message: 'Secure account storage is unavailable.',
    })
    expect(mocked.create).not.toHaveBeenCalled()
    await context.fiber.dispose()
  })

  it('uses one successful TokenStore preflight throughout SDK construction', async () => {
    const client = fakeClient()
    mocked.create.mockImplementation(async sdkConfig => {
      if (sdkConfig?.store === undefined) throw new Error('missing SDK token store')
      let stored: TokenSet | null = null
      try {
        stored = await sdkConfig.store.load()
      } catch (_sdkSuppressedStoreFailure) {
        // @acosmi/sdk-ts@2.17.0 suppresses its construction-time load failure.
      }
      client.authorized = stored !== null
      return client
    })
    const context = new Context()
    const secrets = new FailOnSecondReadSecrets()
    const token: TokenSet = {
      access_token: 'access', refresh_token: 'refresh', expires_at: '2030-01-01T00:00:00.000Z',
      scope: 'ai', client_id: 'client', server_url: 'https://acosmi.com',
    }
    secrets.values.set('com.acosmi.dsharness.gui:stable:test', JSON.stringify(token))
    context.provide('desktopSecrets', secrets)
    context.provide('acosmiOAuthBrowser', { open: vi.fn(async () => undefined) })
    const service = new AcosmiAccountService(context, config())

    await service.start()

    expect(secrets.reads).toBe(1)
    await expect(service.describe()).resolves.toMatchObject({ status: 'ready' })
    expect(service.sdkSession()).toBeDefined()
    await context.fiber.dispose()
  })

  it('keeps login successful when optional projections degrade and ignores membership failure', async () => {
    const client = fakeClient({
      async listModelsWithStatus() { return { models: [], status: 'fallback-tkdist-error' } },
      async getMembership() { throw new Error('billing endpoint unavailable') },
    })
    const { context, service } = await fixture(client)
    await expect(service.login()).resolves.toMatchObject({
      ok: true,
      account: { status: 'degraded', modelStatus: 'fallback-tkdist-error' },
    })
    expect(await service.describe()).not.toHaveProperty('membership')
    await context.fiber.dispose()
  })

  it('destroys the SDK client when the SDK wraps a login token-store failure', async () => {
    const client = fakeClient({
      async loginWithHandler(_appName, _scopes, handler) {
        handler({
          type: 'auth_url',
          url: `https://acosmi.com/oauth/desktop/authorize?client_id=test&redirect_uri=${encodeURIComponent('http://127.0.0.1:54321/callback')}&response_type=code&code_challenge=${'b'.repeat(43)}&code_challenge_method=S256&state=${'a'.repeat(43)}&scope=ai`,
        })
        this.authorized = true
        throw new Error('save tokens: Acosmi token store could not write secure storage')
      },
    })
    const { context, service } = await fixture(client)

    await expect(service.login()).resolves.toEqual({
      ok: false,
      code: 'failed',
      reason: 'secure-storage-unavailable',
      message: 'Secure account storage is unavailable.',
    })
    await expect(service.describe()).resolves.toMatchObject({
      status: 'unavailable',
      message: 'Secure account storage is unavailable.',
    })
    expect(service.sdkSession()).toBeUndefined()
    await context.fiber.dispose()
  })

  it('does not treat provider text mentioning a token store as secure-storage evidence', async () => {
    const client = fakeClient({
      async loginWithHandler(_appName, _scopes, handler) {
        handler({ type: 'error', err_code: 'token_exchange_failed', error: 'provider token store unavailable' })
        throw new Error('token exchange failed: provider token store unavailable')
      },
    })
    const { context, service } = await fixture(client)

    await expect(service.login()).resolves.toEqual({
      ok: false,
      code: 'failed',
      reason: 'token-exchange-failed',
      message: 'Acosmi sign-in could not be completed.',
    })
    expect(await service.describe()).toMatchObject({ status: 'signed-out' })
    await context.fiber.dispose()
  })

  it.each(LOGIN_FAILURE_CASES)('maps SDK login failure %s to client-safe reason %s', async (errCode, reason) => {
    const client = fakeClient({
      async loginWithHandler(_appName, _scopes, handler) {
        handler({
          type: 'error',
          err_code: errCode,
          error: 'token=plain-secret account=private https://acosmi.com/?token=url-secret',
        })
        throw new Error('token=plain-secret account=private')
      },
    })
    const { context, service } = await fixture(client)

    const result = await service.login()

    expect(result).toEqual({
      ok: false,
      code: 'failed',
      reason,
      message: 'Acosmi sign-in could not be completed.',
    })
    expect(JSON.stringify(result)).not.toMatch(/plain-secret|private|url-secret|acosmi\.com/u)
    expect(await service.describe()).toMatchObject({ status: 'signed-out' })
    await context.fiber.dispose()
  })

  it('classifies a failed SDK operation without a login event as an account operation failure', async () => {
    const client = fakeClient({
      async loginWithHandler() {
        throw new Error('token=plain-secret account=private')
      },
    })
    const { context, service } = await fixture(client)

    await expect(service.login()).resolves.toEqual({
      ok: false,
      code: 'failed',
      reason: 'account-operation-failed',
      message: 'Acosmi sign-in could not be completed.',
    })
    await context.fiber.dispose()
  })

  it('classifies SDK completion without an authorization URL as a protocol failure', async () => {
    const client = fakeClient({
      async loginWithHandler() {},
    })
    const { context, service } = await fixture(client)

    await expect(service.login()).resolves.toEqual({
      ok: false,
      code: 'failed',
      reason: 'oauth-protocol-failed',
      message: 'Acosmi sign-in could not be completed.',
    })
    await context.fiber.dispose()
  })

  it('classifies the product login deadline without exposing its abort reason', async () => {
    const timeout = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const started = Promise.withResolvers<void>()
    const client = fakeClient({
      async loginWithHandler(_appName, _scopes, handler, _options, signal) {
        handler({
          type: 'auth_url',
          url: `https://acosmi.com/oauth/desktop/authorize?client_id=test&redirect_uri=${encodeURIComponent('http://127.0.0.1:54321/callback')}&response_type=code&code_challenge=${'b'.repeat(43)}&code_challenge_method=S256&state=${'a'.repeat(43)}&scope=ai`,
        })
        started.resolve()
        await new Promise<void>((_resolve, reject) => {
          const abort = (): void => { reject(signal?.reason) }
          if (signal?.aborted === true) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        })
      },
    })
    const { context, service } = await fixture(client)
    const login = service.login()
    await started.promise

    timeout.abort(new Error('token=plain-secret account=private'))

    await expect(login).resolves.toEqual({
      ok: false,
      code: 'failed',
      reason: 'authorization-timeout',
      message: 'Acosmi sign-in could not be completed.',
    })
    expect(JSON.stringify(await login)).not.toMatch(/plain-secret|private/u)
    await context.fiber.dispose()
  })

  it('reports browser failure without exposing raw error fields and resets to signed out', async () => {
    const client = fakeClient()
    mocked.create.mockResolvedValue(client)
    const context = new Context()
    const secrets = new MemorySecrets()
    context.provide('desktopSecrets', secrets)
    context.provide('acosmiOAuthBrowser', {
      open: () => Promise.reject(new Error('token=plain-secret account=private https://acosmi.com/?token=url-secret')),
    })
    const service = new AcosmiAccountService(context, config())
    await service.start()
    const result = await service.login()
    expect(result).toEqual({
      ok: false,
      code: 'failed',
      reason: 'browser-open-failed',
      message: 'Acosmi sign-in could not be completed.',
    })
    expect(JSON.stringify(result)).not.toMatch(/plain-secret|private|url-secret|acosmi\.com/u)
    expect(await service.describe()).toMatchObject({ status: 'signed-out' })
    await context.fiber.dispose()
  })

  it('rolls back authorization when system-browser acceptance fails after the SDK completes', async () => {
    const client = fakeClient()
    const revoke = vi.spyOn(client, 'logout')
    mocked.create.mockResolvedValue(client)
    const context = new Context()
    const secrets = new MemorySecrets()
    let rejectOpen!: (error: Error) => void
    const open = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectOpen = reject }))
    context.provide('desktopSecrets', secrets)
    context.provide('acosmiOAuthBrowser', { open })
    const service = new AcosmiAccountService(context, config())
    await service.start()

    const login = service.login()
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
    rejectOpen(new Error('system browser rejected the request'))

    await expect(login).resolves.toEqual({
      ok: false,
      code: 'failed',
      reason: 'browser-open-failed',
      message: 'Acosmi sign-in could not be completed.',
    })
    expect(revoke).toHaveBeenCalledOnce()
    expect(client.authorized).toBe(false)
    expect(service.sdkSession()).toBeUndefined()
    await expect(service.describe()).resolves.toMatchObject({ status: 'signed-out' })
    await context.fiber.dispose()
  })

  it('cancels and settles an active sign-in before clearing credentials for logout', async () => {
    let loginSignal: AbortSignal | undefined
    const started = Promise.withResolvers<void>()
    const client = fakeClient({
      async loginWithHandler(_appName, _scopes, handler, _options, signal) {
        loginSignal = signal
        handler({
          type: 'auth_url',
          url: `https://acosmi.com/oauth/desktop/authorize?client_id=test&redirect_uri=${encodeURIComponent('http://127.0.0.1:54321/callback')}&response_type=code&code_challenge=${'b'.repeat(43)}&code_challenge_method=S256&state=${'a'.repeat(43)}&scope=ai`,
        })
        started.resolve()
        await new Promise<void>((_resolve, reject) => {
          const abort = (): void => { reject(signal?.reason) }
          if (signal?.aborted === true) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        })
      },
    })
    const { context, service, secrets } = await fixture(client)

    const login = service.login()
    await started.promise
    const logout = service.logout()

    await expect(login).resolves.toMatchObject({ ok: false, code: 'cancelled' })
    await expect(logout).resolves.toMatchObject({ ok: true, account: { status: 'signed-out' } })
    expect(loginSignal?.aborted).toBe(true)
    expect(secrets.values.size).toBe(0)
    expect(service.sdkSession()).toBeUndefined()
    await context.fiber.dispose()
  })

  it('rolls back authorization when logout cancels the post-login account projection', async () => {
    const projectionStarted = Promise.withResolvers<AbortSignal>()
    const client = fakeClient({
      async getQuotaSummary(signal) {
        if (signal === undefined) throw new Error('missing account projection signal')
        projectionStarted.resolve(signal)
        await new Promise<void>((_resolve, reject) => {
          const abort = (): void => { reject(signal.reason) }
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        })
        throw new Error('unreachable account projection')
      },
    })
    const revoke = vi.spyOn(client, 'logout')
    const { context, service } = await fixture(client)

    const login = service.login()
    const projectionSignal = await projectionStarted.promise
    const logout = service.logout()

    await expect(login).resolves.toMatchObject({ ok: false, code: 'cancelled' })
    await expect(logout).resolves.toMatchObject({ ok: true, account: { status: 'signed-out' } })
    expect(projectionSignal.aborted).toBe(true)
    expect(revoke).toHaveBeenCalledOnce()
    expect(client.authorized).toBe(false)
    expect(service.sdkSession()).toBeUndefined()
    await context.fiber.dispose()
  })

  it('withdraws the SDK session and settles an active sign-in before service disposal completes', async () => {
    const started = Promise.withResolvers<void>()
    const client = fakeClient({
      async loginWithHandler(_appName, _scopes, handler, _options, signal) {
        handler({
          type: 'auth_url',
          url: `https://acosmi.com/oauth/desktop/authorize?client_id=test&redirect_uri=${encodeURIComponent('http://127.0.0.1:54321/callback')}&response_type=code&code_challenge=${'b'.repeat(43)}&code_challenge_method=S256&state=${'a'.repeat(43)}&scope=ai`,
        })
        started.resolve()
        await new Promise<void>((_resolve, reject) => {
          const abort = (): void => { reject(signal?.reason) }
          if (signal?.aborted === true) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        })
      },
    })
    const { context, service } = await fixture(client)
    const session = service.sdkSession()
    const login = service.login()
    await started.promise

    await context.fiber.dispose()

    await expect(login).resolves.toMatchObject({ ok: false, code: 'cancelled' })
    expect(session?.signal.aborted).toBe(true)
    expect(service.sdkSession()).toBeUndefined()
    await expect(service.login()).resolves.toMatchObject({ ok: false, code: 'cancelled' })
    await expect(service.logout()).resolves.toEqual({
      ok: false,
      code: 'failed',
      reason: 'service-stopping',
      message: 'Acosmi sign-out could not be completed.',
    })
  })

  it('rejects a new sign-in while sign-out is still revoking the remote authorization', async () => {
    const revokeStarted = Promise.withResolvers<void>()
    const revokeFinished = Promise.withResolvers<void>()
    const client = fakeClient({
      authorized: true,
      async logout() {
        revokeStarted.resolve()
        await revokeFinished.promise
        this.authorized = false
      },
    })
    const { context, service } = await fixture(client)

    const logout = service.logout()
    await revokeStarted.promise
    await expect(service.login()).resolves.toEqual({
      ok: false,
      code: 'failed',
      reason: 'operation-in-progress',
      message: 'Acosmi sign-in could not be completed.',
    })
    revokeFinished.resolve()
    await expect(logout).resolves.toMatchObject({ ok: true, account: { status: 'signed-out' } })
    await context.fiber.dispose()
  })

  it('loads an authorized token, refreshes, and clears local authorization before remote logout', async () => {
    const client = fakeClient({ authorized: true })
    mocked.create.mockResolvedValue(client)
    const context = new Context()
    const secrets = new MemorySecrets()
    const token: TokenSet = {
      access_token: 'access', refresh_token: 'refresh', expires_at: '2030-01-01T00:00:00.000Z',
      scope: 'ai', client_id: 'client', server_url: 'https://acosmi.com',
    }
    secrets.values.set('com.acosmi.dsharness.gui:stable:test', JSON.stringify(token))
    context.provide('desktopSecrets', secrets)
    context.provide('acosmiOAuthBrowser', { open: vi.fn(async () => undefined) })
    const service = new AcosmiAccountService(context, config())
    await service.start()
    expect(await service.describe()).toMatchObject({ status: 'ready' })
    const authorized = service.sdkSession()
    expect(authorized).toBeDefined()
    await expect(service.refresh()).resolves.toMatchObject({ ok: true })
    await expect(service.logout()).resolves.toMatchObject({ ok: true, account: { status: 'signed-out' } })
    expect(secrets.values.size).toBe(0)
    expect(client.authorized).toBe(false)
    expect(authorized?.signal.aborted).toBe(true)
    await context.fiber.dispose()
  })

  it('refreshes an authorized account on the configured background schedule', async () => {
    vi.useFakeTimers()
    try {
      const secondRefresh = Promise.withResolvers<void>()
      let quotaCalls = 0
      const client = fakeClient({
        authorized: true,
        async getQuotaSummary() {
          quotaCalls++
          if (quotaCalls === 2) secondRefresh.resolve()
          return { freeTotalEtu: 20, paidTotalEtu: 40 }
        },
      })
      const { context } = await fixture(client, {
        refreshIntervalMs: 10_000,
        refreshJitterMs: 0,
        refreshTimeoutMs: 5_000,
      })
      expect(quotaCalls).toBe(1)

      await vi.advanceTimersByTimeAsync(9_999)
      expect(quotaCalls).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      await secondRefresh.promise
      expect(quotaCalls).toBe(2)

      await context.fiber.dispose()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(quotaCalls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces a scheduled refresh and settles disposal when the provider ignores cancellation', async () => {
    vi.useFakeTimers()
    try {
      const refreshStarted = Promise.withResolvers<AbortSignal>()
      let quotaCalls = 0
      const client = fakeClient({
        authorized: true,
        getQuotaSummary(signal) {
          quotaCalls++
          if (quotaCalls === 1) return Promise.resolve({ freeTotalEtu: 20, paidTotalEtu: 40 })
          if (signal === undefined) throw new Error('missing background refresh signal')
          refreshStarted.resolve(signal)
          return new Promise(() => undefined)
        },
      })
      const { context, service } = await fixture(client, {
        refreshIntervalMs: 10_000,
        refreshJitterMs: 0,
        refreshTimeoutMs: 5_000,
      })

      await vi.advanceTimersByTimeAsync(10_000)
      const refreshSignal = await refreshStarted.promise
      const coalesced = service.refresh()
      expect(quotaCalls).toBe(2)

      await expect(context.fiber.dispose()).resolves.toBeUndefined()
      expect(refreshSignal.aborted).toBe(true)
      await expect(coalesced).resolves.toMatchObject({ ok: false, code: 'cancelled' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not republish a late refresh after logout withdraws its SDK session', async () => {
    const refreshStarted = Promise.withResolvers<AbortSignal>()
    const lateQuota = Promise.withResolvers<{
      freeTotalEtu: number
      paidTotalEtu: number
    }>()
    let quotaCalls = 0
    const client = fakeClient({
      authorized: true,
      async getQuotaSummary(signal) {
        quotaCalls++
        if (quotaCalls === 1) return { freeTotalEtu: 20, paidTotalEtu: 40 }
        if (signal === undefined) throw new Error('missing refresh signal')
        refreshStarted.resolve(signal)
        return lateQuota.promise
      },
    })
    const { context, service } = await fixture(client)
    const statuses: string[] = []
    service.subscribe(context, snapshot => { statuses.push(snapshot.status) })

    const refresh = service.refresh()
    const refreshSignal = await refreshStarted.promise
    const logout = service.logout()
    await expect(logout).resolves.toMatchObject({ ok: true, account: { status: 'signed-out' } })
    expect(refreshSignal.aborted).toBe(true)

    lateQuota.resolve({ freeTotalEtu: 999, paidTotalEtu: 999 })
    await expect(refresh).resolves.toMatchObject({ ok: false, code: 'cancelled' })
    await expect(service.describe()).resolves.toMatchObject({ status: 'signed-out' })
    expect(statuses.slice(statuses.lastIndexOf('signed-out'))).toEqual(['signed-out'])
    await context.fiber.dispose()
  })

  it('rejects a late model catalog after logout withdraws its SDK session', async () => {
    const catalogStarted = Promise.withResolvers<AbortSignal>()
    const lateCatalog = Promise.withResolvers<{ models: ManagedModel[]; status: string }>()
    let catalogCalls = 0
    const client = fakeClient({
      authorized: true,
      listModelsWithStatus(signal) {
        catalogCalls++
        if (catalogCalls === 1) return Promise.resolve({ models: [], status: 'ok' })
        if (signal === undefined) throw new Error('missing model catalog signal')
        catalogStarted.resolve(signal)
        return lateCatalog.promise
      },
    })
    const { context, service } = await fixture(client)

    const listing = service.models()
    const catalogSignal = await catalogStarted.promise
    await expect(service.logout()).resolves.toMatchObject({ ok: true, account: { status: 'signed-out' } })
    expect(catalogSignal.aborted).toBe(true)

    lateCatalog.resolve({ models: [], status: 'ok' })
    await expect(listing).rejects.toThrow(/signed out/u)
    await context.fiber.dispose()
  })

  it('does not claim logout or revoke remotely when local token deletion fails', async () => {
    const client = fakeClient({ authorized: true })
    const logout = vi.spyOn(client, 'logout')
    mocked.create.mockResolvedValue(client)
    const context = new Context()
    const secrets = new DeleteFailureSecrets()
    const token: TokenSet = {
      access_token: 'access', refresh_token: 'refresh', expires_at: '2030-01-01T00:00:00.000Z',
      scope: 'ai', client_id: 'client', server_url: 'https://acosmi.com',
    }
    secrets.values.set('com.acosmi.dsharness.gui:stable:test', JSON.stringify(token))
    context.provide('desktopSecrets', secrets)
    context.provide('acosmiOAuthBrowser', { open: vi.fn(async () => undefined) })
    const service = new AcosmiAccountService(context, config())
    await service.start()

    await expect(service.logout()).resolves.toEqual({
      ok: false,
      code: 'failed',
      reason: 'secure-storage-unavailable',
      message: 'Secure account storage is unavailable.',
    })
    await expect(service.describe()).resolves.toMatchObject({
      status: 'unavailable',
      message: 'Secure account storage is unavailable.',
    })
    expect(logout).not.toHaveBeenCalled()
    expect(service.sdkSession()).toBeUndefined()
    await context.fiber.dispose()
  })

  it('bounds remote revocation after clearing local credentials and reports uncertainty', async () => {
    vi.useFakeTimers()
    try {
      let revokeSignal: AbortSignal | undefined
      const client = fakeClient({
        authorized: true,
        logout(signal) {
          revokeSignal = signal
          return new Promise(() => undefined)
        },
      })
      mocked.create.mockResolvedValue(client)
      const context = new Context()
      const secrets = new MemorySecrets()
      const token: TokenSet = {
        access_token: 'access', refresh_token: 'refresh', expires_at: '2030-01-01T00:00:00.000Z',
        scope: 'ai', client_id: 'client', server_url: 'https://acosmi.com',
      }
      secrets.values.set('com.acosmi.dsharness.gui:stable:test', JSON.stringify(token))
      context.provide('desktopSecrets', secrets)
      context.provide('acosmiOAuthBrowser', { open: vi.fn(async () => undefined) })
      const service = new AcosmiAccountService(context, config({ logoutTimeoutMs: 1_000 }))
      await service.start()

      const logout = service.logout()
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(logout).resolves.toMatchObject({
        ok: true,
        account: {
          status: 'signed-out',
          message: 'Local credentials were removed, but remote revocation could not be confirmed.',
        },
      })
      expect(secrets.values.size).toBe(0)
      expect(revokeSignal?.aborted).toBe(true)
      expect(service.sdkSession()).toBeUndefined()
      await context.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
