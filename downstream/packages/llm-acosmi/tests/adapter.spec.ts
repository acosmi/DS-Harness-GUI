import { describe, expect, it, vi } from 'vitest'
import { HTTPError, type ManagedModel } from '@acosmi/sdk-ts'
import type { AcosmiAccountService } from '@acosmi/dsh-account-acosmi'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  ACOSMI_TOOL_NAME_COLLISION_CODE,
  ACOSMI_WINDOW_LIMIT_CODE,
  AcosmiAdapter,
  Config,
} from '../src/index.ts'

function managedModel(overrides: Partial<ManagedModel> = {}): ManagedModel {
  return {
    id: 'account-model',
    name: 'DeepSeek-v4-Flash',
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    maxTokens: 8192,
    contextWindow: 100_000,
    isEnabled: true,
    capabilities: {
      supports_thinking: true,
      supports_adaptive_thinking: true,
      supports_effort: true,
      supports_max_effort: false,
      supports_image_generation: false,
      supports_video_generation: false,
      supports_embedding: false,
      supports_rerank: false,
    },
    ...overrides,
  } as ManagedModel
}

function account(models: ManagedModel[]): AcosmiAccountService {
  const authorization = new AbortController()
  const session = {
    signal: authorization.signal,
    client: { isAuthorized: () => true },
  }
  return {
    models: async () => ({ status: 'ok', models }),
    sdkSession: () => session,
  } as unknown as AcosmiAccountService
}

function failingAccount(models: ManagedModel[], failure: unknown): AcosmiAccountService {
  const authorization = new AbortController()
  const session = {
    signal: authorization.signal,
    client: {
      isAuthorized: () => true,
      chatMessagesStream: async function* (): AsyncIterable<never> {
        throw failure
      },
    },
  }
  return {
    models: async () => ({ status: 'ok', models }),
    sdkSession: () => session,
  } as unknown as AcosmiAccountService
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const chunk of stream) void chunk
}

describe('Acosmi provider configuration', () => {
  it('requires a positive safe-integer request default', () => {
    expect(Config({ maxTokens: 8192, streamIdleTimeoutMs: 120_000 })).toEqual({
      maxTokens: 8192,
      streamIdleTimeoutMs: 120_000,
    })
    expect(() => Config({} as never)).toThrow()
    for (const maxTokens of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => Config({ maxTokens, streamIdleTimeoutMs: 120_000 })).toThrow()
    }
    for (const streamIdleTimeoutMs of [0, 1.5, 2_147_483_648]) {
      expect(() => Config({ maxTokens: 8192, streamIdleTimeoutMs })).toThrow()
    }
  })
})

describe('Acosmi account model catalog', () => {
  it('labels provider and model rows as membership-quota routes', async () => {
    const adapter = new AcosmiAdapter(account([
      managedModel(),
      managedModel({ id: 'locked', name: 'Locked', locked: true }),
    ]), 8192, 120_000)

    expect(adapter.providerInfo('acosmi')).toEqual({
      id: 'acosmi',
      name: 'Acosmi membership · account quota',
    })
    await expect(adapter.listModels('acosmi')).resolves.toEqual([{
      provider: 'acosmi',
      id: 'account-model',
      name: 'Acosmi · DeepSeek-v4-Flash',
      description: 'deepseek · deepseek-v4-flash',
      inputModalities: ['text'],
    }])
  })

  it('serves directory listing from the last confirmed catalog', async () => {
    const models = vi.fn(async () => ({ status: 'ok' as const, models: [managedModel()] }))
    const adapter = new AcosmiAdapter({
      models,
      sdkSession: () => ({
        signal: new AbortController().signal,
        client: { isAuthorized: () => true },
      }),
    } as unknown as AcosmiAccountService, 8192, 120_000)
    adapter.replaceCatalog([managedModel()])

    await expect(adapter.listModels('acosmi')).resolves.toEqual([{
      provider: 'acosmi',
      id: 'account-model',
      name: 'Acosmi · DeepSeek-v4-Flash',
      description: 'deepseek · deepseek-v4-flash',
      inputModalities: ['text'],
    }])
    expect(models).not.toHaveBeenCalled()
  })

  it('keeps the Acosmi source label on resolved session selections', async () => {
    const adapter = new AcosmiAdapter(account([managedModel({
      maxTokens: 1_000_000,
      contextWindow: 1_000_000,
    })]), 8192, 120_000)

    await expect(adapter.resolveModel('acosmi', 'account-model')).resolves.toMatchObject({
      provider: 'acosmi',
      id: 'account-model',
      name: 'Acosmi · DeepSeek-v4-Flash',
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 8192,
      reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] },
    })
  })

  it('leaves request retry ownership exclusively with the Acosmi SDK', () => {
    const adapter = new AcosmiAdapter(account([managedModel()]), 8192, 120_000)

    expect(adapter.providerRetryPolicy('acosmi')).toMatchObject({
      mode: 'normal',
      maxRetries: 0,
    })
    expect(() => adapter.providerRetryPolicy('other')).toThrow(/does not own provider/)
  })

  it('keeps rolling-window reservation rejection distinct from quota and rate limiting', async () => {
    const failure = new HTTPError(429, {
      message: '已达 7 天用量上限',
      errorCode: 'WINDOW_LIMIT_EXCEEDED',
      windowKind: 'WEEKLY',
    })
    const adapter = new AcosmiAdapter(failingAccount([managedModel({
      provider: 'moonshot',
      supported_formats: ['anthropic'],
      preferred_format: 'anthropic',
    })], failure), 8192, 120_000)

    await expect(drain(adapter.stream({
      provider: 'acosmi',
      model: 'account-model',
      messages: [],
    }))).rejects.toMatchObject({
      code: ACOSMI_WINDOW_LIMIT_CODE,
      message: 'Acosmi rolling-window reservation rejected this request.',
      failure: {
        code: ACOSMI_WINDOW_LIMIT_CODE,
        status: 429,
      },
    })
  })

  it('keeps a final provider tool-name collision distinct from an ordinary invalid request', async () => {
    const failure = new HTTPError(400, {
      message: 'Tool names must be unique.',
    })
    const adapter = new AcosmiAdapter(failingAccount([managedModel()], failure), 8192, 120_000)

    await expect(drain(adapter.stream({
      provider: 'acosmi',
      model: 'account-model',
      messages: [],
    }))).rejects.toMatchObject({
      code: ACOSMI_TOOL_NAME_COLLISION_CODE,
      message: 'Acosmi managed-model gateway produced duplicate final tool names.',
      failure: {
        code: ACOSMI_TOOL_NAME_COLLISION_CODE,
      },
    })
  })

  it('does not expose a generic SDK response body in the normalized failure', async () => {
    const failure = new HTTPError(500, {
      message: 'token=plain-secret account=private',
    })
    const adapter = new AcosmiAdapter(failingAccount([managedModel()], failure), 8192, 120_000)

    let observed: unknown
    try {
      await drain(adapter.stream({ provider: 'acosmi', model: 'account-model', messages: [] }))
    } catch (error) {
      observed = error
    }
    expect(observed).toMatchObject({
      code: 'SERVER',
      message: 'Acosmi managed-model service is temporarily unavailable.',
    })
    expect(JSON.stringify(observed)).not.toMatch(/plain-secret|private/u)
  })

  it('aborts an admitted provider stream when account readiness is withdrawn', async () => {
    const sdkAuthorization = new AbortController()
    const started = Promise.withResolvers<AbortSignal>()
    const session = {
      signal: sdkAuthorization.signal,
      client: {
        isAuthorized: () => true,
        chatMessagesStream: async function* (
          _model: string,
          _request: unknown,
          signal?: AbortSignal,
        ): AsyncIterable<never> {
          if (signal === undefined) throw new Error('missing provider abort signal')
          started.resolve(signal)
          await new Promise<void>((_resolve, reject) => {
            const abort = (): void => { reject(signal.reason) }
            if (signal.aborted) abort()
            else signal.addEventListener('abort', abort, { once: true })
          })
        },
      },
    }
    const service = {
      models: async () => ({ status: 'ok', models: [managedModel()] }),
      sdkSession: () => session,
    } as unknown as AcosmiAccountService
    const adapter = new AcosmiAdapter(service, 8192, 120_000)
    adapter.setAccountReady(true)

    const operation = drain(adapter.stream({
      provider: 'acosmi',
      model: 'account-model',
      messages: [],
    }))
    const providerSignal = await started.promise
    adapter.setAccountReady(false)

    await expect(operation).rejects.toMatchObject({
      code: 'AUTH',
      message: 'Acosmi authorization ended while this request was active.',
    })
    expect(providerSignal.aborted).toBe(true)
  })

  it('maps authorization withdrawal during model resolution from the captured SDK session', async () => {
    const authorization = new AbortController()
    const started = Promise.withResolvers<void>()
    const service = {
      models: async () => {
        started.resolve()
        return new Promise<never>((_resolve, reject) => {
          const abort = (): void => { reject(authorization.signal.reason) }
          if (authorization.signal.aborted) abort()
          else authorization.signal.addEventListener('abort', abort, { once: true })
        })
      },
      sdkSession: () => authorization.signal.aborted
        ? undefined
        : {
            signal: authorization.signal,
            client: { isAuthorized: () => true },
          },
    } as unknown as AcosmiAccountService
    const adapter = new AcosmiAdapter(service, 8192, 120_000)
    adapter.setAccountReady(true)

    const resolution = adapter.resolveModel('acosmi', 'account-model')
    await started.promise
    authorization.abort(new Error('signed out'))

    await expect(resolution).rejects.toMatchObject({
      code: 'AUTH',
      message: 'Acosmi authorization ended while this request was active.',
    })
  })

  it('does not dispatch an old account catalog through a replacement SDK session', async () => {
    const firstAuthorization = new AbortController()
    const secondAuthorization = new AbortController()
    const catalogStarted = Promise.withResolvers<void>()
    const lateCatalog = Promise.withResolvers<{ status: 'ok'; models: ManagedModel[] }>()
    const secondChat = vi.fn(async function* (): AsyncIterable<never> {})
    const firstClient = { isAuthorized: () => true }
    const secondClient = {
      isAuthorized: () => true,
      chatMessagesStream: secondChat,
    }
    let current = { signal: firstAuthorization.signal, client: firstClient }
    const service = {
      models: async () => {
        catalogStarted.resolve()
        return lateCatalog.promise
      },
      sdkSession: () => current,
    } as unknown as AcosmiAccountService
    const adapter = new AcosmiAdapter(service, 8192, 120_000)
    adapter.setAccountReady(true)

    const operation = drain(adapter.stream({
      provider: 'acosmi',
      model: 'account-model',
      messages: [],
    }))
    await catalogStarted.promise
    firstAuthorization.abort(new Error('first account signed out'))
    adapter.setAccountReady(false)
    current = { signal: secondAuthorization.signal, client: secondClient }
    adapter.setAccountReady(true)
    lateCatalog.resolve({ status: 'ok', models: [managedModel()] })

    await expect(operation).rejects.toMatchObject({
      code: 'AUTH',
      message: 'Acosmi authorization ended while this request was active.',
    })
    expect(secondChat).not.toHaveBeenCalled()
  })
})
