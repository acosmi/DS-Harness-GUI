/** Host credential provider and SDK TokenStore over the main-process vault bridge. */

import { isValidTokenSet, type TokenSet, type TokenStore } from '@acosmi/sdk-ts'
import { type Context } from '@deepseek-ai/cordis'
import { CredentialProvider, type CredentialInfo, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
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

/** Credentials provider that preserves inherited environment precedence. */
export class DesktopCredentialProvider extends CredentialProvider {
  static inject = ['desktopSecrets']

  /** @param ctx - Host context with the vault bridge. */
  constructor(ctx: Context) {
    super(ctx)
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const inherited = await this.ctx.desktopSecrets.getEnvironmentCredential(ref)
    if (inherited !== undefined) return { value: inherited, source: 'environment' }
    const value = await this.ctx.desktopSecrets.get(credentialKey(ref))
    return value === undefined ? undefined : { value, source: this.ctx.desktopSecrets.persistence }
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (await this.ctx.desktopSecrets.hasEnvironmentCredential(ref)) {
      return { configured: true, source: 'environment', writable: false }
    }
    const configured = await this.ctx.desktopSecrets.get(credentialKey(ref)) !== undefined
    return { configured, ...(configured ? { source: this.ctx.desktopSecrets.persistence } : {}), writable: true }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    if (await this.ctx.desktopSecrets.hasEnvironmentCredential(ref)) {
      throw new Error(`credential ${ref} is supplied by the environment and is read-only`)
    }
    if (value.length === 0) throw new Error('desktop credentials refuse an empty value; unset it instead')
    await this.ctx.desktopSecrets.set(credentialKey(ref), value)
    this.notifyUpdated(ref)
  }

  async unset(ref: CredentialRef): Promise<void> {
    if (await this.ctx.desktopSecrets.hasEnvironmentCredential(ref)) {
      throw new Error(`credential ${ref} is supplied by the environment and is read-only`)
    }
    await this.ctx.desktopSecrets.delete(credentialKey(ref))
    this.notifyUpdated(ref)
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

function credentialKey(ref: CredentialRef): string {
  return `credential:${ref}`
}
