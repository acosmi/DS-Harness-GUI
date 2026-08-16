import path from 'node:path'
import { describe, expect, it } from 'vitest'

const { desktopChannel, desktopMacIdentity, desktopReleaseMode } = await import('../scripts/build-environment.cjs') as {
  desktopChannel(environment?: NodeJS.ProcessEnv): 'stable' | 'canary'
  desktopMacIdentity(identitySha1: string, releaseMode: 'development' | 'stable'): string | null
  desktopReleaseMode(environment?: NodeJS.ProcessEnv): 'development' | 'stable'
}

const MAC_IDENTITY = 'A6616C59EA24F8DE1D97ECC8081AE64E3D7D6F61'
const PRODUCT_ICON = path.resolve(import.meta.dirname, '../../../..', 'assets/branding/dsh-gui-whale-browser-logo-v6.png')
const builderConfigModule = await import('../electron-builder.config.cjs') as {
  default: {
    mac: { icon: string; target: string[] }
    win: { icon: string; target: string[] }
  }
}

describe('desktop build environment', () => {
  it('uses explicit channel and release-mode values with safe development defaults', () => {
    expect(desktopChannel({})).toBe('stable')
    expect(desktopChannel({ DSH_DESKTOP_CHANNEL: 'canary' })).toBe('canary')
    expect(desktopReleaseMode({})).toBe('development')
    expect(desktopReleaseMode({ DSH_DESKTOP_RELEASE_MODE: 'stable' })).toBe('stable')
  })

  it('rejects explicit misspellings instead of changing product identity or signing mode', () => {
    expect(() => desktopChannel({ DSH_DESKTOP_CHANNEL: 'canray' })).toThrow(/stable or canary/)
    expect(() => desktopReleaseMode({ DSH_DESKTOP_RELEASE_MODE: 'release' }))
      .toThrow(/development or stable/)
  })

  it('selects the recorded certificate exactly only for stable signing', () => {
    expect(desktopMacIdentity(MAC_IDENTITY, 'development')).toBeNull()
    expect(desktopMacIdentity(MAC_IDENTITY, 'stable')).toBe(MAC_IDENTITY)
    expect(() => desktopMacIdentity('Developer ID Application: ambiguous', 'stable'))
      .toThrow(/40-character SHA-1/)
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
