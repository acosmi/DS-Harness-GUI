const identity = require('../../../release/identity.json')

/**
 * Sign a trusted macOS application with the exact release-ledger certificate SHA-1.
 *
 * electron-builder resolves the requested SHA-1 correctly but its default signer
 * replaces that selector with the certificate common name. Duplicate common names
 * in the keychain search list then make codesign ambiguous.
 *
 * @param {{ identity?: string }} options - electron-builder's prepared osx-sign options.
 * @param {unknown} _packager - electron-builder packager instance, unused by this signer.
 * @param {(options: object) => Promise<void>} [signer] - osx-sign implementation.
 * @returns {Promise<void>} Completion after the application is signed and verified.
 */
async function signMac(options, _packager, signer = require('@electron/osx-sign').signAsync) {
  const expectedSha1 = identity.macSigning.identitySha1
  if (options.identity !== expectedSha1) {
    throw new Error(
      `trusted macOS signing requires the recorded certificate SHA-1 ${expectedSha1}; received ${JSON.stringify(options.identity)}`,
    )
  }
  await signer(options)
}

module.exports = signMac
