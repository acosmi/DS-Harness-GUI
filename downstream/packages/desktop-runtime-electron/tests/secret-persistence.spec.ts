import { describe, expect, it } from 'vitest'
import { resolveDesktopSecretPersistence } from '../src/secret-persistence.ts'

describe('desktop secret persistence policy', () => {
  it('keeps signed builds fail-closed on the protected vault', () => {
    expect(resolveDesktopSecretPersistence('signed', 'darwin', {
      encryptionAvailable: false,
    })).toBe('os-protected')
    for (const linuxBackend of ['basic_text', 'unknown', undefined] as const) {
      expect(() => resolveDesktopSecretPersistence('signed', 'linux', {
        encryptionAvailable: true,
        ...(linuxBackend === undefined ? {} : { linuxBackend }),
      })).toThrow(/require protected Linux secret storage/)
    }
  })

  it.each(['darwin', 'win32'] as const)(
    'persists unsigned %s builds only when operating-system encryption is available',
    platform => {
      expect(resolveDesktopSecretPersistence('development-unsigned', platform, {
        encryptionAvailable: true,
      })).toBe('os-protected')
      expect(resolveDesktopSecretPersistence('development-unsigned', platform, {
        encryptionAvailable: false,
      })).toBe('session-memory')
    },
  )

  it('rejects unprotected or unresolved Linux storage backends', () => {
    for (const linuxBackend of ['basic_text', 'unknown', undefined] as const) {
      expect(resolveDesktopSecretPersistence('development-unsigned', 'linux', {
        encryptionAvailable: true,
        ...(linuxBackend === undefined ? {} : { linuxBackend }),
      })).toBe('session-memory')
    }
    expect(resolveDesktopSecretPersistence('development-unsigned', 'linux', {
      encryptionAvailable: true,
      linuxBackend: 'gnome_libsecret',
    })).toBe('os-protected')
  })
})
