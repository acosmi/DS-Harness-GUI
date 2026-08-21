import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const {
  desktopChannel,
  desktopMacIdentity,
  desktopMacNotarizationCredentials,
  desktopReleaseMode,
  desktopTrustedSigning,
} = await import('../scripts/build-environment.cjs') as {
  desktopChannel(environment?: NodeJS.ProcessEnv): 'stable' | 'canary'
  desktopMacIdentity(identitySha1: string, releaseMode: ReleaseMode): string | null
  desktopMacNotarizationCredentials(environment?: NodeJS.ProcessEnv): CredentialFamily | null
  desktopReleaseMode(environment?: NodeJS.ProcessEnv): ReleaseMode
  desktopTrustedSigning(releaseMode: ReleaseMode): boolean
}

type CredentialFamily = 'api-key' | 'apple-id' | 'keychain-profile'
type ReleaseMode = 'development' | 'candidate' | 'stable'

const MAC_IDENTITY = 'A6616C59EA24F8DE1D97ECC8081AE64E3D7D6F61'
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../../..')
const PRODUCT_ICON = path.join(REPOSITORY_ROOT, 'assets/branding/dsh-gui-whale-browser-logo-v6.png')
const PRODUCT_PATCH_PATHS = [
  'downstream/bundles/desktop/cordis.patch.yml',
  'downstream/bundles/desktop/cordis.stable.patch.yml',
  'downstream/bundles/desktop/cordis.canary.patch.yml',
] as const
const builderConfigModule = await import('../electron-builder.config.cjs') as {
  default: {
    mac: { icon: string; target: string[] }
    win: { icon: string; target: string[] }
  }
}

function collectProductVersions(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectProductVersions)
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => {
    if (key === 'productVersion') return typeof child === 'string' ? [child] : []
    return collectProductVersions(child)
  })
}

describe('desktop build environment', () => {
  it('keeps the package and every shipped product version equal', () => {
    const manifest: unknown = JSON.parse(readFileSync(
      path.join(REPOSITORY_ROOT, 'downstream/apps/desktop/package.json'),
      'utf8',
    ))
    if (manifest === null || typeof manifest !== 'object' || !('version' in manifest)
      || typeof manifest.version !== 'string') {
      throw new Error('desktop package manifest is missing its version')
    }
    const configuredVersions = PRODUCT_PATCH_PATHS.flatMap(relativePath => collectProductVersions(
      yaml.load(readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8')),
    ))
    expect(configuredVersions).toEqual(PRODUCT_PATCH_PATHS.map(() => manifest.version))
  })

  it('uses explicit channel and release-mode values with safe development defaults', () => {
    expect(desktopChannel({})).toBe('stable')
    expect(desktopChannel({ DSH_DESKTOP_CHANNEL: 'canary' })).toBe('canary')
    expect(desktopReleaseMode({})).toBe('development')
    expect(desktopReleaseMode({ DSH_DESKTOP_RELEASE_MODE: 'candidate' })).toBe('candidate')
    expect(desktopReleaseMode({ DSH_DESKTOP_RELEASE_MODE: 'stable' })).toBe('stable')
  })

  it('rejects explicit misspellings instead of changing product identity or signing mode', () => {
    expect(() => desktopChannel({ DSH_DESKTOP_CHANNEL: 'canray' })).toThrow(/stable or canary/)
    expect(() => desktopReleaseMode({ DSH_DESKTOP_RELEASE_MODE: 'release' }))
      .toThrow(/development, candidate, or stable/)
  })

  it('selects the recorded certificate exactly for candidate and stable signing', () => {
    expect(desktopMacIdentity(MAC_IDENTITY, 'development')).toBeNull()
    expect(desktopMacIdentity(MAC_IDENTITY, 'candidate')).toBe(MAC_IDENTITY)
    expect(desktopMacIdentity(MAC_IDENTITY, 'stable')).toBe(MAC_IDENTITY)
    expect(() => desktopMacIdentity('Developer ID Application: ambiguous', 'stable'))
      .toThrow(/40-character SHA-1/)
    expect(desktopTrustedSigning('development')).toBe(false)
    expect(desktopTrustedSigning('candidate')).toBe(true)
    expect(desktopTrustedSigning('stable')).toBe(true)
  })

  it('requires exactly one complete notarization credential family', () => {
    expect(desktopMacNotarizationCredentials({})).toBeNull()
    expect(desktopMacNotarizationCredentials({
      APPLE_KEYCHAIN_PROFILE: 'dsh-gui-notary',
    })).toBe('keychain-profile')
    expect(desktopMacNotarizationCredentials({
      APPLE_KEYCHAIN: '/tmp/release.keychain-db',
      APPLE_KEYCHAIN_PROFILE: 'dsh-gui-notary',
    })).toBe('keychain-profile')
    expect(desktopMacNotarizationCredentials({
      APPLE_API_KEY: '/tmp/AuthKey_TEST.p8',
      APPLE_API_KEY_ID: 'TESTKEY123',
      APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
    })).toBe('api-key')
    expect(desktopMacNotarizationCredentials({
      APPLE_ID: 'release@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
      APPLE_TEAM_ID: 'Z6BDN8ZHTY',
    })).toBe('apple-id')
    expect(() => desktopMacNotarizationCredentials({
      APPLE_KEYCHAIN: '/tmp/release.keychain-db',
    })).toThrow(/missing APPLE_KEYCHAIN_PROFILE/)
    expect(() => desktopMacNotarizationCredentials({
      APPLE_KEYCHAIN_PROFILE: 'dsh-gui-notary',
      APPLE_ID: 'release@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
      APPLE_TEAM_ID: 'Z6BDN8ZHTY',
    })).toThrow(/exactly one/)
  })

  it('converts the product-owned source artwork for both platform icons', () => {
    expect(builderConfigModule.default.mac.icon).toBe(PRODUCT_ICON)
    expect(builderConfigModule.default.win.icon).toBe(PRODUCT_ICON)
  })

  it('leaves architecture selection to each isolated packaging target', () => {
    expect(builderConfigModule.default.mac.target).toEqual(['dmg', 'zip'])
    expect(builderConfigModule.default.win.target).toEqual(['nsis'])
  })
})
