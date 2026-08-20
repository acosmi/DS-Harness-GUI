import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  DesktopCredentialProvider,
  DesktopSdkTokenStore,
  DesktopTokenStoreError,
  type DesktopSecretBridge,
} from '../src/index.ts'
import {
  MAX_DESKTOP_SECRET_VALUE_BYTES,
  ProtectedSecretVault,
  SessionSecretVault,
  loadOrCreateVaultProfileId,
  type SafeStorageAdapter,
  type VaultBinding,
} from '../src/vault.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function vaultFixture(available = true): Promise<{
  filename: string
  storage: SafeStorageAdapter
  vault: ProtectedSecretVault
  binding: VaultBinding
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-gui-vault-'))
  temporaryDirectories.push(directory)
  const storage: SafeStorageAdapter = {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from(`protected:${value}`, 'utf8'),
    decryptString: value => {
      const text = value.toString('utf8')
      if (!text.startsWith('protected:')) throw new Error('wrong OS user')
      return text.slice('protected:'.length)
    },
  }
  const filename = join(directory, 'secrets.v2.json')
  const binding: VaultBinding = {
    productId: 'com.acosmi.dsharness.gui',
    channel: 'stable',
    issuer: 'https://acosmi.com',
    profileId: '61137610-258c-4dfa-9f96-135d4589b73d',
  }
  return { filename, storage, binding, vault: new ProtectedSecretVault(filename, storage, binding) }
}

describe('ProtectedSecretVault', () => {
  it('serializes concurrent changes into a deterministic encrypted envelope', async () => {
    const { filename, storage, vault, binding } = await vaultFixture()
    await Promise.all([
      vault.set('credential:SECOND', 'two'),
      vault.set('credential:FIRST', 'one'),
      vault.delete('absent:key'),
    ])
    expect(await vault.get('credential:FIRST')).toBe('one')
    expect(await vault.get('credential:SECOND')).toBe('two')
    expect(await readFile(filename, 'utf8')).not.toContain('one')
    expect(await readFile(filename, 'utf8')).not.toContain('two')

    const reopened = new ProtectedSecretVault(filename, storage, binding)
    expect(await reopened.get('credential:FIRST')).toBe('one')
    expect(await reopened.get('credential:SECOND')).toBe('two')

    await vault.delete('credential:FIRST')
    expect(await vault.get('credential:FIRST')).toBeUndefined()
  })

  it('fails closed when encryption, envelope, ciphertext, or secret fields are invalid', async () => {
    const unavailable = await vaultFixture(false)
    await expect(unavailable.vault.get('health:probe')).rejects.toThrow(/encryption is unavailable/)
    await expect(unavailable.vault.set('valid:key', 'value')).rejects.toThrow(/encryption is unavailable/)

    const encrypted = await vaultFixture()
    await encrypted.vault.set('valid:key', 'value')
    const unavailableReader = new ProtectedSecretVault(encrypted.filename, {
      ...encrypted.storage,
      isEncryptionAvailable: () => false,
    }, encrypted.binding)
    await expect(unavailableReader.get('valid:key')).rejects.toThrow(/encryption is unavailable/)

    const fixture = await vaultFixture()
    await fixture.vault.set('valid:key', 'value')
    const validEnvelope = JSON.parse(await readFile(fixture.filename, 'utf8')) as Record<string, unknown>
    await writeFile(fixture.filename, 'not-json')
    await expect(fixture.vault.get('health:probe')).rejects.toThrow(/envelope is not JSON/)
    await writeFile(fixture.filename, '{"version":2,"bindingSha256":"bad","ciphertext":"eA=="}\n')
    await expect(fixture.vault.get('health:probe')).rejects.toThrow(/unsupported encrypted envelope/)
    await writeFile(fixture.filename, `${JSON.stringify({ ...validEnvelope, ciphertext: 'eA==' })}\n`)
    await expect(fixture.vault.get('health:probe')).rejects.toThrow(/cannot be decrypted/)
    const invalidPayload = {
      version: 2,
      binding: fixture.binding,
      secrets: { 'bad key': 'value' },
    }
    await writeFile(fixture.filename, `${JSON.stringify({
      ...validEnvelope,
      ciphertext: Buffer.from(`protected:${JSON.stringify(invalidPayload)}`).toString('base64'),
    })}\n`)
    await expect(fixture.vault.get('health:probe')).rejects.toThrow(/not a secret map/)
    await expect(fixture.vault.set('bad key', 'value')).rejects.toThrow(/invalid secret key/)
    await expect(fixture.vault.set('valid:key', '')).rejects.toThrow(/empty secret/)
  })

  it('keeps fallback secrets in process memory without OS encryption', async () => {
    const vault = new SessionSecretVault()
    expect(vault.persistence).toBe('session-memory')
    await vault.set('sdk:token', 'value')
    expect(await vault.get('sdk:token')).toBe('value')
    await vault.delete('sdk:token')
    expect(await vault.get('sdk:token')).toBeUndefined()
    await expect(vault.set('bad key', 'value')).rejects.toThrow(/invalid secret key/)
    await expect(vault.set('valid:key', '')).rejects.toThrow(/empty secret/)
  })

  it('bounds profile files, encrypted envelopes, values, entry counts, and total memory', async () => {
    const profileDirectory = await mkdtemp(join(tmpdir(), 'dsh-gui-profile-limit-'))
    temporaryDirectories.push(profileDirectory)
    const profileFilename = join(profileDirectory, 'profile.v1.json')
    await writeFile(profileFilename, 'x')
    await truncate(profileFilename, 4_097)
    await expect(loadOrCreateVaultProfileId(profileFilename)).rejects.toThrow(/profile record exceeds/)

    const fixture = await vaultFixture()
    await writeFile(fixture.filename, 'x')
    await truncate(fixture.filename, (8 * 1_024 * 1_024) + 1)
    await expect(fixture.vault.get('health:probe')).rejects.toThrow(/encrypted envelope exceeds/)
    await expect(fixture.vault.set(
      'credential:TOO_LARGE',
      'é'.repeat((MAX_DESKTOP_SECRET_VALUE_BYTES / 2) + 1),
    )).rejects.toThrow(/value exceeds/)

    const entryLimited = new SessionSecretVault()
    for (let index = 0; index < 256; index += 1) await entryLimited.set(`credential:${index}`, 'value')
    await expect(entryLimited.set('credential:overflow', 'value')).rejects.toThrow(/entry limit/)

    const memoryLimited = new SessionSecretVault()
    const chunk = 'x'.repeat((256 * 1_024) - 16)
    for (let index = 0; index < 16; index += 1) await memoryLimited.set(`credential:${index}`, chunk)
    await expect(memoryLimited.set('credential:overflow', chunk)).rejects.toThrow(/storage limit/)
  })

  it('binds encrypted data to the product channel and local profile', async () => {
    const fixture = await vaultFixture()
    await fixture.vault.set('sdk:token', 'secret')
    const other = new ProtectedSecretVault(fixture.filename, fixture.storage, {
      ...fixture.binding,
      profileId: 'ca134116-241c-4d33-8758-45d448cddf8b',
    })
    await expect(other.get('sdk:token')).rejects.toThrow(/another product profile/)
    expect(() => new ProtectedSecretVault(fixture.filename, fixture.storage, {
      ...fixture.binding,
      channel: 'canary',
    })).toThrow(/product and channel/)
  })

  it('creates and validates an owner-local profile identifier', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-gui-profile-'))
    temporaryDirectories.push(directory)
    const filename = join(directory, 'profile.v1.json')
    const created = await loadOrCreateVaultProfileId(filename)
    expect(created).toMatch(/^[0-9a-f-]{36}$/u)
    expect(await loadOrCreateVaultProfileId(filename)).toBe(created)
    await writeFile(filename, '{"version":1,"id":"not-a-uuid"}\n')
    await expect(loadOrCreateVaultProfileId(filename)).rejects.toThrow(/profile record is invalid/)
  })
})

class MemoryBridge implements DesktopSecretBridge {
  readonly persistence = 'session-memory' as const
  readonly values = new Map<string, string>()
  readonly environment = new Map<string, string>()
  async getEnvironmentCredential(ref: string): Promise<string | undefined> { return this.environment.get(ref) }
  async hasEnvironmentCredential(ref: string): Promise<boolean> { return this.environment.has(ref) }
  async get(key: string): Promise<string | undefined> { return this.values.get(key) }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value) }
  async delete(key: string): Promise<void> { this.values.delete(key) }
}

describe('desktop credential and SDK token providers', () => {
  it('keeps credentials in the bridge and respects read-only environment precedence', async () => {
    const context = new Context()
    const bridge = new MemoryBridge()
    context.provide('desktopSecrets', bridge)
    const provider = new DesktopCredentialProvider(context)
    const ref = credentialRef('DSH_GUI_TEST_SECRET')
    try {
      expect(await provider.describe(ref)).toEqual({ configured: false, writable: true })
      await provider.set(ref, 'vault-value')
      expect(await provider.resolve(ref)).toEqual({ value: 'vault-value', source: 'session-memory' })
      expect(await provider.describe(ref)).toEqual({ configured: true, source: 'session-memory', writable: true })
      bridge.environment.set(ref, 'environment-value')
      expect(await provider.resolve(ref)).toEqual({ value: 'environment-value', source: 'environment' })
      expect(await provider.describe(ref)).toEqual({ configured: true, source: 'environment', writable: false })
      await expect(provider.set(ref, 'other')).rejects.toThrow(/read-only/)
      await expect(provider.unset(ref)).rejects.toThrow(/read-only/)
      bridge.environment.delete(ref)
      await provider.unset(ref)
      expect(await provider.resolve(ref)).toBeUndefined()
      await expect(provider.set(ref, '')).rejects.toThrow(/empty/)
    } finally {
      await context.fiber.dispose()
    }
  })

  it('validates token JSON and serializes SDK refresh locks', async () => {
    const bridge = new MemoryBridge()
    const store = new DesktopSdkTokenStore(bridge, 'sdk:token')
    const tokens = {
      access_token: 'access',
      refresh_token: 'refresh',
      expires_at: '2030-01-01T00:00:00.000Z',
      scope: 'ai',
      client_id: 'client',
      server_url: 'https://acosmi.com',
    }
    expect(await store.load()).toBeNull()
    await store.save(tokens)
    expect(await store.load()).toEqual(tokens)
    bridge.values.set('sdk:token', '{')
    await expect(store.load()).rejects.toThrow(/invalid JSON/)
    bridge.values.set('sdk:token', '{}')
    await expect(store.load()).rejects.toThrow(/invalid fields/)
    await expect(store.save({ ...tokens, access_token: 1 } as never)).rejects.toThrow(/invalid token fields/)

    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = store.withLock(async () => { order.push('first:start'); await gate; order.push('first:end') })
    const second = store.withLock(async () => { order.push('second') })
    await Promise.resolve()
    expect(order).toEqual(['first:start'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
    await store.clear()
    expect(await store.load()).toBeNull()
  })

  it('classifies a sanitized main-process bridge failure without exposing its details', async () => {
    const bridge = new MemoryBridge()
    vi.spyOn(bridge, 'get').mockRejectedValue(new Error('desktop main operation failed'))
    const store = new DesktopSdkTokenStore(bridge, 'sdk:token')
    const failure = await store.load().then(() => undefined, error => error)
    expect(failure).toBeInstanceOf(DesktopTokenStoreError)
    expect(failure).toMatchObject({ message: 'Acosmi token store could not read secure storage' })
  })
})
