import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAcosmiProductFetch } from '../src/index.ts'

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: 'https://acosmi.com',
    authorization_endpoint: 'https://acosmi.com/oauth/desktop/authorize',
    token_endpoint: 'https://acosmi.com/oauth/desktop/token',
    registration_endpoint: 'https://acosmi.com/oauth/desktop/register',
    revocation_endpoint: 'https://acosmi.com/oauth/desktop/revoke',
    scopes_supported: ['ai'],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Acosmi product fetch policy', () => {
  it('adds product attribution, rejects redirects, and accepts exact desktop discovery metadata', async () => {
    const upstream = vi.fn(async () => Response.json(metadata()))
    vi.stubGlobal('fetch', upstream)
    const productFetch = createAcosmiProductFetch('https://acosmi.com', '0.1.0-dev.1')
    await expect(productFetch('https://acosmi.com/.well-known/oauth-authorization-server/desktop', {
      headers: { 'x-test': 'present' },
    })).resolves.toBeInstanceOf(Response)
    const init = upstream.mock.calls[0]?.[1]
    const headers = new Headers(init?.headers)
    expect(init?.redirect).toBe('error')
    expect(headers.get('x-test')).toBe('present')
    expect(headers.get('user-agent')).toContain('dsh-gui/0.1.0-dev.1')
  })

  it('blocks non-production origins and malformed base configuration before network I/O', async () => {
    const upstream = vi.fn()
    vi.stubGlobal('fetch', upstream)
    const productFetch = createAcosmiProductFetch('https://acosmi.com/', '0.1.0-dev.1')
    await expect(productFetch('https://evil.example/api/v4/managed-models')).rejects.toThrow(/origin policy/)
    await expect(productFetch('http://acosmi.com/api/v4/managed-models')).rejects.toThrow(/origin policy/)
    expect(upstream).not.toHaveBeenCalled()
    expect(() => createAcosmiProductFetch('https://staging.acosmi.com', '0.1.0-dev.1')).toThrow(/production Acosmi/)
    expect(() => createAcosmiProductFetch('https://acosmi.com/path', '0.1.0-dev.1')).toThrow(/production Acosmi/)
    expect(() => createAcosmiProductFetch('https://acosmi.com', 'dev')).toThrow(/product version/)
  })

  it.each([
    ['issuer', metadata({ issuer: 'https://evil.example' }), /issuer is not trusted/],
    ['authorization endpoint', metadata({ authorization_endpoint: 'https://evil.example/authorize' }), /authorization_endpoint is not trusted/],
    ['token endpoint', metadata({ token_endpoint: 'https://evil.example/token' }), /token_endpoint is not trusted/],
    ['registration endpoint', metadata({ registration_endpoint: 'https://evil.example/register' }), /registration_endpoint is not trusted/],
    ['revocation endpoint', metadata({ revocation_endpoint: 'https://evil.example/revoke' }), /revocation_endpoint is not trusted/],
    ['capabilities', metadata({ code_challenge_methods_supported: ['plain'] }), /capabilities are incompatible/],
  ])('rejects incompatible discovery %s', async (_label, payload, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload)))
    const productFetch = createAcosmiProductFetch('https://acosmi.com', '0.1.0-dev.1')
    await expect(productFetch('https://acosmi.com/.well-known/oauth-authorization-server/desktop'))
      .rejects.toThrow(expected)
  })

  it('rejects non-JSON and non-object discovery responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(createAcosmiProductFetch('https://acosmi.com', '0.1.0-dev.1')(
      'https://acosmi.com/.well-known/oauth-authorization-server/desktop',
    )).rejects.toThrow(/not JSON/)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])))
    await expect(createAcosmiProductFetch('https://acosmi.com', '0.1.0-dev.1')(
      'https://acosmi.com/.well-known/oauth-authorization-server/desktop',
    )).rejects.toThrow(/not an object/)
  })
})
