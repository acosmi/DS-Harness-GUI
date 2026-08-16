import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedModel, TokenSet } from '@acosmi/sdk-ts'
import { boot } from '@deepseek-ai/dsh-app-boot'
import * as llmPlugin from '@deepseek-ai/dsh-llm'
import type { DesktopSecretBridge } from '@acosmi/dsh-desktop-secrets'

import { provideDesktopSecrets } from '@acosmi/dsh-desktop-secrets'
import * as accountPlugin from '../../account-acosmi/src/index.ts'
import { provideAcosmiOAuthBrowser } from '../../account-acosmi/src/index.ts'
import * as acosmiLlmPlugin from '../../llm-acosmi/src/index.ts'

const CONFIG = resolve(import.meta.dirname, 'fixtures/acosmi-provider.cordis.yml')
const PLUGINS = new Map<string, object>([
  ['@deepseek-ai/dsh-llm', llmPlugin],
  ['@acosmi/dsh-account-acosmi', accountPlugin],
  ['@acosmi/dsh-llm-acosmi', acosmiLlmPlugin],
])

class MemorySecrets implements DesktopSecretBridge {
  readonly persistence = 'session-memory' as const
  readonly values = new Map<string, string>()
  async getEnvironmentCredential(): Promise<string | undefined> { return undefined }
  async hasEnvironmentCredential(): Promise<boolean> { return false }
  async get(key: string): Promise<string | undefined> { return this.values.get(key) }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value) }
  async delete(key: string): Promise<void> { this.values.delete(key) }
}

function managedModel(overrides: Partial<ManagedModel> = {}): ManagedModel {
  return {
    id: 'account-model',
    name: 'DeepSeek-v4-Flash',
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    maxTokens: 1_000_000,
    contextWindow: 1_000_000,
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

function authorizedSecrets(): MemorySecrets {
  const secrets = new MemorySecrets()
  const tokens: TokenSet = {
    access_token: 'access',
    refresh_token: 'refresh',
    expires_at: '2030-01-01T00:00:00.000Z',
    scope: 'ai',
    client_id: 'client',
    server_url: 'https://acosmi.com',
  }
  secrets.values.set('com.acosmi.dsharness.gui:stable:loader-test', JSON.stringify(tokens))
  return secrets
}

function stubAcosmiFetch(models: ManagedModel[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname === '/api/v4/managed-models' && url.search === '?picker=1') {
      return Response.json({ data: models }, {
        headers: { 'x-entitlement-filter-status': 'ok' },
      })
    }
    if (url.pathname === '/api/v4/entitlements/quota-summary') {
      return Response.json({ data: { freeTotalEtu: 20, paidTotalEtu: 40 } })
    }
    if (url.pathname === '/api/v4/entitlements/membership') {
      return Response.json({ data: { hasActive: true, planName: 'Pro', expiresAt: '' } })
    }
    if (url.pathname === '/.well-known/oauth-authorization-server/desktop') {
      return Response.json({
        issuer: 'https://acosmi.com',
        authorization_endpoint: 'https://acosmi.com/oauth/desktop/authorize',
        token_endpoint: 'https://acosmi.com/oauth/desktop/token',
        registration_endpoint: 'https://acosmi.com/oauth/desktop/register',
        revocation_endpoint: 'https://acosmi.com/oauth/desktop/revoke',
        scopes_supported: ['ai'],
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
    }
    if (url.pathname === '/oauth/desktop/revoke') return new Response(null, { status: 200 })
    throw new Error(`unexpected Acosmi SDK request: ${url.href}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function bootProvider(secrets: DesktopSecretBridge): ReturnType<typeof boot> {
  return boot('dsh-gui-provider-test', CONFIG, undefined, prepared => {
    prepared.loader.internal = {
      version: 'v2',
      import: async (specifier: string) => {
        const plugin = PLUGINS.get(specifier)
        if (plugin === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return plugin
      },
    } as unknown as NonNullable<typeof prepared.loader.internal>
    provideDesktopSecrets(prepared, secrets)
    provideAcosmiOAuthBrowser(prepared, {
      open: async () => { throw new Error('loader composition must not open a browser') },
    })
  })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('Acosmi provider Loader composition', () => {
  it('keeps the account route absent while the real SDK has no stored authorization', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('signed-out composition must not access the network') })
    vi.stubGlobal('fetch', fetchMock)
    const ctx = await bootProvider(new MemorySecrets())

    try {
      await expect(ctx.acosmiAccount.describe()).resolves.toMatchObject({ status: 'signed-out' })
      expect(ctx.llm.listProviders()).toEqual([])
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('registers an authorized route and withdraws it with the SDK session on logout', async () => {
    const fetchMock = stubAcosmiFetch([managedModel()])
    const secrets = authorizedSecrets()
    const ctx = await bootProvider(secrets)

    try {
      await expect(ctx.acosmiAccount.describe()).resolves.toMatchObject({ status: 'ready' })
      expect(ctx.llm.listProviders()).toEqual([{
        id: 'acosmi',
        name: 'Acosmi membership · account quota',
      }])
      await expect(ctx.llm.resolveModelInfo('acosmi', 'account-model')).resolves.toMatchObject({
        defaultMaxTokens: 8192,
        context: { contextWindow: 1_000_000 },
      })
      const session = ctx.acosmiAccount.sdkSession()

      await expect(ctx.acosmiAccount.logout()).resolves.toMatchObject({
        ok: true,
        account: { status: 'signed-out' },
      })

      expect(session?.signal.aborted).toBe(true)
      expect(ctx.llm.listProviders()).toEqual([])
      expect(secrets.values.size).toBe(0)
      expect(fetchMock).toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not activate the route when the confirmed catalog has no selectable chat model', async () => {
    const fetchMock = stubAcosmiFetch([managedModel({ locked: true })])
    const ctx = await bootProvider(authorizedSecrets())

    try {
      await expect(ctx.acosmiAccount.describe()).resolves.toMatchObject({ status: 'ready' })
      expect(ctx.llm.listProviders()).toEqual([])
      expect(fetchMock).toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
