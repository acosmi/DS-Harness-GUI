/** Host credential provider and SDK TokenStore over the main-process vault bridge. */

import { isValidTokenSet, type TokenSet, type TokenStore } from '@acosmi/sdk-ts'
import { type Context } from '@deepseek-ai/cordis'
import {
  CredentialProvider,
  credentialRef,
  parseCredentialKey,
  type CredentialInfo,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type { DesktopSecretPersistence } from './vault.ts'

/** Utility-process client for the main-owned encrypted vault. */
export interface DesktopSecretBridge {
  /** Persistence guarantee of the main-process vault serving this bridge. */
  readonly persistence: DesktopSecretPersistence
  /** Resolve an approved inherited credential without placing it in the utility environment. */
  getEnvironmentCredential(ref: CredentialRef): Promise<string | undefined>
  /** Report whether an approved inherited credential is configured without revealing its value. */
  hasEnvironmentCredential(ref: CredentialRef): Promise<boolean>
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Main-process encrypted-vault client prepared before plugin mounting. */
    desktopSecrets: DesktopSecretBridge
  }
}

/** Install the main-process vault client before the configuration tree mounts. */
export function provideDesktopSecrets(ctx: Context, bridge: DesktopSecretBridge): void {
  ctx.provide('desktopSecrets', bridge)
}

/** Vault key for the JSON map of {@link CredentialKey} records. */
const RECORD_STORE_KEY = 'credential-records:v1'

/** Credentials provider that preserves inherited environment precedence. */
export class DesktopCredentialProvider extends CredentialProvider {
  static inject = ['desktopSecrets']
  private recordLock: Promise<void> = Promise.resolve()

  /** @param ctx - Host context with the vault bridge. */
  constructor(ctx: Context) {
    super(ctx)
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const inherited = await this.ctx.desktopSecrets.getEnvironmentCredential(ref)
    if (inherited !== undefined) return { value: inherited, source: 'environment' }
    const value = await this.ctx.desktopSecrets.get(referenceVaultKey(ref))
    return value === undefined ? undefined : { value, source: this.ctx.desktopSecrets.persistence }
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (await this.ctx.desktopSecrets.hasEnvironmentCredential(ref)) {
      return { configured: true, source: 'environment', writable: false }
    }
    const configured = await this.ctx.desktopSecrets.get(referenceVaultKey(ref)) !== undefined
    return { configured, ...(configured ? { source: this.ctx.desktopSecrets.persistence } : {}), writable: true }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    if (await this.ctx.desktopSecrets.hasEnvironmentCredential(ref)) {
      throw new Error(`credential ${ref} is supplied by the environment and is read-only`)
    }
    if (value.length === 0) throw new Error('desktop credentials refuse an empty value; unset it instead')
    await this.ctx.desktopSecrets.set(referenceVaultKey(ref), value)
    this.notifyUpdated(ref)
  }

  async unset(ref: CredentialRef): Promise<void> {
    if (await this.ctx.desktopSecrets.hasEnvironmentCredential(ref)) {
      throw new Error(`credential ${ref} is supplied by the environment and is read-only`)
    }
    await this.ctx.desktopSecrets.delete(referenceVaultKey(ref))
    this.notifyUpdated(ref)
  }

  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return (await this.loadRecords()).get(key)
  }

  async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const stored = await this.readRecord(key)
    if (stored === undefined) return { configured: false, writable: true }
    return { configured: true, kind: stored.kind, writable: true }
  }

  async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return [...await this.loadRecords()].map(([key, record]) => ({ key, kind: record.kind }))
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return this.withRecordLock(async () => {
      const records = await this.loadRecords()
      const current = records.get(key)
      const next = await mutate(current)
      if (next === undefined) return current
      records.set(key, parseStoredRecord(key, jsonClone(next)))
      await this.saveRecords(records)
      this.notifyRecordUpdated(key)
      return records.get(key)
    })
  }

  async deleteRecord(key: CredentialKey): Promise<void> {
    await this.withRecordLock(async () => {
      const records = await this.loadRecords()
      if (!records.delete(key)) return
      await this.saveRecords(records)
      this.notifyRecordUpdated(key)
    })
  }

  private withRecordLock<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.recordLock.then(operation, operation)
    this.recordLock = current.then(() => undefined, () => undefined)
    return current
  }

  private async loadRecords(): Promise<Map<CredentialKey, CredentialRecord>> {
    const raw = await this.ctx.desktopSecrets.get(RECORD_STORE_KEY)
    if (raw === undefined) return new Map()
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (cause) {
      throw new Error('desktop credentials: record store is not JSON', { cause })
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('desktop credentials: record store must be a mapping')
    }
    const records = new Map<CredentialKey, CredentialRecord>()
    for (const [encoded, record] of Object.entries(value as Record<string, unknown>)) {
      records.set(parseCredentialKey(encoded), parseStoredRecord(encoded, record))
    }
    return records
  }

  private async saveRecords(records: Map<CredentialKey, CredentialRecord>): Promise<void> {
    if (records.size === 0) {
      await this.ctx.desktopSecrets.delete(RECORD_STORE_KEY)
      return
    }
    await this.ctx.desktopSecrets.set(
      RECORD_STORE_KEY,
      JSON.stringify(Object.fromEntries(records)),
    )
  }
}

/** Cordis plugin entry for the desktop credential provider. */
export function apply(ctx: Context): void {
  new DesktopCredentialProvider(ctx)
}

/** Stable same-process classification for a failed or invalid SDK token-store operation. */
export class DesktopTokenStoreError extends Error {
  override name = 'DesktopTokenStoreError'
}

/** SDK TokenStore whose serialized tokens never enter renderer or plaintext disk. */
export class DesktopSdkTokenStore implements TokenStore {
  private lock: Promise<void> = Promise.resolve()
  /** @param bridge - main-process vault client. @param key - channel-specific token key. */
  constructor(
    private readonly bridge: DesktopSecretBridge,
    private readonly key: string,
  ) {}

  async load(): Promise<TokenSet | null> {
    let raw: string | undefined
    try {
      raw = await this.bridge.get(this.key)
    } catch (cause) {
      throw new DesktopTokenStoreError('Acosmi token store could not read secure storage', { cause })
    }
    if (raw === undefined) return null
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (cause) {
      throw new DesktopTokenStoreError('Acosmi token store contains invalid JSON', { cause })
    }
    if (!isValidTokenSet(value)) throw new DesktopTokenStoreError('Acosmi token store contains invalid fields')
    return value
  }

  async save(tokens: TokenSet): Promise<void> {
    if (!isValidTokenSet(tokens)) {
      throw new DesktopTokenStoreError('Acosmi token store rejected invalid token fields')
    }
    try {
      await this.bridge.set(this.key, JSON.stringify(tokens))
    } catch (cause) {
      throw new DesktopTokenStoreError('Acosmi token store could not write secure storage', { cause })
    }
  }

  async clear(): Promise<void> {
    try {
      await this.bridge.delete(this.key)
    } catch (cause) {
      throw new DesktopTokenStoreError('Acosmi token store could not clear secure storage', { cause })
    }
  }

  withLock<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.lock.then(operation, operation)
    this.lock = current.then(() => undefined, () => undefined)
    return current
  }
}

function referenceVaultKey(ref: CredentialRef): string {
  return `credential:${ref}`
}

function jsonClone(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (cause) {
    throw new TypeError('desktop credentials: record is not JSON-serializable', { cause })
  }
}

/** Admit one vault-backed record; unknown tags and fields fail rather than drop. */
function parseStoredRecord(key: string, value: unknown): CredentialRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`desktop credentials: record "${key}" must be a mapping`)
  }
  const fields = value as Record<string, unknown>
  if (fields.kind === 'api-key') {
    assertStoredFields(key, fields, ['kind', 'key', 'env'])
    const apiKey = fields.key
    if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length === 0)) {
      throw new TypeError(`desktop credentials: record "${key}" has a non-string or empty key`)
    }
    const env = parseStoredEnv(key, fields.env)
    return {
      kind: 'api-key',
      ...(apiKey === undefined ? {} : { key: apiKey }),
      ...(env === undefined ? {} : { env }),
    }
  }
  if (fields.kind === 'grant') {
    assertStoredFields(key, fields, ['kind', 'payload'])
    if (!('payload' in fields)) {
      throw new Error(`desktop credentials: record "${key}" has no payload`)
    }
    return { kind: 'grant', payload: jsonClone(fields.payload) }
  }
  if (fields.kind === undefined) throw new Error(`desktop credentials: record "${key}" has no kind`)
  throw new Error(`desktop credentials: record "${key}" has unknown kind ${JSON.stringify(fields.kind)}`)
}

function assertStoredFields(key: string, fields: Record<string, unknown>, allowed: readonly string[]): void {
  for (const field of Object.keys(fields)) {
    if (!allowed.includes(field)) {
      throw new Error(`desktop credentials: record "${key}" has unknown field "${field}"`)
    }
  }
}

function parseStoredEnv(key: string, env: unknown): Record<string, string> | undefined {
  if (env === undefined) return undefined
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    throw new TypeError(`desktop credentials: record "${key}" has a non-mapping env`)
  }
  const parsed: Record<string, string> = {}
  for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
    credentialRef(name)
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`desktop credentials: record "${key}" env "${name}" must be a non-empty string`)
    }
    parsed[name] = value
  }
  return parsed
}
