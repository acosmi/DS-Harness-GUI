import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  macArtifactPaths,
  notaryAuthorizationArgs,
  parseNotarySubmission,
  removeMacArtifactResidue,
} = require('../scripts/mac-artifacts.cjs') as {
  macArtifactPaths(
    artifactRoot: string,
    productName: string,
    version: string,
    arch: 'arm64' | 'x64',
  ): { dmgPath: string; zipPath: string }
  notaryAuthorizationArgs(environment?: NodeJS.ProcessEnv): string[]
  parseNotarySubmission(output: string): string
  removeMacArtifactResidue(artifacts: { dmgPath: string; zipPath: string }): string[]
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

describe('macOS artifact preparation', () => {
  it('removes only the selected target distributables and blockmaps', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-gui-artifact-cleanup-'))
    try {
      const artifacts = macArtifactPaths(root, 'DSH-GUI', '1.2.3', 'arm64')
      const candidates = [
        artifacts.dmgPath,
        `${artifacts.dmgPath}.blockmap`,
        artifacts.zipPath,
        `${artifacts.zipPath}.blockmap`,
      ]
      for (const candidate of candidates) writeFileSync(candidate, 'old artifact')
      const unrelated = path.join(root, 'DSH-GUI-1.2.3-x64.dmg')
      writeFileSync(unrelated, 'unrelated artifact')

      expect(removeMacArtifactResidue(artifacts)).toEqual(candidates)
      expect(() => removeMacArtifactResidue(artifacts)).not.toThrow()
      expect(readFileSync(unrelated, 'utf8')).toBe('unrelated artifact')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses to recursively remove a directory at an artifact path', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-gui-artifact-cleanup-'))
    try {
      const artifacts = macArtifactPaths(root, 'DSH-GUI', '1.2.3', 'x64')
      mkdirSync(artifacts.dmgPath)
      expect(() => removeMacArtifactResidue(artifacts)).toThrow(/because it is a directory/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
