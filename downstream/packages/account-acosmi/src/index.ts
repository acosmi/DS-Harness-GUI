/** Acosmi SDK lifecycle, account projection, and state-checked desktop OAuth. */

import {
  Client,
  DefaultRetryPolicy,
  EventAuthURL,
  EventError,
  modelScopes,
  type LoginErrCode,
  type LoginEvent,
  type ManagedModel,
  type TokenSet,
  type TokenStore,
} from '@acosmi/sdk-ts'
import { DesktopSdkTokenStore, DesktopTokenStoreError } from '@acosmi/dsh-desktop-secrets'
import { type Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AcosmiAccountActionResult,
  AcosmiAccountFailureReason,
  AcosmiAccountSnapshot,
} from './types.ts'

const ACCOUNT_DATA_UNAVAILABLE = 'Acosmi account data is temporarily unavailable.'
const REMOTE_REVOCATION_UNCONFIRMED = 'Local credentials were removed, but remote revocation could not be confirmed.'
const SIGN_IN_FAILED = 'Acosmi sign-in could not be completed.'

/** Serve the completed vault preflight throughout SDK construction, then delegate every later access. */
class PreflightTokenStore implements TokenStore {
  private active = false

  constructor(
    private readonly delegate: DesktopSdkTokenStore,
    private readonly preflight: TokenSet | null,
  ) {}

  activate(): void {
    this.active = true
  }

  load(): Promise<TokenSet | null> {
    return this.active
      ? this.delegate.load()
      : Promise.resolve(this.preflight === null ? null : structuredClone(this.preflight))
  }

  save(tokens: TokenSet): Promise<void> {
    return this.delegate.save(tokens)
  }

  clear(): Promise<void> {
    return this.delegate.clear()
  }

  withLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.delegate.withLock(operation)
  }
}

export type * from './types.ts'

/** Account plugin configuration. */
export interface Config {
  /** Channel-specific safeStorage key. */
  readonly tokenKey: string
  /** Runtime kill switch for starting a new Acosmi authorization flow. */
  readonly loginEnabled: boolean
  /** Production SDK gateway and OAuth issuer. */
  readonly gatewayBaseUrl: string
  /** Public OAuth client display name registered by the SDK. */
  readonly oauthAppName: string
  /** Upper bound for one interactive loopback login. */
  readonly loginTimeoutMs: number
  /** Upper bound for best-effort remote revocation after local logout. */
  readonly logoutTimeoutMs: number
  /** Base delay between authenticated background account refreshes. */
  readonly refreshIntervalMs: number
  /** Maximum additional randomized delay for a background refresh. */
  readonly refreshJitterMs: number
  /** Upper bound for quota, catalog, and membership projection refresh. */
  readonly refreshTimeoutMs: number
  /** Renderer polling period for reading the latest Host projection. */
  readonly projectionPollIntervalMs: number
  /** Exact desktop package version used for outbound product attribution. */
  readonly productVersion: string
}

/** Utility-process bridge to the main-process system-browser gate. */
export interface AcosmiOAuthBrowserBridge {
  /**
   * Open one SDK-produced authorization URL.
   * @param url - complete OAuth authorization URL.
   * @returns once the operating system accepts the request.
   */
  open(url: string): Promise<void>
}

/** Lifecycle-safe account-state observer used by the LLM registration plugin. */
export type AcosmiAccountListener = (snapshot: AcosmiAccountSnapshot) => void

/** Authenticated SDK client paired with the lifetime of its local authorization. */
export interface AcosmiSdkSession {
  readonly client: Client
  readonly signal: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Acosmi account and authenticated SDK client lifecycle. */
    acosmiAccount: AcosmiAccountService
    /** Main-process owner of validated system-browser navigation. */
    acosmiOAuthBrowser: AcosmiOAuthBrowserBridge
  }
}

/**
 * Provide the privileged browser bridge before the account plugin mounts.
 * @param ctx - desktop Host root context.
 * @param bridge - main-process browser operation.
 */
export function provideAcosmiOAuthBrowser(ctx: Context, bridge: AcosmiOAuthBrowserBridge): void {
  ctx.provide('acosmiOAuthBrowser', bridge)
}

/** SDK lifecycle with typed Remote account operations. */
export class AcosmiAccountService extends TypertRemoteService {
  static inject = ['desktopSecrets', 'acosmiOAuthBrowser']

  static Config: s<Config> = s.object({
    tokenKey: s.string().required(),
    loginEnabled: s.boolean().required(),
    gatewayBaseUrl: s.string().required(),
    oauthAppName: s.string().required(),
    loginTimeoutMs: s.number().step(1).min(10_000).max(600_000).required(),
    logoutTimeoutMs: s.number().step(1).min(1_000).max(60_000).required(),
    refreshIntervalMs: s.number().step(1).min(10_000).max(3_600_000).required(),
    refreshJitterMs: s.number().step(1).min(0).max(600_000).required(),
    refreshTimeoutMs: s.number().step(1).min(1_000).max(120_000).required(),
    projectionPollIntervalMs: s.number().step(1).min(5_000).max(600_000).required(),
    productVersion: s.string().pattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u).required(),
  })

  private readonly store: DesktopSdkTokenStore
  private readonly baseUrl: string
  private readonly oauthAppName: string
  private readonly loginTimeoutMs: number
  private readonly logoutTimeoutMs: number
  private readonly refreshIntervalMs: number
  private readonly refreshJitterMs: number
  private readonly refreshTimeoutMs: number
  private readonly projectionPollIntervalMs: number
  private readonly loginEnabled: boolean
  private readonly fetchImpl: typeof fetch
  private clientValue: Client | undefined
  private clientAbort: AbortController | undefined
  private snapshotValue: AcosmiAccountSnapshot
  private loginTask: Promise<AcosmiAccountActionResult> | undefined
  private loginAbort: AbortController | undefined
  private logoutTask: Promise<AcosmiAccountActionResult> | undefined
  private refreshTask: Promise<AcosmiAccountActionResult> | undefined
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private readonly lifetimeAbort = new AbortController()
  private readonly listeners = new Set<AcosmiAccountListener>()
  private stopping = false

  /** @param ctx - Host context with the encrypted-vault bridge. @param config - desktop account policy. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'acosmiAccount')
    validateRefreshPolicy(config)
    this.store = new DesktopSdkTokenStore(ctx.desktopSecrets, config.tokenKey)
    this.baseUrl = validateAcosmiBaseUrl(config.gatewayBaseUrl)
    this.oauthAppName = validateOAuthAppName(config.oauthAppName)
    this.loginTimeoutMs = config.loginTimeoutMs
    this.logoutTimeoutMs = config.logoutTimeoutMs
    this.refreshIntervalMs = config.refreshIntervalMs
    this.refreshJitterMs = config.refreshJitterMs
    this.refreshTimeoutMs = config.refreshTimeoutMs
    this.projectionPollIntervalMs = config.projectionPollIntervalMs
    this.loginEnabled = config.loginEnabled
    this.fetchImpl = createAcosmiProductFetch(this.baseUrl, config.productVersion)
    this.snapshotValue = this.signedOutSnapshot()
    ctx.effect(() => async () => {
      this.stopping = true
      this.listeners.clear()
      this.clearRefreshTimer()
      const reason = new Error('Acosmi account service stopped')
      this.lifetimeAbort.abort(reason)
      this.loginAbort?.abort(reason)
      this.destroyClient(reason)
      await Promise.allSettled([
        ...(this.loginTask === undefined ? [] : [this.loginTask]),
        ...(this.logoutTask === undefined ? [] : [this.logoutTask]),
        ...(this.refreshTask === undefined ? [] : [this.refreshTask]),
      ])
    }, 'acosmi-account.client')
  }

  /** Initialize only after a successful TokenStore preflight. */
  async start(): Promise<void> {
    try {
      const stored = await this.store.load()
      if (this.stopping) return
      const client = await this.createSdkClient(stored)
      if (this.stopping) return
      this.assertPreflightAuthorization(client, stored)
      this.publishClient(client)
      if (client.isAuthorized()) {
        try {
          await this.refreshInternal(AbortSignal.any([
            this.lifetimeAbort.signal,
            AbortSignal.timeout(this.refreshTimeoutMs),
          ]))
        } catch (error) {
          if (isSecretStorageFailure(error)) throw error
          this.snapshotValue = {
            status: 'degraded',
            loginAvailable: this.loginEnabled,
            label: 'Acosmi member',
            pollAfterMs: this.projectionPollIntervalMs,
            updatedAt: Date.now(),
            message: ACCOUNT_DATA_UNAVAILABLE,
          }
        }
      } else {
        this.snapshotValue = this.signedOutSnapshot()
      }
    } catch (error) {
      this.setUnavailable(accountInitializationFailure(error))
    }
    this.notify()
    this.scheduleRefresh()
  }

  /**
   * Return the current SDK client and the signal aborted when its local authorization is withdrawn.
   * @returns the active client lifetime, or undefined when no client is admitted.
   */
  sdkSession(): AcosmiSdkSession | undefined {
    const client = this.clientValue
    const abort = this.clientAbort
    return client === undefined || abort === undefined
      ? undefined
      : { client, signal: abort.signal }
  }

  /** Observe the current detached snapshot immediately and later changes until the owner unloads. */
  subscribe(owner: Context, listener: AcosmiAccountListener): () => void {
    const { listeners } = this
    const publish = (): void => { this.notifyListener(listener) }
    return owner.effect(function* () {
      listeners.add(listener)
      publish()
      yield () => { listeners.delete(listener) }
    }, 'acosmi-account.subscription')
  }

  /** Discover the current model catalog for the LLM provider. */
  async models(signal?: AbortSignal): Promise<{ models: ManagedModel[]; status: string }> {
    const session = this.requireAuthorizedSession()
    const activeSignal = signal === undefined
      ? session.signal
      : AbortSignal.any([signal, session.signal])
    try {
      const catalog = await session.client.listModelsWithStatus(activeSignal, { includeLocked: true })
      const current = this.sdkSession()
      if (activeSignal.aborted
        || current?.client !== session.client
        || current.signal !== session.signal
        || !session.client.isAuthorized()) {
        throw abortReason(activeSignal)
      }
      return catalog
    } catch (error) {
      if (isSecretStorageFailure(error)) {
        this.setUnavailable(accountActionFailure(error))
        this.notify()
      }
      throw error
    }
  }

  /** Describe the account without exposing secrets or stable account identifiers. */
  @Remote('describe')
  describe(): Promise<AcosmiAccountSnapshot> {
    return Promise.resolve(structuredClone(this.snapshotValue))
  }

  /** Start one state-checked system-browser OAuth flow. */
  @Remote('login')
  async login(signal?: AbortSignal): Promise<AcosmiAccountActionResult> {
    if (this.stopping) {
      return { ok: false, code: 'cancelled', message: 'Login was cancelled.' }
    }
    if (!this.loginEnabled) {
      return { ok: false, code: 'login-disabled', message: 'Acosmi sign-in is disabled for this build.' }
    }
    if (this.logoutTask !== undefined) {
      return failedAccountAction('operation-in-progress', SIGN_IN_FAILED)
    }
    const current = this.sdkSession()
    if (current?.client.isAuthorized() === true) {
      return { ok: true, account: structuredClone(this.snapshotValue) }
    }
    if (this.loginTask !== undefined) return this.loginTask
    const loginAbort = new AbortController()
    this.loginAbort = loginAbort
    const task = this.loginInternal(signal, loginAbort.signal)
    this.loginTask = task
    try {
      return await task
    } finally {
      if (this.loginTask === task) this.loginTask = undefined
      if (this.loginAbort === loginAbort) this.loginAbort = undefined
    }
  }

  private async loginInternal(
    signal: AbortSignal | undefined,
    operationSignal: AbortSignal,
  ): Promise<AcosmiAccountActionResult> {
    const browserAbort = new AbortController()
    const timeoutSignal = AbortSignal.timeout(this.loginTimeoutMs)
    const loginSignal = AbortSignal.any([
      this.lifetimeAbort.signal,
      operationSignal,
      browserAbort.signal,
      timeoutSignal,
      ...(signal === undefined ? [] : [signal]),
    ])
    let browserError: unknown
    let browserTask: Promise<void> | undefined
    let client: Client | undefined
    let opened = false
    let failureReason: AcosmiAccountFailureReason | undefined
    const handleEvent = (event: LoginEvent): void => {
      if (event.type === EventError) {
        failureReason ??= loginEventFailureReason(event.err_code)
        return
      }
      if (event.type !== EventAuthURL) return
      if (opened || typeof event.url !== 'string') {
        browserError = new Error('SDK emitted an invalid authorization URL sequence')
        failureReason = 'oauth-protocol-failed'
        browserAbort.abort(browserError)
        return
      }
      opened = true
      browserTask = this.ctx.acosmiOAuthBrowser.open(event.url)
      void browserTask.catch((error: unknown) => {
        browserError = error
        failureReason = 'browser-open-failed'
        browserAbort.abort(error)
      })
    }
    try {
      client = this.clientValue ?? await this.createClientAfterPreflight()
      if (client.isAuthorized()) {
        await this.projectAuthorizedLogin(loginSignal)
        return { ok: true, account: structuredClone(this.snapshotValue) }
      }
      await client.loginWithHandler(
        this.oauthAppName,
        modelScopes(),
        handleEvent,
        { skipBrowser: true },
        loginSignal,
      )
      if (!opened || browserTask === undefined) {
        failureReason = 'oauth-protocol-failed'
        throw new Error('SDK completed login without an authorization URL')
      }
      await waitForSignal(browserTask, loginSignal)
      await this.projectAuthorizedLogin(loginSignal)
      return { ok: true, account: structuredClone(this.snapshotValue) }
    } catch (error) {
      let actionError = browserError ?? error
      let cleanupFailure: unknown | undefined
      if (isSecretStorageFailure(error)) {
        this.setUnavailable(accountActionFailure(error))
      } else {
        cleanupFailure = client === undefined ? undefined : await this.discardFailedLogin(client)
        if (cleanupFailure === undefined) this.snapshotValue = this.signedOutSnapshot()
        else {
          actionError = cleanupFailure
          this.setUnavailable(accountActionFailure(cleanupFailure))
        }
      }
      this.notify()
      const storageFailure = isSecretStorageFailure(actionError)
      const cancelled = !storageFailure && cleanupFailure === undefined
        && (signal?.aborted === true || operationSignal.aborted)
      if (cancelled) return { ok: false, code: 'cancelled', message: 'Login was cancelled.' }
      return failedAccountAction(
        storageFailure
          ? 'secure-storage-unavailable'
          : failureReason
            ?? (timeoutSignal.aborted ? 'authorization-timeout' : 'account-operation-failed'),
        accountActionFailure(actionError),
      )
    }
  }

  /** Refresh quota and model-status projections. */
  @Remote('refresh')
  refresh(signal?: AbortSignal): Promise<AcosmiAccountActionResult> {
    if (this.refreshTask !== undefined) return this.refreshTask
    const task = this.refreshOnce(signal)
    this.refreshTask = task
    const settle = (): void => {
      if (this.refreshTask !== task) return
      this.refreshTask = undefined
      this.scheduleRefresh()
    }
    void task.then(settle, settle)
    return task
  }

  private async refreshOnce(signal?: AbortSignal): Promise<AcosmiAccountActionResult> {
    const startingSession = this.sdkSession()
    const timeoutSignal = AbortSignal.timeout(this.refreshTimeoutMs)
    const activeSignal = AbortSignal.any([
      this.lifetimeAbort.signal,
      timeoutSignal,
      ...(signal === undefined ? [] : [signal]),
    ])
    try {
      await this.refreshInternal(activeSignal)
      this.notify()
      return { ok: true, account: structuredClone(this.snapshotValue) }
    } catch (error) {
      if (isSecretStorageFailure(error)) {
        const message = accountActionFailure(error)
        this.setUnavailable(message)
        this.notify()
        return failedAccountAction('secure-storage-unavailable', message)
      }
      const currentSession = this.sdkSession()
      if (this.stopping
        || this.lifetimeAbort.signal.aborted
        || signal?.aborted === true
        || startingSession?.signal.aborted === true
        || (startingSession !== undefined
          && (currentSession?.client !== startingSession.client
            || currentSession.signal !== startingSession.signal))) {
        return { ok: false, code: 'cancelled', message: 'Account refresh was cancelled.' }
      }
      const client = this.clientValue
      this.snapshotValue = client === undefined
        ? this.unavailableSnapshot(ACCOUNT_DATA_UNAVAILABLE)
        : client.isAuthorized()
          ? {
              ...this.snapshotValue,
              status: 'degraded',
              pollAfterMs: this.projectionPollIntervalMs,
              updatedAt: Date.now(),
              message: ACCOUNT_DATA_UNAVAILABLE,
            }
          : this.signedOutSnapshot()
      this.notify()
      return { ok: false, code: 'offline', message: 'Acosmi account data is temporarily unavailable.' }
    }
  }

  /** Clear local authorization before best-effort remote revocation. */
  @Remote('logout')
  async logout(signal?: AbortSignal): Promise<AcosmiAccountActionResult> {
    if (this.stopping) {
      return failedAccountAction('service-stopping', 'Acosmi sign-out could not be completed.')
    }
    if (this.logoutTask !== undefined) return this.logoutTask
    const task = this.logoutInternal(signal)
    this.logoutTask = task
    try {
      return await task
    } finally {
      if (this.logoutTask === task) this.logoutTask = undefined
    }
  }

  private async logoutInternal(signal?: AbortSignal): Promise<AcosmiAccountActionResult> {
    this.loginAbort?.abort(new Error('Acosmi sign-out cancelled the active sign-in'))
    if (this.loginTask !== undefined) await this.loginTask
    const client = this.clientValue
    this.destroyClient(new Error('Acosmi account signed out'))
    try {
      await this.store.clear()
    } catch (error) {
      this.snapshotValue = this.unavailableSnapshot(accountActionFailure(error))
      this.notify()
      return failedAccountAction(accountFailureReason(error), accountActionFailure(error))
    }
    this.snapshotValue = this.signedOutSnapshot()
    this.notify()
    if (client !== undefined && !await this.revokeRemote(client, signal)) {
      this.snapshotValue = this.signedOutSnapshot(REMOTE_REVOCATION_UNCONFIRMED)
      this.notify()
    }
    return { ok: true, account: structuredClone(this.snapshotValue) }
  }

  private async revokeRemote(client: Client, signal?: AbortSignal): Promise<boolean> {
    const timeoutAbort = new AbortController()
    const revokeSignal = AbortSignal.any([
      this.lifetimeAbort.signal,
      timeoutAbort.signal,
      ...(signal === undefined ? [] : [signal]),
    ])
    let timeout: ReturnType<typeof setTimeout> | undefined
    let removeAbortListener: (() => void) | undefined
    const interrupted = new Promise<false>(resolve => {
      const finish = (): void => { resolve(false) }
      if (revokeSignal.aborted) {
        finish()
        return
      }
      revokeSignal.addEventListener('abort', finish, { once: true })
      removeAbortListener = () => { revokeSignal.removeEventListener('abort', finish) }
      timeout = setTimeout(() => {
        timeoutAbort.abort(new Error('Acosmi remote revocation timed out'))
      }, this.logoutTimeoutMs)
    })
    const remote = Promise.resolve()
      .then(() => client.logout(revokeSignal))
      .then(() => true, () => false)
    try {
      return await Promise.race([remote, interrupted])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      removeAbortListener?.()
    }
  }

  private async createClientAfterPreflight(): Promise<Client> {
    const stored = await this.store.load()
    const client = await this.createSdkClient(stored)
    this.assertPreflightAuthorization(client, stored)
    this.publishClient(client)
    return client
  }

  private async createSdkClient(stored: TokenSet | null): Promise<Client> {
    const store = new PreflightTokenStore(this.store, stored)
    try {
      const client = await Client.create({
        baseURL: this.baseUrl,
        store,
        fetchImpl: this.fetchImpl,
        retryPolicy: DefaultRetryPolicy,
      })
      client.setAutoStripEphemeralHistory(true)
      return client
    } finally {
      store.activate()
    }
  }

  private assertPreflightAuthorization(client: Client, stored: TokenSet | null): void {
    if (client.isAuthorized() !== (stored !== null)) {
      throw new Error('Acosmi token store preflight disagrees with initialized SDK authorization')
    }
  }

  private async projectAuthorizedLogin(signal: AbortSignal): Promise<void> {
    const projectionSignal = AbortSignal.any([signal, AbortSignal.timeout(this.refreshTimeoutMs)])
    try {
      await this.refreshInternal(projectionSignal)
    } catch (error) {
      if (isSecretStorageFailure(error) || signal.aborted) throw error
      this.snapshotValue = {
        status: 'degraded',
        loginAvailable: this.loginEnabled,
        label: 'Acosmi member',
        pollAfterMs: this.projectionPollIntervalMs,
        updatedAt: Date.now(),
        message: ACCOUNT_DATA_UNAVAILABLE,
      }
    }
    this.notify()
    this.scheduleRefresh()
  }

  private async refreshInternal(signal: AbortSignal): Promise<void> {
    const session = this.requireAuthorizedSession()
    const activeSignal = AbortSignal.any([signal, session.signal])
    const [quota, catalog, marketing] = await waitForSignal(Promise.all([
      session.client.getQuotaSummary(activeSignal),
      session.client.listModelsWithStatus(activeSignal, { includeLocked: true }),
      marketingProjection(session.client, activeSignal),
    ]), activeSignal)
    const current = this.sdkSession()
    if (activeSignal.aborted
      || current?.client !== session.client
      || current.signal !== session.signal) {
      throw abortReason(activeSignal)
    }
    const expiry = nextExpiry(quota.nextFreeExpiresAt, quota.nextPaidExpiresAt)
    this.snapshotValue = {
      status: catalog.status === 'ok' ? 'ready' : 'degraded',
      loginAvailable: this.loginEnabled,
      label: 'Acosmi member',
      quota: {
        freeRemainingEtu: quota.freeTotalEtu,
        paidRemainingEtu: quota.paidTotalEtu,
        ...expiry === undefined
          ? {}
          : { nextExpiry: expiry },
      },
      modelStatus: catalog.status,
      pollAfterMs: this.projectionPollIntervalMs,
      ...marketing.membership === undefined ? {} : { membership: marketing.membership },
      updatedAt: Date.now(),
      ...(catalog.status !== 'ok'
        ? { message: 'Model availability is degraded while the entitlement service recovers.' }
        : {}),
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) this.notifyListener(listener)
  }

  private notifyListener(listener: AcosmiAccountListener): void {
    try {
      listener(structuredClone(this.snapshotValue))
    } catch (_observerFailure) {
      this.ctx.logger.warn('acosmi-account: state observer failed')
    }
  }

  private requireAuthorizedSession(): AcosmiSdkSession {
    const session = this.sdkSession()
    if (session === undefined || !session.client.isAuthorized()) throw new Error('Acosmi account is not signed in')
    return session
  }

  private signedOutSnapshot(message?: string): AcosmiAccountSnapshot {
    return {
      status: this.loginEnabled ? 'signed-out' : 'login-disabled',
      loginAvailable: this.loginEnabled,
      label: 'Acosmi membership',
      updatedAt: Date.now(),
      ...(message === undefined ? {} : { message }),
    }
  }

  private unavailableSnapshot(message: string): AcosmiAccountSnapshot {
    return {
      status: 'unavailable',
      loginAvailable: this.loginEnabled,
      label: 'Acosmi membership',
      updatedAt: Date.now(),
      message,
    }
  }

  private setUnavailable(message: string): void {
    this.destroyClient(new Error('Acosmi account authorization became unavailable'))
    this.snapshotValue = this.unavailableSnapshot(message)
  }

  private publishClient(client: Client): void {
    this.destroyClient(new Error('Acosmi SDK client was replaced'))
    this.clientValue = client
    this.clientAbort = new AbortController()
  }

  private destroyClient(reason: Error): void {
    this.clearRefreshTimer()
    this.clientAbort?.abort(reason)
    this.clientAbort = undefined
    this.clientValue = undefined
  }

  private scheduleRefresh(): void {
    this.clearRefreshTimer()
    const session = this.sdkSession()
    if (this.stopping || this.refreshTask !== undefined
      || session === undefined || !session.client.isAuthorized()) return
    const jitter = this.refreshJitterMs === 0
      ? 0
      : Math.floor(Math.random() * (this.refreshJitterMs + 1))
    const delay = this.refreshIntervalMs + jitter
    const timer = setTimeout(() => {
      if (this.refreshTimer !== timer) return
      this.refreshTimer = undefined
      void this.refresh(this.lifetimeAbort.signal)
    }, delay)
    timer.unref?.()
    this.refreshTimer = timer
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer === undefined) return
    clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
  }

  private async discardFailedLogin(client: Client): Promise<unknown | undefined> {
    const revoke = client.isAuthorized()
    this.destroyClient(new Error('Acosmi sign-in failed'))
    try {
      await this.store.clear()
    } catch (error) {
      return error
    }
    if (revoke) await this.revokeRemote(client)
    return undefined
  }
}

/** Cordis plugin entry. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const service = new AcosmiAccountService(ctx, config)
  await service.start()
}

/**
 * Create the product fetch wrapper that pins every SDK request and OAuth
 * discovery endpoint to the configured HTTPS issuer.
 * @param baseUrl - validated production Acosmi origin.
 * @returns SDK-compatible fetch implementation.
 */
export function createAcosmiProductFetch(baseUrl: string, productVersion: string): typeof fetch {
  const origin = validateAcosmiBaseUrl(baseUrl)
  const productIdentity = {
    product: 'dsh-gui',
    version: validateProductVersion(productVersion),
    url: 'https://github.com/acosmi/DS-Harness-GUI',
  } as const
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = new URL(input instanceof Request ? input.url : input)
    if (target.origin !== origin || target.protocol !== 'https:'
      || target.username !== '' || target.password !== '') {
      throw new Error('Acosmi SDK request was blocked by the product origin policy')
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    for (const [name, value] of new Headers(init?.headers)) headers.set(name, value)
    for (const [name, value] of Object.entries(attributionHeaders(productIdentity))) headers.set(name, value)
    const response = await globalThis.fetch(input, { ...init, headers, redirect: 'error' })
    if (target.pathname === '/.well-known/oauth-authorization-server/desktop' && response.ok) {
      await validateDiscoveryResponse(response.clone(), origin)
    }
    return response
  }
}

function validateProductVersion(value: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error('Acosmi product version is invalid')
  }
  return value
}

function validateAcosmiBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.origin !== 'https://acosmi.com' || url.pathname !== '/'
    || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('account-acosmi: gatewayBaseUrl must be the production Acosmi HTTPS origin')
  }
  return url.origin
}

function validateOAuthAppName(value: string): string {
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > 80 || normalized !== value) {
    throw new Error('account-acosmi: oauthAppName must be 1-80 trimmed characters')
  }
  return normalized
}

function validateRefreshPolicy(config: Config): void {
  if (config.refreshJitterMs > config.refreshIntervalMs) {
    throw new Error('account-acosmi: refreshJitterMs must not exceed refreshIntervalMs')
  }
}

async function validateDiscoveryResponse(response: Response, origin: string): Promise<void> {
  let value: unknown
  try {
    value = await response.json()
  } catch (cause) {
    throw new Error('account-acosmi: OAuth discovery response is not JSON', { cause })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('account-acosmi: OAuth discovery response is not an object')
  }
  const record = value as Record<string, unknown>
  const endpoints = {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/desktop/authorize`,
    token_endpoint: `${origin}/oauth/desktop/token`,
    registration_endpoint: `${origin}/oauth/desktop/register`,
    revocation_endpoint: `${origin}/oauth/desktop/revoke`,
  }
  for (const [name, expected] of Object.entries(endpoints)) {
    if (record[name] !== expected) throw new Error(`account-acosmi: OAuth discovery ${name} is not trusted`)
  }
  if (!stringArray(record.scopes_supported).includes('ai')
    || !stringArray(record.response_types_supported).includes('code')
    || !stringArray(record.code_challenge_methods_supported).includes('S256')
    || !stringArray(record.token_endpoint_auth_methods_supported).includes('none')) {
    throw new Error('account-acosmi: OAuth discovery capabilities are incompatible')
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string') ? value : []
}

async function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal)
  let removeAbortListener: (() => void) | undefined
  const interrupted = new Promise<never>((_resolve, reject) => {
    const abort = (): void => { reject(abortReason(signal)) }
    signal.addEventListener('abort', abort, { once: true })
    removeAbortListener = () => { signal.removeEventListener('abort', abort) }
  })
  try {
    return await Promise.race([operation, interrupted])
  } finally {
    removeAbortListener?.()
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Acosmi account operation aborted')
}

function accountInitializationFailure(error: unknown): string {
  return isSecretStorageFailure(error)
    ? 'Secure account storage is unavailable.'
    : 'Acosmi account initialization is temporarily unavailable.'
}

function accountActionFailure(error: unknown): string {
  return isSecretStorageFailure(error) ? 'Secure account storage is unavailable.' : SIGN_IN_FAILED
}

function accountFailureReason(error: unknown): AcosmiAccountFailureReason {
  return isSecretStorageFailure(error) ? 'secure-storage-unavailable' : 'account-operation-failed'
}

function failedAccountAction(
  reason: AcosmiAccountFailureReason,
  message: string,
): Extract<AcosmiAccountActionResult, { readonly code: 'failed' }> {
  return { ok: false, code: 'failed', reason, message }
}

function loginEventFailureReason(code: LoginErrCode | undefined): AcosmiAccountFailureReason {
  switch (code) {
    case 'discovery_failed': return 'oauth-discovery-failed'
    case 'registration_failed': return 'oauth-registration-failed'
    case 'browser_open_failed': return 'browser-open-failed'
    case 'auth_denied': return 'authorization-denied'
    case 'auth_timeout': return 'authorization-timeout'
    case 'token_exchange_failed': return 'token-exchange-failed'
    case 'ssl_proxy_detected': return 'tls-proxy-detected'
    case 'state_mismatch': return 'state-mismatch'
    case undefined: return 'oauth-protocol-failed'
    /* v8 ignore next -- closed SDK login-code union */
    default: return assertNever(code)
  }
}

/* v8 ignore next 3 -- closed SDK login-code union backstop */
function assertNever(value: never): never {
  throw new Error(`Unhandled Acosmi login failure code: ${JSON.stringify(value)}`)
}

function isSecretStorageFailure(error: unknown): boolean {
  let current: unknown = error
  const seen = new Set<unknown>()
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    if (current instanceof DesktopTokenStoreError
      || /^save tokens: Acosmi token store(?:\s|$)/u.test(current.message)) return true
    current = current.cause
  }
  return false
}

function nextExpiry(left: string | undefined, right: string | undefined): string | undefined {
  return [left, right].filter((value): value is string => value !== undefined).sort()[0]
}

async function marketingProjection(
  client: Client,
  signal: AbortSignal,
): Promise<{
  membership?: NonNullable<AcosmiAccountSnapshot['membership']>
}> {
  try {
    const membership = await client.getMembership(signal)
    if (!membership.hasActive) return {}
    return {
      membership: {
        planName: membership.planName,
        ...(membership.expiresAt === '' ? {} : { expiresAt: membership.expiresAt }),
      },
    }
  } catch (error) {
    if (isSecretStorageFailure(error)) throw error
    // Account and model access remain usable when the optional marketing evidence endpoint is unavailable.
    return {}
  }
}
