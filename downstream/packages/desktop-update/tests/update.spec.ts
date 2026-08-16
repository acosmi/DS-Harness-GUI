import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalJson,
  checkDesktopUpdate,
  verifyReleaseIndex,
  type ReleaseIndexPolicy,
} from '../src/index.ts'

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const now = new Date('2026-08-14T12:00:00.000Z')

function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    releaseId: '1b1fe2b8-a47d-4df5-8539-34ef21c2bb26',
    productId: 'com.acosmi.dsharness.gui',
    channel: 'stable',
    version: '1.2.3',
    publishedAt: '2026-08-14T11:00:00.000Z',
    expiresAt: '2026-08-21T11:00:00.000Z',
    artifacts: [{
      platform: 'darwin',
      arch: 'arm64',
      minimumOs: '12.0',
      url: 'https://downloads.acosmi.com/dsh-gui/1.2.3/DSH-GUI-arm64.zip',
      size: 42,
      sha512: 'a'.repeat(128),
    }],
    ...overrides,
  }
}

function signedIndex(value = release(), keyId = 'release-2026'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    release: value,
    signature: {
      algorithm: 'ed25519',
      keyId,
      value: sign(null, Buffer.from(canonicalJson(value)), keys.privateKey).toString('base64'),
    },
  }
}

function policy(overrides: Partial<ReleaseIndexPolicy> = {}): ReleaseIndexPolicy {
  return {
    productId: 'com.acosmi.dsharness.gui',
    channel: 'stable',
    platform: 'darwin',
    arch: 'arm64',
    osVersion: '14.6.1',
    currentVersion: '1.0.0',
    publicKeys: { 'release-2026': publicKey },
    now,
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('release index verification', () => {
  it('authenticates the exact release and selects one platform artifact', () => {
    const result = verifyReleaseIndex(signedIndex(), policy())
    expect(result).toEqual({
      status: 'available',
      version: '1.2.3',
      artifact: expect.objectContaining({ platform: 'darwin', arch: 'arm64' }),
      checkedAt: now.getTime(),
    })
    expect(verifyReleaseIndex(signedIndex(), policy({ currentVersion: '1.2.3' })))
      .toEqual({ status: 'current', checkedAt: now.getTime() })
    expect(verifyReleaseIndex(signedIndex(release({ version: '1.2.3-beta.1' })), policy({ currentVersion: '1.2.3' })))
      .toEqual({ status: 'current', checkedAt: now.getTime() })
    expect(verifyReleaseIndex(
      signedIndex(release({ version: '1.2.3-beta.10' })),
      policy({ currentVersion: '1.2.3-beta.2' }),
    )).toMatchObject({ status: 'available', version: '1.2.3-beta.10' })
  })

  it.each([
    ['unknown key', signedIndex(release(), 'unknown'), policy(), /unknown signing key/],
    ['product', signedIndex(release({ productId: 'other' })), policy(), /product does not match/],
    ['channel', signedIndex(release({ channel: 'canary' })), policy(), /channel does not match/],
    ['expiry', signedIndex(release({ expiresAt: now.toISOString() })), policy(), /expired/],
    ['future', signedIndex(release({ publishedAt: '2026-08-14T12:06:00.000Z' })), policy(), /in the future/],
    ['platform', signedIndex(), policy({ platform: 'win32' }), /no artifact/],
    ['minimum OS', signedIndex(), policy({ osVersion: '11.9' }), /newer operating system/],
  ])('rejects a %s mismatch', (_label, index, candidatePolicy, message) => {
    expect(() => verifyReleaseIndex(index, candidatePolicy)).toThrow(message)
  })

  it('rejects tampering, malformed fields, insecure artifacts, and invalid current versions', () => {
    const tampered = signedIndex()
    ;(tampered.release as Record<string, unknown>).version = '9.9.9'
    expect(() => verifyReleaseIndex(tampered, policy())).toThrow(/signature is invalid/)
    expect(() => verifyReleaseIndex(signedIndex(release({
      artifacts: [{ platform: 'darwin', arch: 'arm64', minimumOs: '12.0', url: 'http://example.com/a', size: 1, sha512: 'a'.repeat(128) }],
    })), policy())).toThrow()
    expect(() => verifyReleaseIndex(signedIndex(release({ unknown: true })), policy())).toThrow()
    expect(() => verifyReleaseIndex(signedIndex(release({
      artifacts: [{
        platform: 'darwin', arch: 'arm64', minimumOs: '12.0',
        url: 'https://user@downloads.acosmi.com/a', size: 1, sha512: 'a'.repeat(128),
      }],
    })), policy())).toThrow(/credential-free HTTPS/)
    const artifact = (release().artifacts as Array<Record<string, unknown>>)[0]!
    expect(() => verifyReleaseIndex(signedIndex(release({ artifacts: [artifact, artifact] })), policy()))
      .toThrow(/duplicate platform artifacts/)
    expect(() => verifyReleaseIndex(signedIndex(release({
      publishedAt: '2026-08-14T11:00:00.000Z',
      expiresAt: '2026-08-14T10:00:00.000Z',
    })), policy())).toThrow(/expiry must follow publication/)
    expect(() => verifyReleaseIndex(signedIndex(), policy({ currentVersion: 'not-semver' }))).toThrow(/invalid semantic version/)
  })

  it('canonicalizes nested JSON independent of object insertion order', () => {
    expect(canonicalJson({ z: [2, { b: true, a: null }], a: 'x' }))
      .toBe('{"a":"x","z":[2,{"a":null,"b":true}]}')
  })

  it('rejects values outside the JSON data model', () => {
    expect(() => canonicalJson(undefined)).toThrow(/non-JSON values/)
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite numbers/)
    expect(() => canonicalJson(new Date())).toThrow(/non-JSON objects/)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => canonicalJson(circular)).toThrow(/circular values/)
  })

  it('does not resolve an inherited property as a signing key', () => {
    expect(() => verifyReleaseIndex(signedIndex(release(), 'toString'), policy()))
      .toThrow(/unknown signing key/)
  })
})

describe('bounded index fetch', () => {
  it('fetches with no redirects and verifies the response', async () => {
    const body = JSON.stringify(signedIndex())
    const fetchMock = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'content-length': String(Buffer.byteLength(body)) },
    }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(checkDesktopUpdate('https://updates.acosmi.com/stable.json', policy(), new AbortController().signal))
      .resolves.toMatchObject({ status: 'available', version: '1.2.3' })
    expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'error' }))
  })

  it('rejects insecure, credentialed, failed, and oversized responses', async () => {
    await expect(checkDesktopUpdate('http://updates.acosmi.com/index.json', policy(), new AbortController().signal))
      .rejects.toThrow(/HTTPS/)
    await expect(checkDesktopUpdate('https://user@updates.acosmi.com/index.json', policy(), new AbortController().signal))
      .rejects.toThrow(/credential-free HTTPS/)
    await expect(checkDesktopUpdate('https://updates.acosmi.com/index.json#latest', policy(), new AbortController().signal))
      .rejects.toThrow(/without a fragment/)

    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })))
    await expect(checkDesktopUpdate('https://updates.acosmi.com/index.json', policy(), new AbortController().signal))
      .rejects.toThrow(/HTTP 500/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('small', { headers: { 'content-length': '1048577' } })))
    await expect(checkDesktopUpdate('https://updates.acosmi.com/index.json', policy(), new AbortController().signal))
      .rejects.toThrow(/too large/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('small', { headers: { 'content-length': 'invalid' } })))
    await expect(checkDesktopUpdate('https://updates.acosmi.com/index.json', policy(), new AbortController().signal))
      .rejects.toThrow(/invalid content length/)
  })

  it('cancels a chunked response as soon as it crosses the byte limit', async () => {
    const cancel = vi.fn()
    let pull = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(pull === 0 ? 1024 * 1024 : 1))
        pull += 1
      },
      cancel,
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))

    await expect(checkDesktopUpdate('https://updates.acosmi.com/index.json', policy(), new AbortController().signal))
      .rejects.toThrow(/too large/)
    expect(cancel).toHaveBeenCalledOnce()
  })
})
