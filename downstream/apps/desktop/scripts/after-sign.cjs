'use strict'

const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const identity = require('../../../release/identity.json')
const { desktopChannel, desktopReleaseMode, desktopTrustedSigning } = require('./build-environment.cjs')

const EXPECTED_ARCHITECTURES = {
  1: 'x86_64',
  3: 'arm64',
}

/**
 * Parse the security facts emitted by `codesign --display --verbose=4`.
 * @param {string} output - combined stdout and stderr from codesign.
 * @returns {{ authorities: string[]; identifier?: string; runtime: boolean; teamIdentifier?: string; timestamp?: string }} parsed signature facts.
 */
function parseCodesignDisplay(output) {
  const facts = { authorities: [], runtime: false }
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith('Authority=')) facts.authorities.push(line.slice('Authority='.length))
    else if (line.startsWith('Identifier=')) facts.identifier = line.slice('Identifier='.length)
    else if (line.startsWith('TeamIdentifier=')) {
      facts.teamIdentifier = line.slice('TeamIdentifier='.length)
    } else if (line.startsWith('Timestamp=')) facts.timestamp = line.slice('Timestamp='.length)
    else if (line.includes('flags=') && line.includes('(runtime)')) facts.runtime = true
  }
  return facts
}

/**
 * Assert that a signed application matches the product's recorded Apple identity.
 * @param {ReturnType<typeof parseCodesignDisplay>} facts - parsed codesign facts.
 * @param {string} bundleId - expected channel Bundle ID.
 * @param {{ authorityChain: string[]; commonName: string; teamId: string }} signing - public certificate record.
 */
function assertMacSignatureFacts(facts, bundleId, signing) {
  if (facts.identifier !== bundleId) {
    throw new Error(`signed macOS application identifier is ${String(facts.identifier)}, expected ${bundleId}`)
  }
  assertMacSigningIdentityFacts(facts, signing, 'signed macOS application')
  if (!facts.runtime) throw new Error('signed macOS application does not enable hardened runtime')
}

/**
 * Assert that one code object uses the recorded Developer ID identity.
 * @param {ReturnType<typeof parseCodesignDisplay>} facts - parsed codesign facts.
 * @param {{ authorityChain: string[]; commonName: string; teamId: string }} signing - public certificate record.
 * @param {string} subject - non-secret artifact-relative object label.
 */
function assertMacSigningIdentityFacts(facts, signing, subject) {
  if (facts.teamIdentifier !== signing.teamId) {
    throw new Error(`${subject} team is ${String(facts.teamIdentifier)}, expected ${signing.teamId}`)
  }
  if (facts.authorities.length !== signing.authorityChain.length
    || facts.authorities.some((authority, index) => authority !== signing.authorityChain[index])) {
    throw new Error(`${subject} authority chain does not match the release ledger`)
  }
  if (facts.authorities[0] !== signing.commonName) {
    throw new Error(`${subject} leaf authority does not match the release ledger`)
  }
  if (facts.timestamp === undefined || facts.timestamp.length === 0) {
    throw new Error(`${subject} has no secure timestamp`)
  }
}

const MACH_O_MAGICS = new Set([
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
  0xcafebabf,
  0xbfbafeca,
])

/**
 * Detect a thin or universal Mach-O header without invoking an ambient tool.
 * @param {Buffer} header - first four or more file bytes.
 * @returns {boolean} whether the bytes carry a known Mach-O magic.
 */
function isMachOHeader(header) {
  return header.byteLength >= 4 && MACH_O_MAGICS.has(header.readUInt32BE(0))
}

/**
 * Enumerate every real Mach-O file below the application without following symlinks.
 * Framework symlink targets remain covered through their real Versions directories.
 * @param {string} root - signed application root.
 * @returns {string[]} sorted absolute Mach-O paths.
 */
function collectMachOFiles(root) {
  const files = []
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(candidate)
      } else if (entry.isFile()) {
        const descriptor = fs.openSync(candidate, 'r')
        try {
          const header = Buffer.allocUnsafe(4)
          const bytesRead = fs.readSync(descriptor, header, 0, header.byteLength, 0)
          if (isMachOHeader(header.subarray(0, bytesRead))) files.push(candidate)
        } finally {
          fs.closeSync(descriptor)
        }
      }
    }
  }
  visit(root)
  return files.sort()
}

function runCodesign(args) {
  const result = childProcess.spawnSync('/usr/bin/codesign', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`codesign ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return `${result.stdout}\n${result.stderr}`
}

function runCommand(command, args, label) {
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return `${result.stdout}\n${result.stderr}`
}

/**
 * Assert that one packaged Mach-O is thin for the isolated build target.
 * @param {string} output - `lipo -archs` output.
 * @param {string} expected - target architecture in lipo vocabulary.
 * @param {string} subject - artifact-relative object label.
 */
function assertMacArchitecture(output, expected, subject) {
  const architectures = output.trim().split(/\s+/u).filter(Boolean)
  if (architectures.length !== 1 || architectures[0] !== expected) {
    throw new Error(`${subject} architectures are ${architectures.join(', ') || 'empty'}, expected only ${expected}`)
  }
}

/**
 * Verify a trusted candidate or stable application after electron-builder notarizes it.
 * @param {{ appOutDir: string; electronPlatformName: string }} context - electron-builder hook context.
 * @returns {Promise<void>} completion after signature validation or an irrelevant-target no-op.
 */
async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin' || !desktopTrustedSigning(desktopReleaseMode())) return
  const channelIdentity = identity.channels[desktopChannel()]
  const appPath = path.join(context.appOutDir, `${channelIdentity.productName}.app`)
  const expectedArchitecture = EXPECTED_ARCHITECTURES[context.arch]
  if (expectedArchitecture === undefined) {
    throw new Error(`signed macOS application has unsupported target architecture ${String(context.arch)}`)
  }
  runCodesign(['--verify', '--deep', '--strict', '--verbose=4', appPath])
  const facts = parseCodesignDisplay(runCodesign(['--display', '--verbose=4', appPath]))
  assertMacSignatureFacts(facts, channelIdentity.bundleId, identity.macSigning)
  const machOFiles = collectMachOFiles(appPath)
  if (machOFiles.length === 0) throw new Error('signed macOS application contains no Mach-O code')
  for (const file of machOFiles) {
    const subject = path.relative(appPath, file)
    const codeFacts = parseCodesignDisplay(runCodesign(['--display', '--verbose=4', file]))
    assertMacSigningIdentityFacts(codeFacts, identity.macSigning, subject)
    assertMacArchitecture(
      runCommand('/usr/bin/lipo', ['-archs', file], `lipo ${subject}`),
      expectedArchitecture,
      subject,
    )
  }
  runCommand('/usr/bin/xcrun', ['stapler', 'validate', '-v', appPath], 'stapler validate application')
  runCommand(
    '/usr/sbin/spctl',
    ['--assess', '--type', 'execute', '--verbose=4', appPath],
    'Gatekeeper assess application',
  )
  console.log(`dsh-gui signing: verified the recorded Developer ID on ${machOFiles.length} Mach-O files`)
}

module.exports = afterSign
module.exports.assertMacArchitecture = assertMacArchitecture
module.exports.assertMacSigningIdentityFacts = assertMacSigningIdentityFacts
module.exports.assertMacSignatureFacts = assertMacSignatureFacts
module.exports.collectMachOFiles = collectMachOFiles
module.exports.isMachOHeader = isMachOHeader
module.exports.parseCodesignDisplay = parseCodesignDisplay
