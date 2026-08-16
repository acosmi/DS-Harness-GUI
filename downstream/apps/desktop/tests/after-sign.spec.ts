import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const identity = require('../../../release/identity.json') as {
  macSigning: { authorityChain: string[]; commonName: string; identitySha1: string; teamId: string }
  channels: { stable: { bundleId: string } }
}
const {
  assertMacArchitecture,
  assertMacCertificateSha1,
  assertMacSigningIdentityFacts,
  assertMacSignatureFacts,
  isMachOHeader,
  macCertificateExtractionArgs,
  parseCodesignDisplay,
} = require('../scripts/after-sign.cjs') as {
  assertMacArchitecture(output: string, expected: string, subject: string): void
  assertMacCertificateSha1(certificate: Buffer, expectedSha1: string, subject: string): void
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
  macCertificateExtractionArgs(prefix: string, file: string): string[]
  parseCodesignDisplay(output: string): {
    authorities: string[]
    cdhash?: string
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
  'CDHash=3bf1a760bae1ba674852c487572511cc731d4fa0',
  'Authority=Developer ID Application: Zhigang Fu (Z6BDN8ZHTY)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'Timestamp=Aug 15, 2026 at 12:00:00',
  'TeamIdentifier=Z6BDN8ZHTY',
].join('\n')

describe('stable macOS signature acceptance', () => {
  it('accepts only the recorded Bundle ID, authority chain, team, runtime, and timestamp', () => {
    const facts = parseCodesignDisplay(VALID_DISPLAY)
    expect(facts.cdhash).toBe('3bf1a760bae1ba674852c487572511cc731d4fa0')
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

  it('accepts only the exact leaf certificate SHA-1 embedded in each signature', () => {
    const certificate = Buffer.from('recorded Developer ID leaf certificate')
    const expectedSha1 = createHash('sha1').update(certificate).digest('hex').toUpperCase()
    expect(() => assertMacCertificateSha1(certificate, expectedSha1, 'Contents/MacOS/DSH-GUI')).not.toThrow()
    expect(() => assertMacCertificateSha1(
      certificate,
      identity.macSigning.identitySha1,
      'Contents/MacOS/DSH-GUI',
    )).toThrow(/certificate SHA-1/)
  })

  it('binds the certificate extraction prefix as one codesign option', () => {
    expect(macCertificateExtractionArgs('/tmp/certificate-', '/tmp/DSH-GUI.app')).toEqual([
      '--display',
      '--extract-certificates=/tmp/certificate-',
      '/tmp/DSH-GUI.app',
    ])
  })

  it('recognizes thin and universal Mach-O headers without accepting arbitrary files', () => {
    expect(isMachOHeader(Buffer.from([0xfe, 0xed, 0xfa, 0xcf]))).toBe(true)
    expect(isMachOHeader(Buffer.from([0xca, 0xfe, 0xba, 0xbe]))).toBe(true)
    expect(isMachOHeader(Buffer.from('#!/bin/sh\n'))).toBe(false)
    expect(isMachOHeader(Buffer.alloc(3))).toBe(false)
  })

  it('accepts only the isolated target architecture for every Mach-O object', () => {
    expect(() => assertMacArchitecture('arm64\n', 'arm64', 'Contents/MacOS/DSH-GUI')).not.toThrow()
    expect(() => assertMacArchitecture('x86_64 arm64\n', 'arm64', 'Contents/MacOS/DSH-GUI'))
      .toThrow(/x86_64, arm64.*only arm64/)
    expect(() => assertMacArchitecture('x86_64\n', 'arm64', 'Contents/MacOS/DSH-GUI'))
      .toThrow(/expected only arm64/)
  })
})
