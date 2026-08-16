import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const identity = require('../../../release/identity.json') as {
  macSigning: { identitySha1: string }
}

const signMac = require('../scripts/sign-mac.cjs') as (
  options: { identity?: string },
  packager: unknown,
  signer?: (options: object) => Promise<void>,
) => Promise<void>

describe('trusted macOS signer', () => {
  it('passes the exact recorded SHA-1 through to osx-sign', async () => {
    const options = { identity: identity.macSigning.identitySha1 }
    const signer = vi.fn(async () => {})

    await signMac(options, undefined, signer)

    expect(signer).toHaveBeenCalledExactlyOnceWith(options)
  })

  it('rejects a common name or another certificate before signing', async () => {
    for (const selectedIdentity of [
      'Developer ID Application: Zhigang Fu (Z6BDN8ZHTY)',
      '154E8EBA07080CD21CC43EC128CE54C84B1EBACE',
    ]) {
      const signer = vi.fn(async () => {})
      await expect(signMac({ identity: selectedIdentity }, undefined, signer))
        .rejects.toThrow(/recorded certificate SHA-1/)
      expect(signer).not.toHaveBeenCalled()
    }
  })

  it('dynamically imports the ESM-only osx-sign when no signer is provided', async () => {
    const options = { identity: identity.macSigning.identitySha1 }
    // No signer: signMac must dynamic-import the ESM-only @electron/osx-sign 2.x
    // (a CJS require would throw ERR_REQUIRE_ESM). The real sign then rejects for
    // the missing app path, which proves the import resolved to the sign export.
    await expect(signMac(options, undefined)).rejects.toThrow('Path to application must be specified')
  })
})
