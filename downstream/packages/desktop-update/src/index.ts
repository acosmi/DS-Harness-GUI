/** Signed release-index verification and fail-closed desktop update checks. */

import { createPublicKey, verify } from 'node:crypto'
import { z } from 'zod'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?$/u
const OS_VERSION = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,3}$/u
const MAX_UPDATE_INDEX_BYTES = 1024 * 1024

const artifactSchema = z.object({
  platform: z.enum(['darwin', 'win32']),
  arch: z.enum(['arm64', 'x64']),
  minimumOs: z.string().regex(OS_VERSION),
  url: z.url().refine((value) => {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === ''
  }, 'artifact URL must use credential-free HTTPS without a fragment'),
  size: z.number().int().positive(),
  sha512: z.string().regex(/^[A-Fa-f0-9]{128}$/u),
}).strict()

const releaseSchema = z.object({
  releaseId: z.uuid(),
  productId: z.string().min(1),
  channel: z.enum(['stable', 'canary']),
  version: z.string().regex(SEMVER),
  publishedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  artifacts: z.array(artifactSchema).min(1),
}).strict()

const indexSchema = z.object({
  schemaVersion: z.literal(1),
  release: releaseSchema,
  signature: z.object({
    algorithm: z.literal('ed25519'),
    keyId: z.string().min(1),
    value: z.string().min(1),
  }).strict(),
}).strict()

/** Verified canonical release record. */
export type DesktopRelease = z.infer<typeof releaseSchema>

/** Trusted roots and product binding for release-index verification. */
export interface ReleaseIndexPolicy {
  readonly productId: string
  readonly channel: 'stable' | 'canary'
  readonly platform: 'darwin' | 'win32'
  readonly arch: 'arm64' | 'x64'
  readonly osVersion: string
  readonly currentVersion: string
  readonly publicKeys: Readonly<Record<string, string>>
  readonly now?: Date
}

/** Update-check outcome safe to expose to the renderer. */
export type DesktopUpdateCheck =
  | { readonly status: 'current'; readonly checkedAt: number }
  | { readonly status: 'available'; readonly version: string; readonly artifact: DesktopRelease['artifacts'][number]; readonly checkedAt: number }

/**
 * Parse, authenticate and bind a release index to this product/platform.
 * @param input - untrusted JSON response.
 * @param policy - compiled product identity and trusted public keys.
 * @returns current/available result with the one matching artifact.
 */
export function verifyReleaseIndex(input: unknown, policy: ReleaseIndexPolicy): DesktopUpdateCheck {
  const index = indexSchema.parse(input)
  const artifactIds = index.release.artifacts.map(artifact => `${artifact.platform}-${artifact.arch}`)
  if (new Set(artifactIds).size !== artifactIds.length) throw new Error('release index contains duplicate platform artifacts')
  const publishedAt = new Date(index.release.publishedAt).getTime()
  const expiresAt = new Date(index.release.expiresAt).getTime()
  if (expiresAt <= publishedAt) throw new Error('release index expiry must follow publication')
  const key = Object.hasOwn(policy.publicKeys, index.signature.keyId)
    ? policy.publicKeys[index.signature.keyId]
    : undefined
  if (typeof key !== 'string') throw new Error('release index uses an unknown signing key')
  const signature = Buffer.from(index.signature.value, 'base64')
  if (signature.byteLength !== 64 || signature.toString('base64') !== index.signature.value) {
    throw new Error('release index signature encoding is invalid')
  }
  const publicKey = createPublicKey(key)
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('release index signing key must be Ed25519')
  const authenticated = verify(
    null,
    Buffer.from(canonicalJson(index.release)),
    publicKey,
    signature,
  )
  if (!authenticated) throw new Error('release index signature is invalid')
  if (index.release.productId !== policy.productId) throw new Error('release index product does not match')
  if (index.release.channel !== policy.channel) throw new Error('release index channel does not match')
  const now = policy.now ?? new Date()
  if (expiresAt <= now.getTime()) throw new Error('release index is expired')
  if (publishedAt > now.getTime() + 5 * 60_000) {
    throw new Error('release index publication time is in the future')
  }
  const artifact = index.release.artifacts.find(candidate => (
    candidate.platform === policy.platform && candidate.arch === policy.arch
  ))
  if (artifact === undefined) throw new Error('release index has no artifact for this platform')
  if (compareNumericVersions(artifact.minimumOs, policy.osVersion, 'operating-system version') > 0) {
    throw new Error('release artifact requires a newer operating system')
  }
  const checkedAt = now.getTime()
  if (compareVersions(index.release.version, policy.currentVersion) <= 0) return { status: 'current', checkedAt }
  return { status: 'available', version: index.release.version, artifact, checkedAt }
}

/**
 * Fetch and verify one update index with bounded response size.
 * @param url - immutable HTTPS release-index URL.
 * @param policy - product and trust policy.
 * @param signal - caller/timeout lifetime.
 * @returns authenticated update result.
 */
export async function checkDesktopUpdate(
  url: string,
  policy: ReleaseIndexPolicy,
  signal: AbortSignal,
): Promise<DesktopUpdateCheck> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    throw new Error('desktop update index must be credential-free HTTPS without a fragment')
  }
  const response = await fetch(parsed, {
    signal,
    headers: { accept: 'application/json' },
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`desktop update index returned HTTP ${String(response.status)}`)
  const contentLengthHeader = response.headers.get('content-length')
  if (contentLengthHeader !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(contentLengthHeader)) {
      throw new Error('desktop update index returned an invalid content length')
    }
    const contentLength = Number(contentLengthHeader)
    if (!Number.isSafeInteger(contentLength)) {
      throw new Error('desktop update index returned an invalid content length')
    }
    if (contentLength > MAX_UPDATE_INDEX_BYTES) throw new Error('desktop update index is too large')
  }
  const text = await readBoundedText(response, MAX_UPDATE_INDEX_BYTES)
  return verifyReleaseIndex(JSON.parse(text) as unknown, policy)
}

/** Read an untrusted response without buffering beyond the accepted byte limit. */
async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      total += item.value.byteLength
      if (total > limit) {
        try {
          await reader.cancel()
        } catch (_transportCancellationFailure) {
          // The size violation remains authoritative after the transport has already failed closed.
        }
        throw new Error('desktop update index is too large')
      }
      chunks.push(Buffer.from(item.value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

/** Deterministic JSON for the signed release payload. */
export function canonicalJson(value: unknown): string {
  return canonicalJsonValue(value, new Set())
}

function canonicalJsonValue(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') throw new Error('canonical JSON rejects non-JSON values')
  if (ancestors.has(value)) throw new Error('canonical JSON rejects circular values')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error('canonical JSON rejects sparse arrays')
      }
      return `[${value.map(item => canonicalJsonValue(item, ancestors)).join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value) as object | null
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('canonical JSON rejects non-JSON objects')
    }
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJsonValue(record[key], ancestors)}`
    )).join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): [string, string, string, string[] | undefined] => {
    const match = SEMVER.exec(value)
    if (match === null) throw new Error(`invalid semantic version ${JSON.stringify(value)}`)
    return [match[1]!, match[2]!, match[3]!, match[4]?.split('.')]
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    const order = compareNumericIdentifier(a[index] as string, b[index] as string)
    if (order !== 0) return order
  }
  if (a[3] === undefined && b[3] === undefined) return 0
  if (a[3] === undefined) return 1
  if (b[3] === undefined) return -1
  const length = Math.max(a[3].length, b[3].length)
  for (let index = 0; index < length; index += 1) {
    const leftId = a[3][index]
    const rightId = b[3][index]
    if (leftId === undefined) return -1
    if (rightId === undefined) return 1
    if (leftId === rightId) continue
    const leftNumeric = /^\d+$/u.test(leftId)
    const rightNumeric = /^\d+$/u.test(rightId)
    if (leftNumeric && rightNumeric) return compareNumericIdentifier(leftId, rightId)
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftId < rightId ? -1 : 1
  }
  return 0
}

function compareNumericVersions(left: string, right: string, label: string): number {
  if (!OS_VERSION.test(left) || !OS_VERSION.test(right)) throw new Error(`invalid ${label}`)
  const a = left.split('.')
  const b = right.split('.')
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const order = compareNumericIdentifier(a[index] ?? '0', b[index] ?? '0')
    if (order !== 0) return order
  }
  return 0
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}
