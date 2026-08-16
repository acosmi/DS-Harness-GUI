import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const identity = require('../../../release/identity.json') as {
  channels: {
    stable: {
      productName: string
      mac: {
        helperBundleId: string
        helperRendererBundleId: string
        helperPluginBundleId: string
        helperGpuBundleId: string
        helperEhBundleId: string
      }
    }
  }
}
const { assertMacHelperIdentifiers } = require('../scripts/after-pack.cjs') as {
  assertMacHelperIdentifiers(
    actualIdentifiers: ReadonlyMap<string, unknown>,
    productName: string,
    macIdentity: typeof identity.channels.stable.mac,
  ): void
}

const { mac, productName } = identity.channels.stable
const currentHelpers = new Map([
  [`${productName} Helper.app`, mac.helperBundleId],
  [`${productName} Helper (Renderer).app`, mac.helperRendererBundleId],
  [`${productName} Helper (Plugin).app`, mac.helperPluginBundleId],
  [`${productName} Helper (GPU).app`, mac.helperGpuBundleId],
])

describe('macOS helper identity acceptance', () => {
  it('accepts the current Electron helper set and an optional EH helper', () => {
    expect(() => assertMacHelperIdentifiers(currentHelpers, productName, mac)).not.toThrow()
    expect(() => assertMacHelperIdentifiers(new Map([
      ...currentHelpers,
      [`${productName} Helper EH.app`, mac.helperEhBundleId],
    ]), productName, mac)).not.toThrow()
  })

  it('rejects missing, unrecognized, or differently identified helpers', () => {
    const missing = new Map(currentHelpers)
    missing.delete(`${productName} Helper (GPU).app`)
    expect(() => assertMacHelperIdentifiers(missing, productName, mac)).toThrow(/missing/)

    expect(() => assertMacHelperIdentifiers(new Map([
      ...currentHelpers,
      [`${productName} Helper NP.app`, `${mac.helperBundleId}.np`],
    ]), productName, mac)).toThrow(/explicit release identity/)

    const wrong = new Map(currentHelpers)
    wrong.set(`${productName} Helper.app`, 'com.example.ambiguous.helper')
    expect(() => assertMacHelperIdentifiers(wrong, productName, mac)).toThrow(/Unexpected bundle identifier/)
  })
})
