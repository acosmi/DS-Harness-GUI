import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyDesktopRelease } from '../src/verify.ts'

const sourceRoot = resolve(import.meta.dirname, '../../..')
const fixtures: string[] = []
const releaseFiles = [
  'downstream/upstream-baseline.json',
  'downstream/release/upstream-baseline.schema.json',
  'downstream/release/identity.json',
  'downstream/release/identity.schema.json',
  'downstream/release/support-matrix.json',
  'downstream/release/support-matrix.schema.json',
  'downstream/release/native-modules.json',
  'downstream/release/native-modules.schema.json',
  'downstream/release/external-inputs.json',
  'downstream/release/external-inputs.schema.json',
  'downstream/release/responsibilities.json',
  'downstream/release/responsibilities.schema.json',
  'downstream/packages/account-acosmi/package.json',
  'downstream/packages/desktop-secrets/package.json',
  'downstream/packages/llm-acosmi/package.json',
  'pnpm-lock.yaml',
] as const

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-release-'))
  fixtures.push(root)
  for (const path of releaseFiles) {
    const destination = resolve(root, path)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(resolve(sourceRoot, path), destination)
  }
  return root
}

function mutate(path: string, edit: (value: Record<string, unknown>) => void): void {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  edit(value)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

describe('desktop release verification', () => {
  it('validates the checked-in ledgers while preserving code-complete blockers', () => {
    const state = verifyDesktopRelease(sourceRoot)
    expect(state.baseline.releaseReadiness).toMatchObject({ stableBlocked: true })
  })

  it('rejects a schema-invalid ledger, an unknown responsibility owner, and blocker drift', () => {
    const schemaRoot = fixtureRoot()
    mutate(resolve(schemaRoot, 'downstream/release/support-matrix.json'), value => { delete value.runtime })
    expect(() => verifyDesktopRelease(schemaRoot)).toThrow(/support-matrix\.json does not satisfy/)

    const ownerRoot = fixtureRoot()
    mutate(resolve(ownerRoot, 'downstream/release/external-inputs.json'), value => {
      const inputs = value.inputs as Array<Record<string, unknown>>
      inputs[0]!.ownerRole = 'missing-owner'
    })
    expect(() => verifyDesktopRelease(ownerRoot)).toThrow(/unknown owner role/)

    const blockerRoot = fixtureRoot()
    mutate(resolve(blockerRoot, 'downstream/release/external-inputs.json'), value => {
      const inputs = value.inputs as Array<Record<string, unknown>>
      inputs.find(input => input.id === 'oauth-production-client-and-test-account')!.status = 'ready'
    })
    expect(() => verifyDesktopRelease(blockerRoot)).toThrow(/blockers do not match blocked release inputs/)
  })

  it('requires complete release rosters and binds every external input to its policy and owner', () => {
    const responsibilityRoot = fixtureRoot()
    mutate(resolve(responsibilityRoot, 'downstream/release/responsibilities.json'), value => {
      const roles = value.roles as Array<Record<string, unknown>>
      value.roles = roles.filter(role => role.id !== 'product')
    })
    expect(() => verifyDesktopRelease(responsibilityRoot)).toThrow(/responsibility role roster/)

    const externalInputRoot = fixtureRoot()
    mutate(resolve(externalInputRoot, 'downstream/release/external-inputs.json'), value => {
      const inputs = value.inputs as Array<Record<string, unknown>>
      value.inputs = inputs.filter(input => input.id !== 'apple-signing-and-notary')
    })
    expect(() => verifyDesktopRelease(externalInputRoot)).toThrow(/external input roster/)

    const supportRoot = fixtureRoot()
    mutate(resolve(supportRoot, 'downstream/release/support-matrix.json'), value => {
      const targets = value.targets as Array<Record<string, unknown>>
      value.targets = targets.filter(target => target.platform !== 'win32')
    })
    expect(() => verifyDesktopRelease(supportRoot)).toThrow(/support target roster/)

    const nativeRoot = fixtureRoot()
    mutate(resolve(nativeRoot, 'downstream/release/native-modules.json'), value => {
      const modules = value.modules as Array<Record<string, unknown>>
      value.modules = modules.filter(module => module.name !== 'koffi')
    })
    expect(() => verifyDesktopRelease(nativeRoot)).toThrow(/native module roster/)

    const nativeTargetsRoot = fixtureRoot()
    mutate(resolve(nativeTargetsRoot, 'downstream/release/native-modules.json'), value => {
      const modules = value.modules as Array<Record<string, unknown>>
      const koffi = modules.find(module => module.name === 'koffi')!
      koffi.targets = (koffi.targets as string[]).filter(target => target !== 'win32-x64')
    })
    expect(() => verifyDesktopRelease(nativeTargetsRoot)).toThrow(/koffi target roster/)

    const releasePolicyRoot = fixtureRoot()
    mutate(resolve(releasePolicyRoot, 'downstream/release/external-inputs.json'), value => {
      const inputs = value.inputs as Array<Record<string, unknown>>
      inputs.find(input => input.id === 'apple-signing-and-notary')!.releaseBlocking = false
    })
    mutate(resolve(releasePolicyRoot, 'downstream/upstream-baseline.json'), value => {
      const readiness = value.releaseReadiness as Record<string, unknown>
      const blockers = readiness.blockers as string[]
      readiness.blockers = blockers.filter(id => id !== 'apple-signing-and-notary')
    })
    expect(() => verifyDesktopRelease(releasePolicyRoot)).toThrow(/release-blocking policy/)

    const ownerRoot = fixtureRoot()
    mutate(resolve(ownerRoot, 'downstream/release/external-inputs.json'), value => {
      const inputs = value.inputs as Array<Record<string, unknown>>
      inputs.find(input => input.id === 'apple-signing-and-notary')!.ownerRole = 'product'
    })
    expect(() => verifyDesktopRelease(ownerRoot)).toThrow(/owner role/)
  })

  it('binds stable and canary to their canonical identities and distinct installer GUIDs', () => {
    const swappedRoot = fixtureRoot()
    mutate(resolve(swappedRoot, 'downstream/release/identity.json'), value => {
      const channels = value.channels as Record<string, unknown>
      const stable = channels.stable
      channels.stable = channels.canary
      channels.canary = stable
    })
    expect(() => verifyDesktopRelease(swappedRoot)).toThrow(/stable channel product name/)

    const installerRoot = fixtureRoot()
    mutate(resolve(installerRoot, 'downstream/release/identity.json'), value => {
      const channels = value.channels as Record<string, Record<string, Record<string, unknown>>>
      channels.canary.windows.installerGuid = channels.stable.windows.installerGuid
    })
    expect(() => verifyDesktopRelease(installerRoot)).toThrow(/canary Windows installer GUID/)

    const changedInstallerRoot = fixtureRoot()
    mutate(resolve(changedInstallerRoot, 'downstream/release/identity.json'), value => {
      const channels = value.channels as Record<string, Record<string, Record<string, unknown>>>
      channels.stable.windows.installerGuid = '11111111-1111-4111-8111-111111111111'
    })
    expect(() => verifyDesktopRelease(changedInstallerRoot)).toThrow(/stable Windows installer GUID/)
  })

  it('rejects an unrecorded lockfile change', () => {
    const root = fixtureRoot()
    writeFileSync(resolve(root, 'pnpm-lock.yaml'), '\n# changed\n', { flag: 'a' })
    expect(() => verifyDesktopRelease(root)).toThrow(/lockfile SHA-256/)
  })

  it('rejects SDK manifest and registry-integrity drift from the audited baseline', () => {
    const manifestRoot = fixtureRoot()
    mutate(resolve(manifestRoot, 'downstream/packages/account-acosmi/package.json'), value => {
      const dependencies = value.dependencies as Record<string, unknown>
      dependencies['@acosmi/sdk-ts'] = '2.16.0'
    })
    expect(() => verifyDesktopRelease(manifestRoot)).toThrow(/Acosmi SDK version/)

    const integrityRoot = fixtureRoot()
    mutate(resolve(integrityRoot, 'downstream/upstream-baseline.json'), value => {
      const sdk = value.acosmiSdk as Record<string, unknown>
      sdk.integrity = 'sha512-not-the-locked-package'
    })
    expect(() => verifyDesktopRelease(integrityRoot)).toThrow(/do not match the lockfile registry entry/)
  })

  it('fails closed before a signed build while release inputs remain blocked', () => {
    expect(() => verifyDesktopRelease(sourceRoot, { requireSignedReady: true }))
      .toThrow(/lacks TokenStore failure propagation/)
  })

  it('fails closed when the SDK loses OpenAI stream finish reasons', () => {
    const root = fixtureRoot()
    mutate(resolve(root, 'downstream/release/external-inputs.json'), value => {
      const inputs = value.inputs as Array<Record<string, unknown>>
      inputs.find(input => input.id === 'acosmi-sdk-token-store-failure-propagation')!.status = 'ready'
      inputs.find(input => input.id === 'acosmi-sdk-authenticated-account-subject')!.status = 'ready'
    })
    mutate(resolve(root, 'downstream/upstream-baseline.json'), value => {
      const sdk = value.acosmiSdk as Record<string, unknown>
      const tokenStore = sdk.tokenStoreFailurePropagation as Record<string, unknown>
      tokenStore.publishedPackageCapable = true
      const subject = sdk.authenticatedAccountSubject as Record<string, unknown>
      subject.publishedPackageCapable = true
      const blockers = (value.releaseReadiness as Record<string, unknown>).blockers as string[]
      value.releaseReadiness = {
        stableBlocked: true,
        blockers: blockers.filter(id => id !== 'acosmi-sdk-token-store-failure-propagation'
          && id !== 'acosmi-sdk-authenticated-account-subject'),
      }
    })
    expect(() => verifyDesktopRelease(root, { requireSignedReady: true }))
      .toThrow(/loses OpenAI stream finish reasons/)
  })

  it('binds SDK capability input status to the audited published-package facts', () => {
    const tokenStoreRoot = fixtureRoot()
    mutate(resolve(tokenStoreRoot, 'downstream/release/external-inputs.json'), value => {
      const inputs = value.inputs as Array<Record<string, unknown>>
      inputs.find(input => input.id === 'acosmi-sdk-token-store-failure-propagation')!.status = 'ready'
    })
    expect(() => verifyDesktopRelease(tokenStoreRoot)).toThrow(/SDK capability input.*status/)

    const finishReasonRoot = fixtureRoot()
    mutate(resolve(finishReasonRoot, 'downstream/release/external-inputs.json'), value => {
      const inputs = value.inputs as Array<Record<string, unknown>>
      inputs.find(input => input.id === 'acosmi-sdk-openai-finish-reason-preservation')!.status = 'ready'
    })
    expect(() => verifyDesktopRelease(finishReasonRoot)).toThrow(/SDK capability input.*status/)
  })

  it('rejects a stale local patch after the published SDK becomes state-capable', () => {
    const root = fixtureRoot()
    mutate(resolve(root, 'downstream/upstream-baseline.json'), value => {
      const sdk = value.acosmiSdk as Record<string, unknown>
      const oauth = sdk.oauthState as Record<string, unknown>
      oauth.patchPath = 'patches/stale.patch'
      oauth.patchSha256 = 'a'.repeat(64)
    })
    expect(() => verifyDesktopRelease(root)).toThrow(/must not retain a local OAuth patch/)
  })

  it('requires a frozen commit, compatibility evidence, and complete responsibility records', () => {
    const root = fixtureRoot()
    mutate(resolve(root, 'downstream/release/external-inputs.json'), value => {
      const inputs = value.inputs as Array<Record<string, unknown>>
      for (const input of inputs) {
        if (input.releaseBlocking === true) input.status = 'ready'
      }
    })
    mutate(resolve(root, 'downstream/upstream-baseline.json'), value => {
      const sdk = value.acosmiSdk as Record<string, unknown>
      const oauth = sdk.oauthState as Record<string, unknown>
      oauth.publishedPackageCapable = true
      const tokenStore = sdk.tokenStoreFailurePropagation as Record<string, unknown>
      tokenStore.publishedPackageCapable = true
      const subject = sdk.authenticatedAccountSubject as Record<string, unknown>
      subject.publishedPackageCapable = true
      const finishReason = sdk.openAiFinishReasonPreservation as Record<string, unknown>
      finishReason.publishedPackageCapable = true
      value.releaseReadiness = { stableBlocked: false, blockers: [] }
    })
    expect(() => verifyDesktopRelease(root, { requireSignedReady: true }))
      .toThrow(/frozen product commit/)

    mutate(resolve(root, 'downstream/upstream-baseline.json'), value => {
      value.productCommit = 'a'.repeat(40)
    })
    expect(() => verifyDesktopRelease(root, { requireSignedReady: true }))
      .toThrow(/compatibility evidence/)

    mutate(resolve(root, 'downstream/upstream-baseline.json'), value => {
      value.compatibility = {
        status: 'passed',
        verifiedAt: '2026-08-15T12:00:00.000Z',
        evidence: ['frozen-candidate-matrix'],
      }
    })
    expect(() => verifyDesktopRelease(root, { requireSignedReady: true }))
      .toThrow(/legal entity/)

    mutate(resolve(root, 'downstream/release/identity.json'), value => {
      const publisher = value.publisher as Record<string, unknown>
      publisher.legalEntity = 'Acosmi release entity'
    })
    expect(() => verifyDesktopRelease(root, { requireSignedReady: true }))
      .toThrow(/complete responsibility record/)

    mutate(resolve(root, 'downstream/release/responsibilities.json'), value => {
      const roles = value.roles as Array<Record<string, unknown>>
      for (const role of roles) {
        role.owner = `owner-${String(role.id)}`
        role.backup = `backup-${String(role.id)}`
        role.evidence = `audit/${String(role.id)}.md`
        role.due = '2026-08-15'
      }
    })
    expect(() => verifyDesktopRelease(root, { requireSignedReady: true })).not.toThrow()

    mutate(resolve(root, 'downstream/release/responsibilities.json'), value => {
      const roles = value.roles as Array<Record<string, unknown>>
      roles[0]!.backup = roles[0]!.owner
    })
    expect(() => verifyDesktopRelease(root, { requireSignedReady: true }))
      .toThrow(/distinct backup/)

    mutate(resolve(root, 'downstream/release/responsibilities.json'), value => {
      const roles = value.roles as Array<Record<string, unknown>>
      roles[0]!.owner = '   '
      roles[0]!.backup = 'different-person'
    })
    expect(() => verifyDesktopRelease(root, { requireSignedReady: true }))
      .toThrow(/complete responsibility record/)
  })
})
