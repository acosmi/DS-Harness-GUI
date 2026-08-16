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
  if (value === 'stable') return 'stable'
  throw new Error(`DSH_DESKTOP_RELEASE_MODE must be development or stable, received ${JSON.stringify(value)}`)
}

/**
 * Resolve the exact macOS signing selector for one validated release mode.
 * @param {string} identitySha1 - uppercase SHA-1 from the public release ledger.
 * @param {'development' | 'stable'} releaseMode - validated desktop release mode.
 * @returns {string | null} exact stable selector, or null for ad hoc development signing.
 */
function desktopMacIdentity(identitySha1, releaseMode) {
  if (!/^[0-9A-F]{40}$/u.test(identitySha1)) {
    throw new Error('macOS signing identity must be an uppercase 40-character SHA-1')
  }
  return releaseMode === 'stable' ? identitySha1 : null
}

module.exports = { desktopChannel, desktopMacIdentity, desktopReleaseMode }
