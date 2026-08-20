/** Selection policy for the desktop secret-vault implementation. */

import type { DesktopProductInfo } from '@acosmi/dsh-desktop-carrier-electron/protocol'
import type { DesktopSecretPersistence } from '@acosmi/dsh-desktop-secrets/vault'

/** Safe-storage facts available after Electron app readiness. */
export interface DesktopSafeStorageFacts {
  readonly encryptionAvailable: boolean
  readonly linuxBackend?: 'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown'
}

/**
 * Select persistent storage only when the build or operating system provides the required protection.
 * @param signing - build-time publisher-signing classification.
 * @param platform - current Node.js platform.
 * @param storage - Electron safeStorage facts observed after app readiness.
 * @returns the vault persistence mode for this application lifetime.
 * @throws when a signed Linux build cannot identify a protected storage backend.
 */
export function resolveDesktopSecretPersistence(
  signing: DesktopProductInfo['signing'],
  platform: NodeJS.Platform,
  storage: DesktopSafeStorageFacts,
): DesktopSecretPersistence {
  const unprotectedLinuxBackend = platform === 'linux'
    && (storage.linuxBackend === undefined
      || storage.linuxBackend === 'basic_text'
      || storage.linuxBackend === 'unknown')
  if (unprotectedLinuxBackend) {
    if (signing === 'signed') {
      throw new Error('signed desktop builds require protected Linux secret storage')
    }
    return 'session-memory'
  }
  if (signing === 'signed') return 'os-protected'
  if (!storage.encryptionAvailable) return 'session-memory'
  return 'os-protected'
}
