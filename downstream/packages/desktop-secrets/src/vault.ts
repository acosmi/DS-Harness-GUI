/** Main-process OS-protected encrypted vault. */

import { createHash, randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const MAX_DESKTOP_PROFILE_FILE_BYTES = 4_096
const MAX_DESKTOP_VAULT_FILE_BYTES = 8 * 1_024 * 1_024
const MAX_DESKTOP_VAULT_PLAINTEXT_BYTES = 4 * 1_024 * 1_024
const MAX_DESKTOP_VAULT_SECRET_COUNT = 256

/** Maximum UTF-8 bytes accepted for one desktop vault value and one bridge write. */
export const MAX_DESKTOP_SECRET_VALUE_BYTES = 1_048_576

/** Encryption surface implemented by Electron safeStorage after app readiness. */
export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** Persistence guarantee attached to one main-process secret vault. */
export type DesktopSecretPersistence = 'os-protected' | 'session-memory'

/** Secret operations owned by the trusted main process. */
export interface DesktopSecretVault {
  readonly persistence: DesktopSecretPersistence
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/** Immutable context that prevents a vault from being transplanted across products or profiles. */
export interface VaultBinding {
  readonly productId: string
  readonly channel: 'stable' | 'canary'
  readonly issuer: string
  readonly profileId: string
}

interface VaultEnvelope {
  readonly version: 2
  readonly bindingSha256: string
  readonly ciphertext: string
}

interface VaultPlaintext {
  readonly version: 2
  readonly binding: VaultBinding
  readonly secrets: Record<string, string>
}

interface ProfileRecord {
  readonly version: 1
  readonly id: string
}

/**
 * Load the channel-local profile identifier or create it atomically.
 * @param filename - owner-only record under the channel userData directory.
 * @returns stable UUID used only for local vault partitioning.
 */
export async function loadOrCreateVaultProfileId(filename: string): Promise<string> {
  let raw: string
  try {
    raw = await readBoundedUtf8File(filename, MAX_DESKTOP_PROFILE_FILE_BYTES, 'profile record')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const profile: ProfileRecord = { version: 1, id: randomUUID() }
    await writeFileAtomic(filename, `${JSON.stringify(profile)}\n`, { mode: 0o600, dirMode: 0o700 })
    return profile.id
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (cause) {
    throw new Error('desktop vault: profile record is not JSON', { cause })
  }
  if (!isExactRecord(value, ['version', 'id']) || value.version !== 1
    || typeof value.id !== 'string' || !isUuid(value.id)) {
    throw new Error('desktop vault: profile record is invalid')
  }
  return value.id
}

/** Versioned vault encrypted as one OS-user-bound payload. */
export class ProtectedSecretVault implements DesktopSecretVault {
  readonly persistence = 'os-protected' as const
  private operation: Promise<void> = Promise.resolve()
  private readonly binding: VaultBinding
  private readonly bindingSha256: string

  /**
   * @param filename - channel-specific encrypted-vault path under Electron userData.
   * @param storage - Electron safeStorage adapter.
   * @param binding - immutable product, channel, issuer and profile identity.
   */
  constructor(
    private readonly filename: string,
    private readonly storage: SafeStorageAdapter,
    binding: VaultBinding,
  ) {
    this.binding = validateBinding(binding)
    this.bindingSha256 = hashBinding(this.binding)
  }

  /** Read one namespaced secret. */
  get(key: string): Promise<string | undefined> {
    return this.serial(async () => (await this.readAll()).get(assertKey(key)))
  }

  /** Store one non-empty secret and commit atomically. */
  set(key: string, value: string): Promise<void> {
    return this.serial(async () => {
      assertKey(key)
      assertValue(value)
      const values = await this.readAll()
      values.set(key, value)
      await this.writeAll(values)
    })
  }

  /** Remove one secret; absence is a successful no-op. */
  delete(key: string): Promise<void> {
    return this.serial(async () => {
      const values = await this.readAll()
      if (!values.delete(assertKey(key))) return
      await this.writeAll(values)
    })
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const current = this.operation.then(work, work)
    this.operation = current.then(() => undefined, () => undefined)
    return current
  }

  private requireEncryption(): void {
    if (!this.storage.isEncryptionAvailable()) {
      throw new Error('desktop vault: operating-system encryption is unavailable')
    }
  }

  private async readAll(): Promise<Map<string, string>> {
    this.requireEncryption()
    let raw: string
    try {
      raw = await readBoundedUtf8File(this.filename, MAX_DESKTOP_VAULT_FILE_BYTES, 'encrypted envelope')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
      throw error
    }
    const envelope = parseEnvelope(raw)
    if (envelope.bindingSha256 !== this.bindingSha256) {
      throw new Error('desktop vault: encrypted envelope belongs to another product profile')
    }
    let plainText: string
    try {
      plainText = this.storage.decryptString(Buffer.from(envelope.ciphertext, 'base64'))
    } catch (cause) {
      throw new Error('desktop vault: encrypted payload cannot be decrypted for this OS user', { cause })
    }
    if (Buffer.byteLength(plainText, 'utf8') > MAX_DESKTOP_VAULT_PLAINTEXT_BYTES) {
      throw new Error('desktop vault: decrypted payload exceeds the storage limit')
    }
    let value: unknown
    try {
      value = JSON.parse(plainText)
    } catch (cause) {
      throw new Error('desktop vault: decrypted payload is not JSON', { cause })
    }
    const payload = parsePlaintext(value)
    if (!sameBinding(payload.binding, this.binding)) {
      throw new Error('desktop vault: decrypted payload belongs to another product profile')
    }
    const values = new Map(Object.entries(payload.secrets))
    assertVaultCapacity(values)
    return values
  }

  private async writeAll(values: ReadonlyMap<string, string>): Promise<void> {
    this.requireEncryption()
    assertVaultCapacity(values)
    const secrets = Object.fromEntries([...values].sort(([left], [right]) => left.localeCompare(right)))
    const payload: VaultPlaintext = { version: 2, binding: this.binding, secrets }
    const plainText = JSON.stringify(payload)
    if (Buffer.byteLength(plainText, 'utf8') > MAX_DESKTOP_VAULT_PLAINTEXT_BYTES) {
      throw new Error('desktop vault: secret collection exceeds the storage limit')
    }
    const encrypted = this.storage.encryptString(plainText)
    const envelope: VaultEnvelope = {
      version: 2,
      bindingSha256: this.bindingSha256,
      ciphertext: encrypted.toString('base64'),
    }
    const serialized = `${JSON.stringify(envelope)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DESKTOP_VAULT_FILE_BYTES) {
      throw new Error('desktop vault: encrypted envelope exceeds the storage limit')
    }
    await writeFileAtomic(this.filename, serialized, { mode: 0o600, dirMode: 0o700 })
  }
}

/** Process-local fallback when the runtime cannot establish protected persistence. */
export class SessionSecretVault implements DesktopSecretVault {
  readonly persistence = 'session-memory' as const
  private readonly values = new Map<string, string>()

  /** Read one process-local secret. */
  async get(key: string): Promise<string | undefined> {
    return this.values.get(assertKey(key))
  }

  /** Keep one non-empty secret until this process exits. */
  async set(key: string, value: string): Promise<void> {
    const validKey = assertKey(key)
    assertValue(value)
    const next = new Map(this.values)
    next.set(validKey, value)
    assertVaultCapacity(next)
    this.values.set(validKey, value)
  }

  /** Remove one process-local secret. */
  async delete(key: string): Promise<void> {
    this.values.delete(assertKey(key))
  }
}

function parseEnvelope(raw: string): VaultEnvelope {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (cause) {
    throw new Error('desktop vault: envelope is not JSON', { cause })
  }
  if (!isExactRecord(value, ['version', 'bindingSha256', 'ciphertext'])
    || value.version !== 2
    || typeof value.bindingSha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.bindingSha256)
    || typeof value.ciphertext !== 'string'
    || !isCanonicalBase64(value.ciphertext)) {
    throw new Error('desktop vault: unsupported encrypted envelope')
  }
  return value as unknown as VaultEnvelope
}

function parsePlaintext(value: unknown): VaultPlaintext {
  if (!isExactRecord(value, ['version', 'binding', 'secrets']) || value.version !== 2
    || typeof value.binding !== 'object' || value.binding === null
    || !isStringRecord(value.secrets)) {
    throw new Error('desktop vault: decrypted payload is not a secret map')
  }
  return {
    version: 2,
    binding: validateBinding(value.binding as VaultBinding),
    secrets: value.secrets,
  }
}

function validateBinding(value: VaultBinding): VaultBinding {
  if (!isExactRecord(value, ['productId', 'channel', 'issuer', 'profileId'])
    || typeof value.productId !== 'string'
    || !/^com\.acosmi\.dsharness\.gui(?:\.canary)?$/u.test(value.productId)
    || (value.channel !== 'stable' && value.channel !== 'canary')
    || typeof value.issuer !== 'string'
    || value.issuer !== 'https://acosmi.com'
    || typeof value.profileId !== 'string'
    || !isUuid(value.profileId)) {
    throw new Error('desktop vault: binding is invalid')
  }
  const expectedProduct = value.channel === 'stable'
    ? 'com.acosmi.dsharness.gui'
    : 'com.acosmi.dsharness.gui.canary'
  if (value.productId !== expectedProduct) throw new Error('desktop vault: product and channel binding disagree')
  return Object.freeze({ ...value })
}

function hashBinding(binding: VaultBinding): string {
  return createHash('sha256').update(JSON.stringify([
    binding.productId,
    binding.channel,
    binding.issuer,
    binding.profileId,
  ])).digest('hex')
}

function sameBinding(left: VaultBinding, right: VaultBinding): boolean {
  return left.productId === right.productId
    && left.channel === right.channel
    && left.issuer === right.issuer
    && left.profileId === right.profileId
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.entries(value).every(([key, entry]) => isKey(key) && typeof entry === 'string' && isValue(entry))
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key))
    && keys.every(key => Object.hasOwn(value, key))
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false
  return Buffer.from(value, 'base64').toString('base64') === value
}

function assertKey(value: string): string {
  if (!isKey(value)) throw new Error('desktop vault rejected an invalid secret key')
  return value
}

function assertValue(value: string): void {
  if (!isValue(value)) {
    throw new Error(value.length === 0
      ? 'desktop vault refuses empty secret values'
      : 'desktop vault: secret value exceeds the storage limit')
  }
}

function isValue(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_DESKTOP_SECRET_VALUE_BYTES
}

function assertVaultCapacity(values: ReadonlyMap<string, string>): void {
  if (values.size > MAX_DESKTOP_VAULT_SECRET_COUNT) {
    throw new Error('desktop vault: secret collection exceeds the entry limit')
  }
  let bytes = 0
  for (const [key, value] of values) {
    assertValue(value)
    bytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8')
    if (bytes > MAX_DESKTOP_VAULT_PLAINTEXT_BYTES) {
      throw new Error('desktop vault: secret collection exceeds the storage limit')
    }
  }
}

function isKey(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

async function readBoundedUtf8File(filename: string, maxBytes: number, label: string): Promise<string> {
  const handle = await open(filename, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error(`desktop vault: ${label} is not a regular file`)
    if (stat.size > maxBytes) throw new Error(`desktop vault: ${label} exceeds the storage limit`)
    const buffer = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const probe = Buffer.allocUnsafe(1)
    const { bytesRead: extraBytes } = await handle.read(probe, 0, 1, offset)
    if (offset !== buffer.length || extraBytes !== 0) {
      throw new Error(`desktop vault: ${label} changed while being read`)
    }
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}
