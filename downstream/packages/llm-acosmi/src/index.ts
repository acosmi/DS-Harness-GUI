/** Acosmi managed-model provider for the DeepSeek Harness LLM seam. */

import {
  BusinessError,
  HTTPError,
  ModelNotFoundError,
  NetworkError,
  StreamError,
  type ManagedModel,
} from '@acosmi/sdk-ts'
import type {
  AcosmiAccountService,
  AcosmiAccountSnapshot,
  AcosmiSdkSession,
} from '@acosmi/dsh-account-acosmi'
import { type Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  resolveRetryPolicy,
  type ResolvedRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import {
  acosmiPublicFailureMessage,
  mapAcosmiToolNameCollisionError,
  mapAcosmiWindowLimitError,
} from './errors.ts'
import { serializeAcosmiRequest } from './serialize.ts'
import { translateAcosmiStream } from './translate.ts'

export {
  ACOSMI_TOOL_NAME_COLLISION_CODE,
  ACOSMI_WINDOW_LIMIT_CODE,
} from './errors.ts'

const PROVIDER = 'acosmi'
const STREAM_IDLE_TIMEOUT_CODE = 'ACOSMI_STREAM_IDLE_TIMEOUT'
const SDK_OWNED_RETRY_POLICY = resolveRetryPolicy(
  { mode: 'normal', maxRetries: 0 },
  'llm-acosmi: Harness retry disabled because the SDK owns request retries',
)

interface AcosmiRequestAdmission {
  readonly routeSignal: AbortSignal
  readonly session: AcosmiSdkSession
}

/** Deployment-owned defaults for Acosmi managed-model requests. */
export interface Config {
  /** Default per-request output cap; explicit request values remain authoritative. */
  readonly maxTokens: number
  /** Maximum silence between provider stream events in milliseconds. */
  readonly streamIdleTimeoutMs: number
}

/** Validate Acosmi request defaults at plugin load. */
export const Config: s<Config> = s.object({
  maxTokens: s.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  streamIdleTimeoutMs: s.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
})

/** LLM adapter backed by one account service and its authenticated SDK client. */
export class AcosmiAdapter extends LlmAdapter {
  private accountAbort: AbortController | undefined = new AbortController()

  /**
   * @param account - authenticated Acosmi SDK lifecycle owner.
   * @param defaultMaxTokens - deployment-owned per-request output cap.
   * @param streamIdleTimeoutMs - deployment-owned silence limit for provider events.
  */
  constructor(
    private readonly account: AcosmiAccountService,
    private readonly defaultMaxTokens: number,
    private readonly streamIdleTimeoutMs: number,
  ) {
    super()
  }

  /**
   * Admit new streams while ready and abort every admitted stream when account access is withdrawn.
   * @param ready - whether the account route currently admits model requests.
   */
  setAccountReady(ready: boolean): void {
    if (ready) {
      if (this.accountAbort === undefined || this.accountAbort.signal.aborted) {
        this.accountAbort = new AbortController()
      }
      return
    }
    this.accountAbort?.abort(new Error('Acosmi account route became unavailable'))
    this.accountAbort = undefined
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Acosmi membership · account quota' }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    assertProvider(provider)
    return SDK_OWNED_RETRY_POLICY
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    assertProvider(provider)
    let catalog: Awaited<ReturnType<AcosmiAccountService['models']>>
    try {
      catalog = await this.account.models()
    } catch {
      return []
    }
    if (catalog.status !== 'ok') return []
    return catalog.models.filter(isSelectable).map(model => ({
      provider,
      id: model.id,
      name: accountModelName(model.name),
      description: `${model.provider} · ${model.modelId}`,
      inputModalities: ['text'],
    }))
  }

  override async resolveModel(
    provider: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    assertProvider(provider)
    const model = await this.resolveSelectableModel(modelId, signal)
    const efforts = reasoningEfforts(model)
    return {
      provider,
      id: model.id,
      name: accountModelName(model.name),
      description: `${model.provider} · ${model.modelId}`,
      inputModalities: ['text'],
      ...(model.contextWindow === undefined || model.contextWindow <= 0
        ? {}
        : { context: { contextWindow: model.contextWindow } }),
      defaultMaxTokens: this.defaultMaxTokens,
      ...(efforts.length === 0 ? {} : { reasoning: { efforts } }),
    }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    assertProvider(options.provider)
    const admission = this.admitRequest()
    const model = await this.resolveSelectableModel(options.model, options.signal, admission)
    this.assertAdmissionCurrent(admission)
    const { routeSignal: accountSignal, session } = admission
    const request = serializeAcosmiRequest(options, model)
    const consumer = new AbortController()
    const upstream = AbortSignal.any([
      consumer.signal,
      accountSignal,
      session.signal,
      ...(options.signal === undefined ? [] : [options.signal]),
    ])
    using watchdog = idleWatchdog(upstream, this.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const translated = translateAcosmiStream(
      session.client.chatMessagesStream(model.id, request, watchdog.signal, () => { watchdog.pulse() }),
      model.id,
    )
    const iterator = translated[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error) {
      throw mapAcosmiError(
        error,
        options.signal,
        watchdog.signal,
        accountSignal,
        session.signal,
        this.streamIdleTimeoutMs,
      )
    } finally {
      consumer.abort('Acosmi stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer abort already owns stream termination.
        }
      }
    }
  }

  private async resolveSelectableModel(
    modelId: string,
    signal?: AbortSignal,
    admission?: AcosmiRequestAdmission,
  ): Promise<ManagedModel> {
    const accountSignal = admission?.routeSignal ?? this.accountAbort?.signal
    const sessionSignal = admission?.session.signal ?? this.account.sdkSession()?.signal
    let catalog: Awaited<ReturnType<AcosmiAccountService['models']>>
    try {
      catalog = await this.account.models(signal)
    } catch (error) {
      throw mapAcosmiError(
        error,
        signal,
        signal,
        accountSignal,
        sessionSignal,
        this.streamIdleTimeoutMs,
      )
    }
    if (admission !== undefined) this.assertAdmissionCurrent(admission)
    if (catalog.status !== 'ok') {
      throw new LlmError('Acosmi entitlement status is unavailable; model selection is disabled.', 'ENTITLEMENT_UNAVAILABLE')
    }
    const model = catalog.models.find(candidate => candidate.id === modelId)
    if (model === undefined) throw new LlmError(`Acosmi model "${modelId}" is not in the current catalog.`, 'UNKNOWN_MODEL')
    if (!isSelectable(model)) {
      throw new LlmError(`Acosmi model "${modelId}" is locked or unavailable for chat.`, 'MODEL_UNAVAILABLE')
    }
    return model
  }

  private admitRequest(): AcosmiRequestAdmission {
    const session = this.account.sdkSession()
    const routeSignal = this.accountAbort?.signal
    if (session === undefined || !session.client.isAuthorized()
      || routeSignal === undefined || routeSignal.aborted) {
      throw new LlmError('Acosmi account is not signed in.', 'MISSING_CREDENTIAL')
    }
    return { routeSignal, session }
  }

  private assertAdmissionCurrent(admission: AcosmiRequestAdmission): void {
    const current = this.account.sdkSession()
    if (admission.routeSignal.aborted
      || admission.session.signal.aborted
      || !admission.session.client.isAuthorized()
      || this.accountAbort?.signal !== admission.routeSignal
      || current?.client !== admission.session.client
      || current.signal !== admission.session.signal) {
      throw new LlmError('Acosmi authorization ended while this request was active.', 'AUTH')
    }
  }
}

/**
 * Mount or withdraw the Acosmi route atomically as account state changes.
 * @param ctx - Host context carrying the LLM and Acosmi account services.
 * @param config - validated request defaults for this deployment.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const adapter = new AcosmiAdapter(ctx.acosmiAccount, config.maxTokens, config.streamIdleTimeoutMs)
  let registration: ReturnType<Context['llm']['registerAdapter']> | undefined
  let generation = 0
  let discoveryAbort: AbortController | undefined
  let latestReconciliation: Promise<void> = Promise.resolve()

  const withdraw = (): void => {
    adapter.setAccountReady(false)
    registration?.replace([])
  }
  const confirmModels = async (current: number, abort: AbortController): Promise<void> => {
    let catalog: Awaited<ReturnType<AcosmiAccountService['models']>>
    try {
      catalog = await ctx.acosmiAccount.models(abort.signal)
    } catch {
      return
    }
    if (abort.signal.aborted || current !== generation
      || catalog.status !== 'ok' || !catalog.models.some(isSelectable)) return
    adapter.setAccountReady(true)
    if (registration === undefined) registration = ctx.llm.registerAdapter([PROVIDER], adapter)
    else registration.replace([PROVIDER])
  }
  const reconcile = (snapshot: AcosmiAccountSnapshot): void => {
    const current = ++generation
    discoveryAbort?.abort(new Error('Acosmi account model confirmation was superseded'))
    discoveryAbort = undefined
    withdraw()
    if (snapshot.status !== 'ready') {
      latestReconciliation = Promise.resolve()
      return
    }
    const abort = new AbortController()
    discoveryAbort = abort
    latestReconciliation = confirmModels(current, abort)
  }

  ctx.effect(() => () => {
    generation++
    discoveryAbort?.abort(new Error('Acosmi provider plugin stopped'))
    adapter.setAccountReady(false)
  }, 'llm-acosmi.authorization')
  ctx.acosmiAccount.subscribe(ctx, reconcile)
  while (true) {
    const observedGeneration = generation
    const observedTask = latestReconciliation
    await observedTask
    if (observedGeneration === generation && observedTask === latestReconciliation) break
  }
}

/** Services required by the Acosmi provider plugin. */
export const inject = ['llm', 'acosmiAccount']

function isSelectable(model: ManagedModel): boolean {
  return model.isEnabled
    && model.locked !== true
    && model.chatRuntimeSupported !== false
    && model.capabilities.supports_image_generation !== true
    && model.capabilities.supports_video_generation !== true
    && model.capabilities.supports_embedding !== true
    && model.capabilities.supports_rerank !== true
}

function accountModelName(name: string): string {
  return `Acosmi · ${name}`
}

function reasoningEfforts(model: ManagedModel): Array<{ id: ReasoningEffortId; name: string }> {
  const caps = model.capabilities
  if (!caps.supports_thinking && !caps.supports_adaptive_thinking) return []
  const efforts = [{ id: ReasoningEffortId('off'), name: 'Off' }]
  if (caps.supports_effort) efforts.push({ id: ReasoningEffortId('high'), name: 'High' })
  if (caps.supports_effort && caps.supports_max_effort) {
    efforts.push({ id: ReasoningEffortId('max'), name: 'Maximum' })
  }
  return efforts
}

function assertProvider(provider: string): void {
  if (provider !== PROVIDER) throw new LlmError(`Acosmi adapter does not own provider "${provider}".`, 'NO_ADAPTER')
}

function mapAcosmiError(
  error: unknown,
  caller: AbortSignal | undefined,
  active: AbortSignal | undefined,
  accountRoute: AbortSignal | undefined,
  sdkSession: AbortSignal | undefined,
  streamIdleTimeoutMs: number,
): LlmError {
  if (caller?.aborted === true) return new LlmError('Acosmi request aborted by caller.', 'ABORTED', { cause: error })
  if (active !== undefined && timeoutOf(active, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
    return new LlmError(`Acosmi stream idle timeout after ${String(streamIdleTimeoutMs)}ms.`, 'TIMEOUT', { cause: error })
  }
  if (accountRoute?.aborted === true || sdkSession?.aborted === true) {
    return new LlmError('Acosmi authorization ended while this request was active.', 'AUTH', { cause: error })
  }
  if (error instanceof LlmError) return error
  const windowLimit = mapAcosmiWindowLimitError(error)
  if (windowLimit !== undefined) return windowLimit
  const toolNameCollision = mapAcosmiToolNameCollisionError(error)
  if (toolNameCollision !== undefined) return toolNameCollision
  const detail = error instanceof Error ? error.message : String(error)
  if (isContextWindowExceededError(detail)) {
    return new LlmError(
      acosmiPublicFailureMessage(CONTEXT_WINDOW_EXCEEDED_CODE),
      CONTEXT_WINDOW_EXCEEDED_CODE,
      { cause: error },
    )
  }
  if (isQuotaExceededError(detail)) {
    return new LlmError(acosmiPublicFailureMessage(QUOTA_EXCEEDED_CODE), QUOTA_EXCEEDED_CODE, { cause: error })
  }
  if (error instanceof HTTPError) {
    const code = error.statusCode === 401 || error.statusCode === 403
      ? 'AUTH'
      : error.statusCode === 429
        ? 'RATE_LIMIT'
        : error.statusCode >= 500
          ? 'SERVER'
          : 'PROVIDER'
    return new LlmError(acosmiPublicFailureMessage(code), code, {
      status: error.statusCode,
      ...(error.retryAfter > 0 ? { providerRetryAfterMs: error.retryAfter * 1000 } : {}),
      cause: error,
    })
  }
  if (error instanceof NetworkError) {
    const code = error.isTimeout() ? 'TIMEOUT' : 'TRANSPORT'
    return new LlmError(acosmiPublicFailureMessage(code), code, { cause: error })
  }
  if (error instanceof StreamError) {
    const code = error.code.includes('rate_limit')
      ? 'RATE_LIMIT'
      : error.code.includes('overload')
        ? 'SERVER'
        : error.code === 'empty_response'
          ? 'EMPTY_RESPONSE'
          : error.retryable ? 'TRANSPORT' : 'PROVIDER'
    return new LlmError(acosmiPublicFailureMessage(code), code, { cause: error })
  }
  if (error instanceof ModelNotFoundError) {
    return new LlmError(acosmiPublicFailureMessage('UNKNOWN_MODEL'), 'UNKNOWN_MODEL', { cause: error })
  }
  if (error instanceof BusinessError) {
    return new LlmError(acosmiPublicFailureMessage('PROVIDER'), 'PROVIDER', { cause: error })
  }
  return new LlmError(acosmiPublicFailureMessage('TRANSPORT'), 'TRANSPORT', { cause: error })
}
