import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const identity = require('../../../release/identity.json') as {
  macSigning: { authorityChain: string[]; commonName: string; teamId: string }
  channels: { stable: { bundleId: string } }
}
const {
  assertMacSigningIdentityFacts,
  assertMacSignatureFacts,
  isMachOHeader,
  parseCodesignDisplay,
} = require('../scripts/after-sign.cjs') as {
  assertMacSigningIdentityFacts(
    facts: ReturnType<typeof parseCodesignDisplay>,
    signing: typeof identity.macSigning,
    subject: string,
  ): void
  assertMacSignatureFacts(
    facts: ReturnType<typeof parseCodesignDisplay>,
    bundleId: string,
    signing: typeof identity.macSigning,
  ): void
  parseCodesignDisplay(output: string): {
    authorities: string[]
    identifier?: string
    runtime: boolean
    teamIdentifier?: string
    timestamp?: string
  }
  isMachOHeader(header: Buffer): boolean
}

const VALID_DISPLAY = [
  'Executable=/tmp/DSH-GUI.app/Contents/MacOS/DSH-GUI',
  'Identifier=com.acosmi.dsharness.gui',
  'Format=app bundle with Mach-O thin (arm64)',
  'CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+7 location=embedded',
  'Authority=Developer ID Application: Zhigang Fu (Z6BDN8ZHTY)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'Timestamp=Aug 15, 2026 at 12:00:00',
  'TeamIdentifier=Z6BDN8ZHTY',
].join('\n')

describe('stable macOS signature acceptance', () => {
  it('accepts only the recorded Bundle ID, authority chain, team, runtime, and timestamp', () => {
    const facts = parseCodesignDisplay(VALID_DISPLAY)
    expect(() => assertMacSignatureFacts(
      facts,
      identity.channels.stable.bundleId,
      identity.macSigning,
    )).not.toThrow()
  })

  it('rejects a different installed identity or an incomplete signature', () => {
    const oldIdentity = parseCodesignDisplay(VALID_DISPLAY.replace(
      identity.macSigning.authorityChain[0]!,
      'Developer ID Application: Old Identity (Z6BDN8ZHTY)',
    ))
    expect(() => assertMacSignatureFacts(
      oldIdentity,
      identity.channels.stable.bundleId,
      identity.macSigning,
    )).toThrow(/authority chain/)

    const noTimestamp = parseCodesignDisplay(VALID_DISPLAY.replace(/^Timestamp=.*\n/mu, ''))
    expect(() => assertMacSignatureFacts(
      noTimestamp,
      identity.channels.stable.bundleId,
      identity.macSigning,
    )).toThrow(/timestamp/)
  })

  it('rejects an embedded code object signed by another installed identity', () => {
    const oldIdentity = parseCodesignDisplay(VALID_DISPLAY.replace(
      identity.macSigning.authorityChain[0]!,
      'Developer ID Application: Old Identity (Z6BDN8ZHTY)',
    ))
    expect(() => assertMacSigningIdentityFacts(
      oldIdentity,
      identity.macSigning,
      'Contents/Frameworks/DSH-GUI Helper.app/Contents/MacOS/DSH-GUI Helper',
    )).toThrow(/authority chain/)
  })

  it('recognizes thin and universal Mach-O headers without accepting arbitrary files', () => {
    expect(isMachOHeader(Buffer.from([0xfe, 0xed, 0xfa, 0xcf]))).toBe(true)
    expect(isMachOHeader(Buffer.from([0xca, 0xfe, 0xba, 0xbe]))).toBe(true)
    expect(isMachOHeader(Buffer.from('#!/bin/sh\n'))).toBe(false)
    expect(isMachOHeader(Buffer.alloc(3))).toBe(false)
  })
})
