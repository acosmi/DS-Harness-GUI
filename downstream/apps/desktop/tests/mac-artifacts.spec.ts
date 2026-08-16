import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { notaryAuthorizationArgs, parseNotarySubmission } = require('../scripts/mac-artifacts.cjs') as {
  notaryAuthorizationArgs(environment?: NodeJS.ProcessEnv): string[]
  parseNotarySubmission(output: string): string
}

describe('macOS artifact notarization inputs', () => {
  it('maps each complete credential family to notarytool arguments', () => {
    expect(notaryAuthorizationArgs({
      APPLE_KEYCHAIN: '/tmp/release.keychain-db',
      APPLE_KEYCHAIN_PROFILE: 'dsh-gui-notary',
    })).toEqual([
      '--keychain-profile', 'dsh-gui-notary',
      '--keychain', '/tmp/release.keychain-db',
    ])
    expect(notaryAuthorizationArgs({
      APPLE_API_KEY: '/tmp/AuthKey_TEST.p8',
      APPLE_API_KEY_ID: 'TESTKEY123',
      APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
    })).toEqual([
      '--key', '/tmp/AuthKey_TEST.p8',
      '--key-id', 'TESTKEY123',
      '--issuer', '00000000-0000-0000-0000-000000000000',
    ])
    expect(notaryAuthorizationArgs({
      APPLE_ID: 'release@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
      APPLE_TEAM_ID: 'Z6BDN8ZHTY',
    })).toEqual([
      '--apple-id', 'release@example.com',
      '--password', 'app-password',
      '--team-id', 'Z6BDN8ZHTY',
    ])
  })

  it('accepts only a complete accepted notarytool response', () => {
    expect(parseNotarySubmission(JSON.stringify({
      id: '11111111-2222-3333-4444-555555555555',
      message: 'Successfully received submission info',
      status: 'Accepted',
    }))).toBe('11111111-2222-3333-4444-555555555555')
    expect(() => parseNotarySubmission('{')).toThrow(/malformed JSON/)
    expect(() => parseNotarySubmission(JSON.stringify({ id: 'submission', status: 'Invalid' })))
      .toThrow(/accepted submission/)
    expect(() => parseNotarySubmission(JSON.stringify({ status: 'Accepted' })))
      .toThrow(/accepted submission/)
  })
})
