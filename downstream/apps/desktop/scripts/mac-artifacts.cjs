'use strict'

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const identity = require('../../../release/identity.json')
const { desktopMacNotarizationCredentials } = require('./build-environment.cjs')
const {
  assertMacArchitecture,
  assertMacSignatureFacts,
  assertMacSigningIdentityFacts,
  collectMachOFiles,
  parseCodesignDisplay,
  verifyMacSigningCertificate,
} = require('./after-sign.cjs')

const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024

function execute(command, args, label) {
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result
}

function run(command, args, label) {
  const result = execute(command, args, label)
  return `${result.stdout}\n${result.stderr}`
}

/**
 * Build notarytool authorization arguments for one validated credential family.
 * @param {NodeJS.ProcessEnv} environment - process environment carrying one complete family.
 * @returns {string[]} arguments that must never be logged.
 */
function notaryAuthorizationArgs(environment = process.env) {
  const family = desktopMacNotarizationCredentials(environment)
  if (family === null) throw new Error('macOS notarization credentials are not configured')
  if (family === 'api-key') {
    return [
      '--key', environment.APPLE_API_KEY,
      '--key-id', environment.APPLE_API_KEY_ID,
      '--issuer', environment.APPLE_API_ISSUER,
    ]
  }
  if (family === 'apple-id') {
    return [
      '--apple-id', environment.APPLE_ID,
      '--password', environment.APPLE_APP_SPECIFIC_PASSWORD,
      '--team-id', environment.APPLE_TEAM_ID,
    ]
  }
  const args = ['--keychain-profile', environment.APPLE_KEYCHAIN_PROFILE]
  if (typeof environment.APPLE_KEYCHAIN === 'string' && environment.APPLE_KEYCHAIN.length > 0) {
    args.push('--keychain', environment.APPLE_KEYCHAIN)
  }
  return args
}

/** Parse a successful notarytool JSON response without accepting an incomplete result. */
function parseNotarySubmission(output) {
  let value
  try {
    value = JSON.parse(output)
  } catch (error) {
    throw new Error('notarytool returned malformed JSON', { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || typeof value.id !== 'string' || value.id.length === 0
    || value.status !== 'Accepted') {
    throw new Error('notarytool did not return an accepted submission')
  }
  return value.id
}

function codesignDisplay(file) {
  return parseCodesignDisplay(run(
    '/usr/bin/codesign',
    ['--display', '--verbose=4', file],
    `codesign display ${path.basename(file)}`,
  ))
}

/**
 * Require stapling to preserve the signed disk image's CodeDirectory hash.
 * @param {string | undefined} before - cdhash read from the verified signed image.
 * @param {string | undefined} after - cdhash read after ticket stapling.
 * @param {string} subject - non-secret artifact-relative object label.
 */
function assertMacCdhashUnchanged(before, after, subject) {
  if (before === undefined || before.length === 0) {
    throw new Error(`${subject} has no signed disk-image cdhash before notarization`)
  }
  if (after === undefined || after.length === 0) {
    throw new Error(`${subject} has no disk-image cdhash after ticket stapling`)
  }
  if (after !== before) {
    throw new Error(`${subject} cdhash changed from ${before} to ${after} during ticket stapling`)
  }
}

function verifyApplication(appPath, channel, expectedArchitecture) {
  const channelIdentity = identity.channels[channel]
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath], 'codesign application')
  assertMacSignatureFacts(codesignDisplay(appPath), channelIdentity.bundleId, identity.macSigning)
  verifyMacSigningCertificate(appPath, identity.macSigning, 'packaged macOS application')
  const machOFiles = collectMachOFiles(appPath)
  if (machOFiles.length === 0) throw new Error('packaged application contains no Mach-O code')
  for (const file of machOFiles) {
    const subject = path.relative(appPath, file)
    assertMacSigningIdentityFacts(codesignDisplay(file), identity.macSigning, subject)
    verifyMacSigningCertificate(file, identity.macSigning, subject)
    assertMacArchitecture(
      run('/usr/bin/lipo', ['-archs', file], `lipo ${subject}`),
      expectedArchitecture,
      subject,
    )
  }
  run('/usr/bin/xcrun', ['stapler', 'validate', '-v', appPath], 'stapler validate application')
  run(
    '/usr/sbin/spctl',
    ['--assess', '--type', 'execute', '--verbose=4', appPath],
    'Gatekeeper assess application',
  )
}

function notarizeAndVerifyDmg(dmgPath, environment) {
  const subject = path.basename(dmgPath)
  run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', dmgPath], 'codesign disk image')
  const signedFacts = codesignDisplay(dmgPath)
  assertMacSigningIdentityFacts(signedFacts, identity.macSigning, subject)
  verifyMacSigningCertificate(dmgPath, identity.macSigning, subject)
  const authorization = notaryAuthorizationArgs(environment)
  const output = execute(
    '/usr/bin/xcrun',
    ['notarytool', 'submit', dmgPath, ...authorization, '--wait', '--output-format', 'json'],
    `notarytool submit ${path.basename(dmgPath)}`,
  )
  const submissionId = parseNotarySubmission(output.stdout.trim())
  run('/usr/bin/xcrun', ['stapler', 'staple', '-v', dmgPath], 'stapler staple disk image')
  run('/usr/bin/xcrun', ['stapler', 'validate', '-v', dmgPath], 'stapler validate disk image')
  run('/usr/bin/hdiutil', ['verify', dmgPath], 'hdiutil verify disk image')
  const stapledFacts = codesignDisplay(dmgPath)
  assertMacCdhashUnchanged(signedFacts.cdhash, stapledFacts.cdhash, subject)
  run(
    '/usr/sbin/spctl',
    ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmgPath],
    'Gatekeeper assess disk image',
  )
  return submissionId
}

function verifyZip(zipPath, channel, expectedArchitecture) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gui-zip-verify-'))
  try {
    run('/usr/bin/ditto', ['-x', '-k', zipPath, temporaryRoot], 'extract update archive')
    const productName = identity.channels[channel].productName
    const appPath = path.join(temporaryRoot, `${productName}.app`)
    if (!fs.statSync(appPath).isDirectory()) throw new Error('update archive does not contain the product application')
    verifyApplication(appPath, channel, expectedArchitecture)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

function electronBuilderBlockmapBuilder() {
  const electronBuilderManifest = require.resolve('electron-builder/package.json')
  const blockmapModulePath = require.resolve(
    'app-builder-lib/out/targets/blockmap/blockmap.js',
    { paths: [path.dirname(electronBuilderManifest)] },
  )
  const blockmapModule = require(blockmapModulePath)
  if (typeof blockmapModule.buildBlockMap !== 'function') {
    throw new Error('electron-builder blockmap generator is unavailable')
  }
  return blockmapModule.buildBlockMap
}

/**
 * Replace a packaged artifact's blockmap with one generated from its current bytes.
 * @param {string} artifactPath - final artifact whose bytes the blockmap must describe.
 * @returns {Promise<string>} regenerated blockmap path.
 */
async function rebuildArtifactBlockmap(artifactPath) {
  const artifact = fs.statSync(artifactPath)
  if (!artifact.isFile()) throw new Error(`blockmap source is not a file: ${artifactPath}`)
  const blockmapPath = `${artifactPath}.blockmap`
  const temporaryPath = `${blockmapPath}.${process.pid}.tmp`
  try {
    const result = await electronBuilderBlockmapBuilder()(artifactPath, 'gzip', temporaryPath)
    const finalArtifact = fs.statSync(artifactPath)
    if (!finalArtifact.isFile() || result === null || typeof result !== 'object'
      || result.size !== finalArtifact.size) {
      throw new Error(`generated blockmap does not describe the final artifact bytes: ${artifactPath}`)
    }
    const temporaryBlockmap = fs.statSync(temporaryPath)
    if (!temporaryBlockmap.isFile() || temporaryBlockmap.size === 0) {
      throw new Error(`generated blockmap is empty: ${temporaryPath}`)
    }
    fs.renameSync(temporaryPath, blockmapPath)
  } finally {
    fs.rmSync(temporaryPath, { force: true })
  }
  return blockmapPath
}

async function sha256(file) {
  const hash = crypto.createHash('sha256')
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(file)
    input.on('data', chunk => hash.update(chunk))
    input.once('error', reject)
    input.once('end', resolve)
  })
  return hash.digest('hex')
}

/**
 * Resolve the two distributable paths for one isolated macOS target.
 * @param {string} artifactRoot - channel-specific artifact directory.
 * @param {string} productName - channel product name.
 * @param {string} version - desktop package version.
 * @param {'arm64' | 'x64'} arch - electron-builder artifact architecture.
 * @returns {{ dmgPath: string; zipPath: string }} exact distributable paths.
 */
function macArtifactPaths(artifactRoot, productName, version, arch) {
  const artifactBase = `${productName}-${version}-${arch}`
  return {
    dmgPath: path.join(artifactRoot, `${artifactBase}.dmg`),
    zipPath: path.join(artifactRoot, `${artifactBase}.zip`),
  }
}

/**
 * Remove only the named target's old distributables and update metadata.
 * @param {{ dmgPath: string; zipPath: string }} artifacts - exact target paths.
 * @returns {string[]} removed paths.
 */
function removeMacArtifactResidue(artifacts) {
  const candidates = [
    artifacts.dmgPath,
    `${artifacts.dmgPath}.blockmap`,
    artifacts.zipPath,
    `${artifacts.zipPath}.blockmap`,
  ]
  const removed = []
  for (const candidate of candidates) {
    let details
    try {
      details = fs.lstatSync(candidate)
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') continue
      throw error
    }
    if (details.isDirectory()) {
      throw new Error(`refusing to remove macOS artifact residue because it is a directory: ${candidate}`)
    }
    fs.unlinkSync(candidate)
    removed.push(candidate)
  }
  return removed
}

/**
 * Notarize the final DMG and verify both distributable formats after packaging.
 * @param {{ channel: 'stable' | 'canary'; dmgPath: string; environment?: NodeJS.ProcessEnv; expectedArchitecture: 'arm64' | 'x86_64'; zipPath: string }} options - final artifact paths and target facts.
 * @returns {Promise<{ dmgSha256: string; submissionId: string; zipSha256: string }>} Apple submission and final hashes.
 */
async function finalizeMacArtifacts(options) {
  for (const artifact of [options.dmgPath, options.zipPath]) {
    if (!fs.statSync(artifact).isFile()) throw new Error(`expected macOS artifact is not a file: ${artifact}`)
  }
  const submissionId = notarizeAndVerifyDmg(options.dmgPath, options.environment ?? process.env)
  await rebuildArtifactBlockmap(options.dmgPath)
  verifyZip(options.zipPath, options.channel, options.expectedArchitecture)
  const [dmgSha256, zipSha256] = await Promise.all([sha256(options.dmgPath), sha256(options.zipPath)])
  return { dmgSha256, submissionId, zipSha256 }
}

module.exports = {
  assertMacCdhashUnchanged,
  finalizeMacArtifacts,
  macArtifactPaths,
  notaryAuthorizationArgs,
  parseNotarySubmission,
  rebuildArtifactBlockmap,
  removeMacArtifactResidue,
}
