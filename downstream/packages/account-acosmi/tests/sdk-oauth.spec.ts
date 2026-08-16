import { describe, expect, it } from 'vitest'
import {
  ErrStateMismatch,
  EventAuthURL,
  EventError,
  authorize,
  type LoginEvent,
  type ServerMetadata,
} from '@acosmi/sdk-ts'

const metadata: ServerMetadata = {
  issuer: 'https://acosmi.com',
  authorization_endpoint: 'https://acosmi.com/oauth/desktop/authorize',
  token_endpoint: 'https://api.acosmi.com/oauth/token',
  revocation_endpoint: 'https://api.acosmi.com/oauth/revoke',
  registration_endpoint: 'https://api.acosmi.com/oauth/register',
  scopes_supported: ['ai'],
}

function begin(): {
  authorization: Promise<URL>
  events: LoginEvent[]
  result: ReturnType<typeof authorize>
} {
  const events: LoginEvent[] = []
  let resolveAuthorization!: (url: URL) => void
  let rejectAuthorization!: (error: unknown) => void
  const authorization = new Promise<URL>((resolve, reject) => {
    resolveAuthorization = resolve
    rejectAuthorization = reject
  })
  const result = authorize(metadata, 'dsh-gui-test', ['ai'], {
    skipBrowser: true,
    signal: AbortSignal.timeout(5_000),
    handler(event) {
      events.push(event)
      if (event.type === EventAuthURL && event.url !== undefined) resolveAuthorization(new URL(event.url))
    },
  })
  void result.catch(rejectAuthorization)
  return { authorization, events, result }
}

describe('published SDK desktop OAuth', () => {
  it('generates a high-entropy state and accepts only the matching callback', async () => {
    const flow = begin()
    const authUrl = await flow.authorization
    const state = authUrl.searchParams.get('state')
    const redirect = authUrl.searchParams.get('redirect_uri')
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(authUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(redirect).not.toBeNull()

    const callback = new URL(redirect!)
    callback.searchParams.set('code', 'one-time-code')
    callback.searchParams.set('state', state!)
    const response = await fetch(callback)
    expect(response.status).toBe(200)
    await expect(flow.result).resolves.toMatchObject({
      result: { code: 'one-time-code', redirectURI: redirect },
      verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    })
    await expect(fetch(callback, { signal: AbortSignal.timeout(750) })).rejects.toThrow()
  })

  it('rejects a mismatched state before returning the authorization code', async () => {
    const flow = begin()
    const authUrl = await flow.authorization
    const callback = new URL(authUrl.searchParams.get('redirect_uri')!)
    callback.searchParams.set('code', 'attacker-code')
    callback.searchParams.set('state', 'x'.repeat(43))
    const response = await fetch(callback)
    expect(await response.text()).toContain('授权失败')
    await expect(flow.result).rejects.toThrow(ErrStateMismatch)
    expect(flow.events).toContainEqual(expect.objectContaining({
      type: EventError,
      err_code: ErrStateMismatch,
    }))
    await expect(fetch(callback, { signal: AbortSignal.timeout(750) })).rejects.toThrow()
  })

  it('rejects missing, duplicate, and OAuth-error callbacks before consuming their payload', async () => {
    const callbacks = [
      (callback: URL, _state: string) => callback.searchParams.set('code', 'missing-state-code'),
      (callback: URL, state: string) => {
        callback.searchParams.set('code', 'duplicate-state-code')
        callback.searchParams.append('state', state)
        callback.searchParams.append('state', state)
      },
      (callback: URL, _state: string) => callback.searchParams.set('error', 'access_denied'),
    ]

    for (const populate of callbacks) {
      const flow = begin()
      const authUrl = await flow.authorization
      const callback = new URL(authUrl.searchParams.get('redirect_uri')!)
      populate(callback, authUrl.searchParams.get('state')!)
      const response = await fetch(callback)
      expect(await response.text()).toContain('授权失败')
      await expect(flow.result).rejects.toThrow(ErrStateMismatch)
      expect(flow.events).toContainEqual(expect.objectContaining({
        type: EventError,
        err_code: ErrStateMismatch,
      }))
      await expect(fetch(callback, { signal: AbortSignal.timeout(750) })).rejects.toThrow()
    }
  })
})
