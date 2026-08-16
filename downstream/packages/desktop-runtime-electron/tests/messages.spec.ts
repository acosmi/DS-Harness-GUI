import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  acceptRendererOneWayMessage,
  assertHostVoid,
  parseHostBoolean,
  parseHostDirectorySelection,
  parseHostOptionalSecret,
  parseAcosmiAuthorizationUrl,
  parseRendererId,
  parseRendererStreamUrl,
  parseRendererUnary,
  parseUtilityStreamId,
  parseUtilityStreamItem,
  parseUtilityUnaryResponse,
  publicFailure,
  tryPostDesktopMessage,
} from '../src/messages.ts'
import { DESKTOP_PROTOCOL_VERSION, MAX_DESKTOP_BODY_BYTES } from '@acosmi/dsh-desktop-carrier-electron/protocol'

const state = 'a'.repeat(43)
const challenge = 'b'.repeat(43)

function authorizationUrl(overrides: Record<string, string> = {}): string {
  const url = new URL('https://acosmi.com/oauth/desktop/authorize')
  const values = {
    client_id: 'dsh-gui-test-client',
    redirect_uri: 'http://127.0.0.1:54321/callback',
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: 'ai',
    ...overrides,
  }
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value)
  return url.href
}

describe('Acosmi authorization browser gate', () => {
  it('accepts the exact state-protected SDK authorization request', () => {
    const candidate = authorizationUrl()
    expect(parseAcosmiAuthorizationUrl(candidate)).toBe(candidate)
  })

  it.each([
    ['protocol', authorizationUrl().replace('https:', 'http:')],
    ['origin', authorizationUrl().replace('acosmi.com', 'login.acosmi.com')],
    ['path', authorizationUrl().replace('/oauth/desktop/authorize', '/oauth/authorize')],
    ['fragment', `${authorizationUrl()}#fragment`],
    ['scope', authorizationUrl({ scope: 'ai profile' })],
    ['response type', authorizationUrl({ response_type: 'token' })],
    ['challenge method', authorizationUrl({ code_challenge_method: 'plain' })],
    ['short state', authorizationUrl({ state: 'short' })],
    ['short challenge', authorizationUrl({ code_challenge: 'short' })],
    ['callback host', authorizationUrl({ redirect_uri: 'http://localhost:54321/callback' })],
    ['callback protocol', authorizationUrl({ redirect_uri: 'https://127.0.0.1:54321/callback' })],
    ['callback path', authorizationUrl({ redirect_uri: 'http://127.0.0.1:54321/other' })],
    ['callback low port', authorizationUrl({ redirect_uri: 'http://127.0.0.1:80/callback' })],
    ['callback query', authorizationUrl({ redirect_uri: 'http://127.0.0.1:54321/callback?x=1' })],
  ])('rejects a mismatched %s', (_label, candidate) => {
    expect(() => parseAcosmiAuthorizationUrl(candidate)).toThrow(/browser gate/)
  })

  it('rejects missing, duplicate, extra, credentialed, malformed, and oversized values', () => {
    const missing = new URL(authorizationUrl())
    missing.searchParams.delete('state')
    expect(() => parseAcosmiAuthorizationUrl(missing.href)).toThrow(/missing authorization parameter/)

    const duplicate = new URL(authorizationUrl())
    duplicate.searchParams.append('state', state)
    expect(() => parseAcosmiAuthorizationUrl(duplicate.href)).toThrow(/authorization parameters/)

    const extra = new URL(authorizationUrl())
    extra.searchParams.set('prompt', 'login')
    expect(() => parseAcosmiAuthorizationUrl(extra.href)).toThrow(/authorization parameters/)

    expect(() => parseAcosmiAuthorizationUrl(authorizationUrl().replace('https://', 'https://user@')))
      .toThrow(/authority or path/)
    expect(() => parseAcosmiAuthorizationUrl('not a URL')).toThrow()
    expect(() => parseAcosmiAuthorizationUrl('x'.repeat(4097))).toThrow(/malformed URL/)
    expect(() => parseAcosmiAuthorizationUrl(null)).toThrow(/malformed URL/)
  })
})

describe('renderer IPC parsing', () => {
  it('detaches a valid unary request and admits only the two stream endpoints', () => {
    const body = new Uint8Array([1, 2, 3]).buffer
    const parsed = parseRendererUnary({
      version: DESKTOP_PROTOCOL_VERSION,
      requestId: '01234567-89ab-cdef',
      method: 'POST',
      url: 'app://dsh-gui/api/demo.call',
      headers: [['Content-Type', 'application/json']],
      body,
    })
    expect(parsed).toEqual({
      version: DESKTOP_PROTOCOL_VERSION,
      requestId: '01234567-89ab-cdef',
      method: 'POST',
      url: 'app://dsh-gui/api/demo.call',
      headers: [['content-type', 'application/json']],
      body,
    })
    expect(parsed.body).not.toBe(body)
    expect(parseRendererStreamUrl('app://dsh-gui/api/events.mux')).toBe('app://dsh-gui/api/events.mux')
    expect(parseRendererStreamUrl('app://dsh-gui/api/events.host')).toBe('app://dsh-gui/api/events.host')
    expect(parseRendererId('01234567-89ab-cdef')).toBe('01234567-89ab-cdef')
    expect(parseRendererUnary({ ...parsed, url: 'app://dsh-gui/rpc~v1/demo.call' }).url)
      .toBe('app://dsh-gui/rpc~v1/demo.call')
  })

  it('rejects malformed envelopes, headers, paths, ids, and oversized bodies', () => {
    const base = {
      version: DESKTOP_PROTOCOL_VERSION,
      requestId: '01234567-89ab-cdef',
      method: 'POST',
      url: 'app://dsh-gui/api/demo.call',
      headers: [] as unknown[],
      body: new ArrayBuffer(0),
    }
    expect(() => parseRendererUnary({ ...base, version: 2 })).toThrow(/malformed/)
    expect(() => parseRendererUnary({ ...base, method: 'GET' })).toThrow(/malformed/)
    expect(() => parseRendererUnary({ ...base, url: 'https://dsh-gui/api/demo.call' })).toThrow(/authority/)
    expect(() => parseRendererUnary({ ...base, url: 'app://dsh-gui/api/../secret' })).toThrow(/request path/)
    expect(() => parseRendererUnary({ ...base, url: 'app://dsh-gui/api//demo.call' })).toThrow(/request path/)
    expect(() => parseRendererUnary({ ...base, url: 'app://dsh-gui/api/demo.call/' })).toThrow(/request path/)
    expect(() => parseRendererUnary({ ...base, headers: [['authorization', 'secret']] })).toThrow(/header authorization/)
    expect(() => parseRendererUnary({ ...base, headers: [['accept']] })).toThrow(/headers/)
    expect(() => parseRendererUnary({ ...base, headers: [['accept', 'x'.repeat(257)]] })).toThrow(/oversized/)
    expect(() => parseRendererUnary({ ...base, headers: [['accept', 'a'], ['accept', 'b']] }))
      .toThrow(/duplicate header/)
    expect(() => parseRendererUnary({ ...base, headers: [
      ['accept', 'a'],
      ['content-type', 'application/json'],
      ['accept', 'b'],
    ] })).toThrow(/too many headers/)
    expect(() => parseRendererUnary({ ...base, extra: true })).toThrow(/malformed/)
    expect(() => parseRendererUnary({ ...base, body: new ArrayBuffer(MAX_DESKTOP_BODY_BYTES + 1) })).toThrow(/too large/)
    expect(() => parseRendererUnary({ ...base, url: `app://dsh-gui/api/${'x'.repeat(4096)}` })).toThrow(/oversized URL/)
    expect(() => parseRendererStreamUrl('app://dsh-gui/api/other')).toThrow(/unknown stream/)
    expect(() => parseRendererStreamUrl(1)).toThrow(/malformed/)
    expect(() => parseRendererId('short')).toThrow(/malformed/)
  })

  it('drops an invalid one-way message before its main-process effect runs', () => {
    expect(acceptRendererOneWayMessage(() => parseRendererId('01234567-89ab-cdef')))
      .toBe('01234567-89ab-cdef')
    expect(acceptRendererOneWayMessage(() => parseRendererId('short'))).toBeUndefined()
    expect(acceptRendererOneWayMessage(() => { throw new Error('untrusted sender') })).toBeUndefined()
  })

  it('redacts internal failures and identifies cancellation without echoing details', () => {
    expect(publicFailure(new Error('https://secret.invalid token=top-secret')))
      .toBe('The desktop Host could not complete this operation.')
    expect(publicFailure(new DOMException('request aborted', 'AbortError'))).toBe('Request was cancelled.')
  })
})

describe('main-process reply parsing', () => {
  it('accepts only the documented credential, boolean, void, and directory values', () => {
    const directory = resolve('selected-directory')
    expect(parseHostOptionalSecret(undefined)).toBeUndefined()
    expect(parseHostOptionalSecret('credential-value')).toBe('credential-value')
    expect(() => parseHostOptionalSecret('')).toThrow(/credential value/)
    expect(() => parseHostOptionalSecret(null)).toThrow(/credential value/)
    expect(parseHostBoolean(true)).toBe(true)
    expect(parseHostBoolean(false)).toBe(false)
    expect(() => parseHostBoolean('false')).toThrow(/invalid boolean/)
    expect(() => assertHostVoid(undefined)).not.toThrow()
    expect(() => assertHostVoid(null)).toThrow(/empty response/)
    expect(parseHostDirectorySelection(null)).toBeNull()
    expect(parseHostDirectorySelection(directory)).toBe(directory)
    expect(() => parseHostDirectorySelection('relative')).toThrow(/invalid directory/)
  })

  it('contains a closed process transport exception', () => {
    const messages: unknown[] = []
    expect(tryPostDesktopMessage({ postMessage: message => { messages.push(message) } }, { type: 'ready' })).toBe(true)
    expect(messages).toEqual([{ type: 'ready' }])
    expect(tryPostDesktopMessage({ postMessage: () => { throw new Error('closed') } }, { type: 'reply' })).toBe(false)
  })

  it('validates and detaches utility-process carrier replies', () => {
    const body = new Uint8Array([1, 2, 3]).buffer
    const response = parseUtilityUnaryResponse({
      version: DESKTOP_PROTOCOL_VERSION,
      status: 200,
      headers: [['Content-Type', 'application/json']],
      body,
    })
    expect(response).toEqual({
      version: DESKTOP_PROTOCOL_VERSION,
      status: 200,
      headers: [['content-type', 'application/json']],
      body,
    })
    expect(response.body).not.toBe(body)
    expect(parseUtilityStreamId('01234567-89ab-cdef')).toBe('01234567-89ab-cdef')
    expect(parseUtilityStreamItem({ type: 'opened', status: 200, headers: [] }))
      .toEqual({ type: 'opened', status: 200, headers: [] })
    expect(parseUtilityStreamItem({ type: 'chunk', data: body })).toEqual({ type: 'chunk', data: body })
    expect(parseUtilityStreamItem({ type: 'end' })).toEqual({ type: 'end' })
    expect(parseUtilityStreamItem({ type: 'error', message: 'stream failed' }))
      .toEqual({ type: 'error', message: 'stream failed' })

    expect(() => parseUtilityUnaryResponse({
      version: DESKTOP_PROTOCOL_VERSION,
      status: 200,
      headers: [['authorization', 'secret']],
      body: new ArrayBuffer(0),
    })).toThrow(/rejected header authorization/)
    expect(() => parseUtilityUnaryResponse({
      version: DESKTOP_PROTOCOL_VERSION,
      status: 199,
      headers: [],
      body: new ArrayBuffer(0),
    })).toThrow(/malformed unary response/)
    expect(() => parseUtilityStreamId('not-an-id')).toThrow(/malformed stream id/)
    expect(() => parseUtilityStreamItem({ type: 'chunk', data: 'not bytes' })).toThrow(/malformed stream chunk/)
    expect(() => parseUtilityStreamItem({ type: 'error', message: 'x'.repeat(257) })).toThrow(/malformed stream error/)
    expect(() => parseUtilityStreamItem({ type: 'end', extra: true })).toThrow(/malformed stream end/)
  })
})
