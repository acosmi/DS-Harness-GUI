import { createRequire } from 'node:module'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

interface RuntimeClosureModule {
  assertAsarRuntimeClosure: (
    asar: {
      listPackage: (archivePath: string, options: { isPack: boolean }) => string[]
      extractFile: (archivePath: string, filename: string) => Buffer
    },
    archivePath: string,
    target: string,
  ) => { entries: number; packages: number }
  assertFilesystemRuntimeClosure: (staging: string) => number
  ignoredBuildsFromPnpmOutput: (output: string) => unknown[]
  assertReviewedIgnoredBuilds: (ignoredBuilds: unknown, expected: string) => void
  assertSafeStagingPath: (repositoryRoot: string, staging: string) => void
  materializeStagedLinks: (staging: string) => Promise<void>
  normalizeStagedManifestDependencies: (staging: string) => number
  prepareTargetRuntime: (staging: string, target: string) => void
  withPreservedFile: <T>(filePath: string, operation: () => Promise<T>) => Promise<T>
}

const require = createRequire(import.meta.url)
const closure = require('../scripts/runtime-closure.cjs') as RuntimeClosureModule
const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-runtime-closure-'))
  fixtures.push(root)
  return root
}

function writeManifest(root: string, relativePath: string, value: Record<string, unknown>): void {
  const destination = join(root, relativePath)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, `${JSON.stringify(value)}\n`)
}

describe('desktop package runtime closure', () => {
  it('restricts cleared staging directories to owned temporary paths', () => {
    const root = fixtureRoot()
    expect(() => closure.assertSafeStagingPath(root, join(root, 'dsh-gui-desktop-staging-stable-darwin-arm64-test')))
      .not.toThrow()
    expect(() => closure.assertSafeStagingPath(root, join(root, 'desktop-staging')))
      .toThrow(/unowned/)
    expect(() => closure.assertSafeStagingPath(root, root)).toThrow(/unowned/)
  })

  it('rejects a missing staged dependency reached through a workspace peer', () => {
    const root = fixtureRoot()
    writeManifest(root, 'package.json', { dependencies: { first: '1.0.0' } })
    writeManifest(root, 'node_modules/first/package.json', {
      dependencies: { second: '1.0.0' },
      peerDependencies: { electron: '43.4.0', peer: '1.0.0' },
    })
    writeManifest(root, 'node_modules/second/package.json', {})

    expect(() => closure.assertFilesystemRuntimeClosure(root)).toThrow(/first -> peer/)
    writeManifest(root, 'node_modules/peer/package.json', {})
    expect(closure.assertFilesystemRuntimeClosure(root)).toBe(4)
  })

  it('replaces deploy-only workspace links with staged package versions', () => {
    const root = fixtureRoot()
    writeManifest(root, 'package.json', { dependencies: { first: 'workspace:^' } })
    const sourceManifest = join(root, 'source-package.json')
    linkSync(join(root, 'package.json'), sourceManifest)
    writeManifest(root, 'node_modules/first/package.json', {
      version: '1.2.3',
      optionalDependencies: { absent: 'workspace:^' },
      peerDependencies: { peer: 'link:../../peer' },
    })
    writeManifest(root, 'node_modules/peer/package.json', { version: '4.5.6' })

    expect(closure.normalizeStagedManifestDependencies(root)).toBe(2)
    expect(require(join(root, 'package.json')).dependencies.first).toBe('1.2.3')
    expect(require(join(root, 'node_modules/first/package.json')).peerDependencies.peer).toBe('4.5.6')
    expect(JSON.parse(readFileSync(sourceManifest, 'utf8')).dependencies.first).toBe('workspace:^')
  })

  it('materializes a package link without modifying its external target', async () => {
    const staging = fixtureRoot()
    const source = fixtureRoot()
    writeManifest(source, 'package.json', { name: 'linked-package', version: '1.0.0' })
    writeFileSync(join(source, 'sentinel.txt'), 'source remains intact\n')
    mkdirSync(join(staging, 'node_modules'), { recursive: true })
    symlinkSync(source, join(staging, 'node_modules/linked-package'), process.platform === 'win32' ? 'junction' : 'dir')

    await closure.materializeStagedLinks(staging)

    expect(readFileSync(join(staging, 'node_modules/linked-package/package.json'), 'utf8'))
      .toContain('linked-package')
    expect(readFileSync(join(source, 'sentinel.txt'), 'utf8')).toBe('source remains intact\n')
  })

  it('restores pnpm workspace state after deploy success or failure', async () => {
    const root = fixtureRoot()
    const state = join(root, '.pnpm-workspace-state-v1.json')
    writeFileSync(state, 'development state\n')
    const originalTime = new Date('2026-01-02T03:04:05.000Z')
    utimesSync(state, originalTime, originalTime)

    await expect(closure.withPreservedFile(state, async () => {
      writeFileSync(state, 'production deploy state\n')
      return 'deployed'
    })).resolves.toBe('deployed')
    expect(readFileSync(state, 'utf8')).toBe('development state\n')
    expect(statSync(state).mtimeMs).toBe(originalTime.getTime())

    await expect(closure.withPreservedFile(state, async () => {
      writeFileSync(state, 'failed deploy state\n')
      throw new Error('deploy failed')
    })).rejects.toThrow(/deploy failed/)
    expect(readFileSync(state, 'utf8')).toBe('development state\n')
    expect(statSync(state).mtimeMs).toBe(originalTime.getTime())

    rmSync(state)
    await closure.withPreservedFile(state, async () => writeFileSync(state, 'new deploy state\n'))
    expect(existsSync(state)).toBe(false)
  })

  it('permits only the reviewed workspace postinstall and prepares the target helper', () => {
    const root = fixtureRoot()
    const expected = '@deepseek-ai/dsh-subprocess-local@file:///workspace/packages/subprocess/subprocess-local'
    const helper = join(root, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')
    const foreignPrebuild = join(root, 'node_modules/node-pty/prebuilds/win32-x64/pty.node')
    mkdirSync(dirname(helper), { recursive: true })
    writeFileSync(helper, 'helper')
    mkdirSync(dirname(foreignPrebuild), { recursive: true })
    writeFileSync(foreignPrebuild, 'foreign')

    expect(() => closure.assertReviewedIgnoredBuilds([expected], expected)).not.toThrow()
    closure.prepareTargetRuntime(root, 'darwin-arm64')
    expect(statSync(helper).mode & 0o111).toBe(0o111)
    expect(existsSync(foreignPrebuild)).toBe(false)

    expect(() => closure.assertReviewedIgnoredBuilds(['unreviewed@1.0.0'], expected))
      .toThrow(/unreviewed ignored builds/)
  })

  it('audits the union of every pnpm ignored-script event', () => {
    const expected = '@deepseek-ai/dsh-subprocess-local@file:///workspace/packages/subprocess/subprocess-local'
    const output = [
      JSON.stringify({ name: 'pnpm:ignored-scripts', packageNames: [expected] }),
      JSON.stringify({ name: 'pnpm:ignored-scripts', packageNames: ['unreviewed@1.0.0'] }),
    ].join('\n')
    const ignored = closure.ignoredBuildsFromPnpmOutput(output)

    expect(ignored).toEqual([expected, 'unreviewed@1.0.0'])
    expect(() => closure.assertReviewedIgnoredBuilds(ignored, expected)).toThrow(/unreviewed ignored builds/)
    expect(() => closure.ignoredBuildsFromPnpmOutput('{}')).toThrow(/did not report/)
  })

  it('audits application files, dependency manifests, and target native binaries in ASAR', () => {
    const manifests = new Map<string, Record<string, unknown>>([
      ['package.json', { dependencies: { first: '1.0.0' } }],
      ['node_modules/first/package.json', { dependencies: { second: '1.0.0' } }],
    ])
    const entries = [
      '/dist/main.js',
      '/dist/preload.cjs',
      '/dist/renderer/assets.manifest.json',
      '/dist/renderer/index.html',
      '/dist/utility.js',
      '/package.json',
      '/node_modules/first/package.json',
      '/node_modules/@img/sharp-darwin-arm64/lib/sharp.node',
      '/node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node',
      '/node_modules/node-addon-require-builtin-darwin-arm64/prebuilt/addon.node',
      '/node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
      '/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
    ]
    const asar = {
      listPackage: () => entries,
      extractFile: (_archivePath: string, filename: string) => Buffer.from(JSON.stringify(manifests.get(filename))),
    }

    expect(() => closure.assertAsarRuntimeClosure(asar, 'fixture.asar', 'darwin-arm64'))
      .toThrow(/first -> second/)
    entries.push('/node_modules/second/package.json')
    manifests.set('node_modules/second/package.json', {})
    expect(closure.assertAsarRuntimeClosure(asar, 'fixture.asar', 'darwin-arm64').packages).toBe(3)

    entries.push('/node_modules/node-pty/prebuilds/win32-x64/pty.node')
    expect(() => closure.assertAsarRuntimeClosure(asar, 'fixture.asar', 'darwin-arm64'))
      .toThrow(/non-target node-pty prebuild/)
  })
})
