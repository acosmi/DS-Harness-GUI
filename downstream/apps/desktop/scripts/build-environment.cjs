'use strict'

/** Parse the desktop channel without turning a misspelled release input into another channel. */
function desktopChannel(environment = process.env) {
  const value = environment.DSH_DESKTOP_CHANNEL
  if (value === undefined || value === 'stable') return 'stable'
  if (value === 'canary') return 'canary'
  throw new Error(`DSH_DESKTOP_CHANNEL must be stable or canary, received ${JSON.stringify(value)}`)
}

/** Parse whether the build is a signed stable candidate or a development artifact. */
function desktopReleaseMode(environment = process.env) {
  const value = environment.DSH_DESKTOP_RELEASE_MODE
  if (value === undefined || value === 'development') return 'development'
  if (value === 'candidate') return 'candidate'
  if (value === 'stable') return 'stable'
  throw new Error(
    `DSH_DESKTOP_RELEASE_MODE must be development, candidate, or stable, received ${JSON.stringify(value)}`,
  )
}

/**
 * Resolve the exact macOS signing selector for one validated release mode.
 * @param {string} identitySha1 - uppercase SHA-1 from the public release ledger.
 * @param {'development' | 'candidate' | 'stable'} releaseMode - validated desktop release mode.
 * @returns {string | null} exact trusted selector, or null for ad hoc development signing.
 */
function desktopMacIdentity(identitySha1, releaseMode) {
  if (!/^[0-9A-F]{40}$/u.test(identitySha1)) {
    throw new Error('macOS signing identity must be an uppercase 40-character SHA-1')
  }
  return releaseMode === 'development' ? null : identitySha1
}

/**
 * Resolve one complete electron-builder notarization credential family.
 * @param {NodeJS.ProcessEnv} environment - candidate environment without secret logging.
 * @returns {'api-key' | 'apple-id' | 'keychain-profile' | null} selected family or null when absent.
 */
function desktopMacNotarizationCredentials(environment = process.env) {
  const families = [
    {
      name: 'api-key',
      trigger: ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
      required: ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
    },
    {
      name: 'apple-id',
      trigger: ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
      required: ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
    },
    {
      name: 'keychain-profile',
      trigger: ['APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE'],
      required: ['APPLE_KEYCHAIN_PROFILE'],
    },
  ]
  const present = key => typeof environment[key] === 'string' && environment[key].length > 0
  const selected = families.filter(family => family.trigger.some(present))
  if (selected.length === 0) return null
  if (selected.length !== 1) {
    throw new Error('macOS notarization requires exactly one Apple credential family')
  }
  const family = selected[0]
  const missing = family.required.filter(key => !present(key))
  if (missing.length > 0) {
    throw new Error(`macOS notarization ${family.name} credentials are missing ${missing.join(', ')}`)
  }
  return family.name
}

/** Test whether a release mode requires a trusted publisher signature. */
function desktopTrustedSigning(releaseMode) {
  return releaseMode !== 'development'
}

module.exports = {
  desktopChannel,
  desktopMacIdentity,
  desktopMacNotarizationCredentials,
  desktopReleaseMode,
  desktopTrustedSigning,
}
