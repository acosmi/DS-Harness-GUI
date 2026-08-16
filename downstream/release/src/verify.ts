/** Machine-enforced release-ledger and signed-build readiness checks. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

interface ProductIdentity {
  readonly productName: string
  readonly productIdentifier: string
  readonly repository: string
  readonly publisher: {
    readonly legalEntity: string | null
  }
  readonly macSigning: MacSigningIdentity
  readonly channels: Record<'stable' | 'canary', ChannelIdentity>
}

interface MacSigningIdentity {
  readonly identitySha1: string
  readonly commonName: string
  readonly teamId: string
  readonly certificateId: string
  readonly serialNumber: string
  readonly validFrom: string
  readonly validUntil: string
  readonly authorityChain: readonly string[]
}

interface ChannelIdentity {
  readonly productName: string
  readonly bundleId: string
  readonly protocol: string
  readonly userDataDirectory: string
  readonly harnessDirectory: string
  readonly vaultFilename: string
  readonly profileFilename: string
  readonly secretNamespace: string
  readonly updateFeedId: string
  readonly mac: {
    readonly helperBundleId: string
    readonly helperRendererBundleId: string
    readonly helperPluginBundleId: string
    readonly helperGpuBundleId: string
    readonly helperEhBundleId: string
  }
  readonly windows: {
    readonly applicationId: string
    readonly aumid: string
    readonly executableName: string
    readonly installerGuid: string
    readonly startMenuShortcut: string
    readonly uninstallRegistryKey: string
    readonly updateFeedId: string
  }
}

interface UpstreamBaseline {
  readonly product: {
    readonly name: string
    readonly identifier: string
    readonly repository: string
  }
  readonly upstream: { readonly commit: string }
  readonly acosmiSdk: {
    readonly package: string
    readonly version: string
    readonly integrity: string
    readonly oauthState: {
      readonly publishedPackageCapable: boolean
      readonly patchPath: string | null
      readonly patchSha256: string | null
    }
    readonly tokenStoreFailurePropagation: { readonly publishedPackageCapable: boolean }
    readonly authenticatedAccountSubject: { readonly publishedPackageCapable: boolean }
    readonly openAiFinishReasonPreservation: { readonly publishedPackageCapable: boolean }
  }
  readonly runtime: {
    readonly electron: string
    readonly modules: string
    readonly napi: string
  }
  readonly lockfile: { readonly path: string; readonly sha256: string }
  readonly compatibility: {
    readonly status: 'implementation-in-progress' | 'passed' | 'failed'
    readonly verifiedAt: string | null
    readonly evidence: readonly string[]
  }
  readonly productCommit: string | null
  readonly releaseReadiness: {
    readonly stableBlocked: boolean
    readonly blockers: readonly string[]
  }
}

interface ExternalInputs {
  readonly inputs: readonly {
    readonly id: string
    readonly status: 'blocked' | 'ready'
    readonly releaseBlocking: boolean
    readonly ownerRole: string
  }[]
}

interface Responsibilities {
  readonly roles: readonly {
    readonly id: string
    readonly owner: string | null
    readonly backup: string | null
    readonly evidence: string | null
    readonly due: string | null
  }[]
}

interface SupportMatrix {
  readonly runtime: string
  readonly targets: readonly { readonly platform: string; readonly arch: string }[]
}

interface NativeModules {
  readonly electronAbi: string
  readonly napi: string
  readonly modules: readonly { readonly name: string; readonly targets: readonly string[] }[]
}

/** Loaded, schema-validated records used by the desktop build. */
export interface DesktopReleaseState {
  readonly baseline: UpstreamBaseline
  readonly identity: ProductIdentity
  readonly externalInputs: ExternalInputs
  readonly responsibilities: Responsibilities
  readonly supportMatrix: SupportMatrix
  readonly nativeModules: NativeModules
}

/** Options that distinguish implementation verification from a signed release gate. */
export interface DesktopReleaseVerifyOptions {
  /** Reject every recorded stable-release blocker when true. */
  readonly requireSignedReady?: boolean
}

const LEDGERS = [
  ['downstream/upstream-baseline.json', 'downstream/release/upstream-baseline.schema.json'],
  ['downstream/release/identity.json', 'downstream/release/identity.schema.json'],
  ['downstream/release/support-matrix.json', 'downstream/release/support-matrix.schema.json'],
  ['downstream/release/native-modules.json', 'downstream/release/native-modules.schema.json'],
  ['downstream/release/external-inputs.json', 'downstream/release/external-inputs.schema.json'],
  ['downstream/release/responsibilities.json', 'downstream/release/responsibilities.schema.json'],
] as const

const SDK_CONSUMER_MANIFESTS = [
  'downstream/packages/account-acosmi/package.json',
  'downstream/packages/desktop-secrets/package.json',
  'downstream/packages/llm-acosmi/package.json',
] as const

const REQUIRED_RESPONSIBILITY_ROLES = [
  'product',
  'desktop-engineering',
  'sdk',
  'identity-billing',
  'security-privacy',
  'legal-brand',
  'release',
  'qa-accessibility',
  'github-admin',
  'support-incident',
] as const

const REQUIRED_EXTERNAL_INPUTS = [
  { id: 'published-state-capable-sdk', releaseBlocking: true, ownerRole: 'sdk' },
  { id: 'acosmi-sdk-token-store-failure-propagation', releaseBlocking: true, ownerRole: 'sdk' },
  { id: 'acosmi-sdk-authenticated-account-subject', releaseBlocking: true, ownerRole: 'sdk' },
  { id: 'acosmi-sdk-openai-finish-reason-preservation', releaseBlocking: true, ownerRole: 'sdk' },
  { id: 'oauth-production-client-and-test-account', releaseBlocking: true, ownerRole: 'identity-billing' },
  { id: 'acosmi-managed-model-web-search-deduplication', releaseBlocking: true, ownerRole: 'support-incident' },
  { id: 'official-deepseek-api-key-real-service-validation', releaseBlocking: true, ownerRole: 'qa-accessibility' },
  { id: 'versioned-quota-comparison-claim', releaseBlocking: false, ownerRole: 'identity-billing' },
  { id: 'apple-signing-and-notary', releaseBlocking: true, ownerRole: 'release' },
  { id: 'windows-authenticode', releaseBlocking: true, ownerRole: 'release' },
  { id: 'signed-update-origin-and-keys', releaseBlocking: true, ownerRole: 'release' },
  { id: 'legal-brand-privacy-terms-support-approval', releaseBlocking: true, ownerRole: 'legal-brand' },
  { id: 'product-repository-write-and-protection', releaseBlocking: false, ownerRole: 'github-admin' },
  { id: 'macos-x64-final-package-matrix', releaseBlocking: true, ownerRole: 'qa-accessibility' },
  { id: 'windows-x64-final-package-matrix', releaseBlocking: true, ownerRole: 'qa-accessibility' },
] as const

const REQUIRED_SUPPORT_TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64'] as const
const REQUIRED_NATIVE_MODULES = ['node-pty', 'sharp', 'koffi', 'node-addon-require-builtin'] as const

/**
 * Validate every release record, its file hashes, and cross-record identities.
 * @param root - absolute repository root containing `downstream/` and the lockfile.
 * @param options - whether this invocation is authorizing a signed build.
 * @returns detached records safe for build configuration.
 */
export function verifyDesktopRelease(
  root: string,
  options: DesktopReleaseVerifyOptions = {},
): DesktopReleaseState {
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  const records = new Map<string, unknown>()
  for (const [recordPath, schemaPath] of LEDGERS) {
    const record = readJson(resolve(root, recordPath), recordPath)
    const schema = readJson(resolve(root, schemaPath), schemaPath)
    if (!isRecord(schema)) throw new Error(`${schemaPath} must contain a JSON object`)
    const validate = ajv.compile(schema)
    if (!validate(record)) {
      throw new Error(`${recordPath} does not satisfy ${schemaPath}: ${formatErrors(validate.errors)}`)
    }
    records.set(recordPath, structuredClone(record))
  }

  // Each cast follows validation against the closed schema named above.
  const state: DesktopReleaseState = {
    baseline: records.get(LEDGERS[0][0]) as UpstreamBaseline,
    identity: records.get(LEDGERS[1][0]) as ProductIdentity,
    supportMatrix: records.get(LEDGERS[2][0]) as SupportMatrix,
    nativeModules: records.get(LEDGERS[3][0]) as NativeModules,
    externalInputs: records.get(LEDGERS[4][0]) as ExternalInputs,
    responsibilities: records.get(LEDGERS[5][0]) as Responsibilities,
  }
  verifyConsistency(root, state)
  if (options.requireSignedReady === true) verifySignedReadiness(state)
  return state
}

function verifyConsistency(root: string, state: DesktopReleaseState): void {
  const { baseline, identity, externalInputs, responsibilities, supportMatrix, nativeModules } = state
  equal(identity.productName, baseline.product.name, 'product name')
  equal(identity.productIdentifier, baseline.product.identifier, 'product identifier')
  equal(identity.repository, baseline.product.repository, 'product repository')
  equal(supportMatrix.runtime, `Electron ${baseline.runtime.electron}`, 'support-matrix runtime')
  equal(nativeModules.electronAbi, baseline.runtime.modules, 'native-module Electron ABI')
  equal(nativeModules.napi, baseline.runtime.napi, 'native-module N-API version')
  verifyMacSigningIdentity(identity.macSigning)

  exactRoster(
    responsibilities.roles.map(role => role.id),
    REQUIRED_RESPONSIBILITY_ROLES,
    'responsibility role',
  )
  const roles = new Set(responsibilities.roles.map(role => role.id))
  exactRoster(
    externalInputs.inputs.map(input => input.id),
    REQUIRED_EXTERNAL_INPUTS.map(input => input.id),
    'external input',
  )
  for (const input of externalInputs.inputs) {
    if (!roles.has(input.ownerRole)) {
      throw new Error(`external input "${input.id}" references unknown owner role "${input.ownerRole}"`)
    }
    const required = REQUIRED_EXTERNAL_INPUTS.find(candidate => candidate.id === input.id)
    if (required === undefined) throw new Error(`external input "${input.id}" is not part of the required release record`)
    equal(input.releaseBlocking, required.releaseBlocking, `external input "${input.id}" release-blocking policy`)
    equal(input.ownerRole, required.ownerRole, `external input "${input.id}" owner role`)
  }
  verifySdkCapabilityInput(
    externalInputs,
    'published-state-capable-sdk',
    baseline.acosmiSdk.oauthState.publishedPackageCapable,
  )
  verifySdkCapabilityInput(
    externalInputs,
    'acosmi-sdk-token-store-failure-propagation',
    baseline.acosmiSdk.tokenStoreFailurePropagation.publishedPackageCapable,
  )
  verifySdkCapabilityInput(
    externalInputs,
    'acosmi-sdk-authenticated-account-subject',
    baseline.acosmiSdk.authenticatedAccountSubject.publishedPackageCapable,
  )
  verifySdkCapabilityInput(
    externalInputs,
    'acosmi-sdk-openai-finish-reason-preservation',
    baseline.acosmiSdk.openAiFinishReasonPreservation.publishedPackageCapable,
  )
  unique([...baseline.releaseReadiness.blockers], 'stable-release blocker')
  const projectedBlockers = externalInputs.inputs
    .filter(input => input.releaseBlocking && input.status === 'blocked')
    .map(input => input.id)
  if (!sameMembers(baseline.releaseReadiness.blockers, projectedBlockers)) {
    throw new Error('stable-release blockers do not match blocked release inputs')
  }
  equal(
    baseline.releaseReadiness.stableBlocked,
    baseline.releaseReadiness.blockers.length > 0,
    'stableBlocked projection',
  )

  verifyCanonicalChannelIdentities(identity)
  verifyChannelIdentity(identity.channels.stable, 'stable')
  verifyChannelIdentity(identity.channels.canary, 'canary')
  for (const field of ['bundleId', 'protocol', 'userDataDirectory', 'secretNamespace', 'updateFeedId'] as const) {
    if (identity.channels.stable[field] === identity.channels.canary[field]) {
      throw new Error(`stable and canary must have different ${field}`)
    }
  }
  if (identity.channels.stable.windows.installerGuid === identity.channels.canary.windows.installerGuid) {
    throw new Error('stable and canary must have different Windows installer GUIDs')
  }
  exactRoster(
    supportMatrix.targets.map(target => `${target.platform}-${target.arch}`),
    REQUIRED_SUPPORT_TARGETS,
    'support target',
  )
  exactRoster(nativeModules.modules.map(module => module.name), REQUIRED_NATIVE_MODULES, 'native module')
  for (const module of nativeModules.modules) {
    exactRoster(module.targets, REQUIRED_SUPPORT_TARGETS, `${module.name} target`)
  }

  const lockfile = resolve(root, baseline.lockfile.path)
  equal(sha256(lockfile), baseline.lockfile.sha256, 'lockfile SHA-256')
  verifySdkPin(root, baseline, lockfile)
  const oauth = baseline.acosmiSdk.oauthState
  if (oauth.publishedPackageCapable) {
    if (oauth.patchPath !== null || oauth.patchSha256 !== null) {
      throw new Error('a state-capable published SDK must not retain a local OAuth patch')
    }
  } else {
    if (oauth.patchPath === null || oauth.patchSha256 === null) {
      throw new Error('an OAuth-incapable published SDK requires an audited development patch')
    }
    equal(sha256(resolve(root, oauth.patchPath)), oauth.patchSha256, 'SDK OAuth patch SHA-256')
  }
}

function verifyMacSigningIdentity(signing: MacSigningIdentity): void {
  equal(signing.authorityChain[0], signing.commonName, 'macOS signing leaf authority')
  if (!signing.commonName.endsWith(`(${signing.teamId})`)) {
    throw new Error('macOS signing common name must carry the recorded Apple team id')
  }
  if (Date.parse(signing.validFrom) >= Date.parse(signing.validUntil)) {
    throw new Error('macOS signing certificate validity interval is not increasing')
  }
}

function verifySdkPin(root: string, baseline: UpstreamBaseline, lockfile: string): void {
  const sdk = baseline.acosmiSdk
  for (const manifestPath of SDK_CONSUMER_MANIFESTS) {
    const manifest = readJson(resolve(root, manifestPath), manifestPath)
    if (!isRecord(manifest) || !isRecord(manifest.dependencies)) {
      throw new Error(`${manifestPath} must contain a dependencies object`)
    }
    equal(manifest.dependencies[sdk.package], sdk.version, `${manifestPath} Acosmi SDK version`)
  }
  const lockfileText = readText(lockfile, baseline.lockfile.path)
  const packageRecord = `  '${sdk.package}@${sdk.version}':\n    resolution: {integrity: ${sdk.integrity}}`
  if (!lockfileText.includes(packageRecord)) {
    throw new Error('Acosmi SDK version and integrity do not match the lockfile registry entry')
  }
}

function verifySdkCapabilityInput(externalInputs: ExternalInputs, id: string, capable: boolean): void {
  const input = externalInputs.inputs.find(candidate => candidate.id === id)
  if (input === undefined) throw new Error(`SDK capability input "${id}" is missing`)
  equal(input.status, capable ? 'ready' : 'blocked', `SDK capability input "${id}" status`)
}

function verifySignedReadiness(state: DesktopReleaseState): void {
  if (!state.baseline.acosmiSdk.oauthState.publishedPackageCapable) {
    throw new Error('signed desktop build is blocked: the published Acosmi SDK lacks OAuth state protection')
  }
  if (!state.baseline.acosmiSdk.tokenStoreFailurePropagation.publishedPackageCapable) {
    throw new Error('signed desktop build is blocked: the published Acosmi SDK lacks TokenStore failure propagation')
  }
  if (!state.baseline.acosmiSdk.authenticatedAccountSubject.publishedPackageCapable) {
    throw new Error('signed desktop build is blocked: the published Acosmi SDK lacks an authenticated account subject')
  }
  if (!state.baseline.acosmiSdk.openAiFinishReasonPreservation.publishedPackageCapable) {
    throw new Error('signed desktop build is blocked: the published Acosmi SDK loses OpenAI stream finish reasons')
  }
  const { releaseReadiness } = state.baseline
  if (releaseReadiness.stableBlocked || releaseReadiness.blockers.length > 0) {
    throw new Error(`signed desktop build is blocked by ${String(releaseReadiness.blockers.length)} external input(s)`)
  }
  if (state.baseline.productCommit === null) {
    throw new Error('signed desktop build requires a frozen product commit')
  }
  const { compatibility } = state.baseline
  if (compatibility.status !== 'passed' || compatibility.verifiedAt === null || compatibility.evidence.length === 0) {
    throw new Error('signed desktop build requires recorded compatibility evidence')
  }
  const legalEntity = state.identity.publisher.legalEntity
  if (legalEntity === null || legalEntity.trim().length === 0) {
    throw new Error('signed desktop build requires a recorded publisher legal entity')
  }
  verifyResponsibilityReadiness(state.responsibilities)
}

function verifyResponsibilityReadiness(responsibilities: Responsibilities): void {
  for (const role of responsibilities.roles) {
    const { owner, backup, evidence, due } = role
    if (
      owner === null || owner.trim().length === 0
      || backup === null || backup.trim().length === 0
      || evidence === null || evidence.trim().length === 0
      || due === null || due.trim().length === 0
    ) {
      throw new Error(`signed desktop build requires a complete responsibility record for "${role.id}"`)
    }
    if (owner.trim() === backup.trim()) {
      throw new Error(`signed desktop build requires a distinct backup for responsibility "${role.id}"`)
    }
  }
}

function verifyCanonicalChannelIdentities(identity: ProductIdentity): void {
  const { stable, canary } = identity.channels
  equal(stable.productName, identity.productName, 'stable channel product name')
  equal(stable.bundleId, identity.productIdentifier, 'stable channel bundle id')
  equal(stable.protocol, 'dshgui', 'stable channel protocol')
  equal(stable.userDataDirectory, identity.productName, 'stable channel user-data directory')
  equal(stable.secretNamespace, identity.productIdentifier, 'stable channel secret namespace')
  equal(stable.updateFeedId, `${identity.productIdentifier}.stable`, 'stable channel update feed')
  equal(stable.windows.executableName, identity.productName, 'stable Windows executable name')
  equal(stable.windows.installerGuid, '7c9ff783-e4f7-47b7-97cb-3e79cfa72ca4', 'stable Windows installer GUID')
  equal(stable.windows.startMenuShortcut, identity.productName, 'stable Windows start-menu shortcut')

  const canaryProductName = `${identity.productName} Canary`
  const canaryIdentifier = `${identity.productIdentifier}.canary`
  equal(canary.productName, canaryProductName, 'canary channel product name')
  equal(canary.bundleId, canaryIdentifier, 'canary channel bundle id')
  equal(canary.protocol, 'dshgui-canary', 'canary channel protocol')
  equal(canary.userDataDirectory, canaryProductName, 'canary channel user-data directory')
  equal(canary.secretNamespace, canaryIdentifier, 'canary channel secret namespace')
  equal(canary.updateFeedId, canaryIdentifier, 'canary channel update feed')
  equal(canary.windows.executableName, `${identity.productName}-Canary`, 'canary Windows executable name')
  equal(canary.windows.installerGuid, '5574363d-cf7f-4f1e-9898-2510846e2ee6', 'canary Windows installer GUID')
  equal(canary.windows.startMenuShortcut, canaryProductName, 'canary Windows start-menu shortcut')
}

function verifyChannelIdentity(channel: ChannelIdentity, name: string): void {
  equal(channel.windows.applicationId, channel.bundleId, `${name} Windows application id`)
  equal(channel.windows.aumid, channel.bundleId, `${name} Windows AUMID`)
  equal(channel.windows.uninstallRegistryKey, channel.bundleId, `${name} Windows uninstall key`)
  equal(channel.windows.updateFeedId, channel.updateFeedId, `${name} Windows update feed`)
  equal(channel.secretNamespace, channel.bundleId, `${name} secret namespace`)
  const helpers = [
    channel.mac.helperBundleId,
    channel.mac.helperRendererBundleId,
    channel.mac.helperPluginBundleId,
    channel.mac.helperGpuBundleId,
    channel.mac.helperEhBundleId,
  ]
  if (helpers.some(helper => !helper.startsWith(`${channel.bundleId}.helper`))) {
    throw new Error(`${name} helper bundle ids must derive from the channel bundle id`)
  }
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`could not read ${label}`, { cause: error })
  }
}

function readText(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`could not read ${label}`, { cause: error })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch (error) {
    throw new Error(`could not hash release input ${path}`, { cause: error })
  }
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} does not match its authoritative release record`)
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label}s must be unique`)
}

function exactRoster(actual: readonly string[], expected: readonly string[], label: string): void {
  unique(actual, label)
  if (!sameMembers(actual, expected)) throw new Error(`${label} roster does not match the required release record`)
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(value => right.includes(value))
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ')
}
