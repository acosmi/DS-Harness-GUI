import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const identity = require('../../../release/identity.json') as {
  repository: string
  channels: { canary: { productName: string }; stable: { productName: string } }
}
const appManifest = require('../package.json') as { version: string }
const {
  expectedInstallerPaths,
  githubRepositorySlug,
  isPrereleaseVersion,
  publishDesktopInstallers,
  releaseNotes,
  releaseTagName,
} = require('../scripts/github-release.cjs') as {
  expectedInstallerPaths(options: {
    artifactRoot: string
    platform: 'darwin' | 'win32'
    productName: string
    version: string
  }): string[]
  githubRepositorySlug(repositoryUrl: string): string
  isPrereleaseVersion(version: string): boolean
  publishDesktopInstallers(options?: {
    argv?: string[]
    cwd?: string
    env?: NodeJS.ProcessEnv
    gh?: (
      args: string[],
      cwd: string,
      env: NodeJS.ProcessEnv,
    ) => { error?: Error; status: number | null; stderr: string; stdout: string }
    gitHead?: (cwd: string) => string
    gitStatus?: (cwd: string) => string
  }): Promise<{
    commit: string
    created: boolean
    dryRun: boolean
    files: string[]
    repo: string
    tag: string
  }>
  releaseNotes(options: {
    channel: 'stable' | 'canary'
    commit: string
    productName: string
    version: string
  }): string
  releaseTagName(channel: 'stable' | 'canary', version: string): string
}

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const directories: string[] = []

function stagingRoot(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'dsh-gui-github-release-'))
  directories.push(directory)
  return directory
}

function writeInstallers(root: string, platform: 'darwin' | 'win32', channel: 'stable' | 'canary' = 'stable'): string[] {
  const productName = identity.channels[channel].productName
  const files = expectedInstallerPaths({
    artifactRoot: path.join(root, '.artifacts', 'desktop', channel),
    platform,
    productName,
    version: appManifest.version,
  })
  for (const file of files) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${path.basename(file)}\n`)
  }
  return files
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop()
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
  }
})

describe('desktop GitHub Release identity', () => {
  it('parses the identity ledger URL and names channel tags', () => {
    expect(githubRepositorySlug(identity.repository)).toBe('acosmi/DS-Harness-GUI')
    expect(githubRepositorySlug('https://github.com/acosmi/DS-Harness-GUI.git')).toBe('acosmi/DS-Harness-GUI')
    expect(() => githubRepositorySlug('https://example.com/acosmi/DS-Harness-GUI'))
      .toThrow(/https:\/\/github.com\/owner\/name/)
    expect(releaseTagName('stable', '0.1.1-rc.2')).toBe('dsh-gui-v0.1.1-rc.2')
    expect(releaseTagName('canary', '0.1.1-rc.2')).toBe('dsh-gui-canary-v0.1.1-rc.2')
    expect(isPrereleaseVersion('0.1.1-rc.2')).toBe(true)
    expect(isPrereleaseVersion('1.0.0')).toBe(false)
  })

  it('requires both macOS architectures and the Windows NSIS installer', () => {
    expect(expectedInstallerPaths({
      artifactRoot: path.join('artifacts'),
      platform: 'darwin',
      productName: 'DSH-GUI',
      version: '0.1.1-rc.2',
    })).toEqual([
      path.join('artifacts', 'DSH-GUI-0.1.1-rc.2-arm64.dmg'),
      path.join('artifacts', 'DSH-GUI-0.1.1-rc.2-arm64.zip'),
      path.join('artifacts', 'DSH-GUI-0.1.1-rc.2-x64.dmg'),
      path.join('artifacts', 'DSH-GUI-0.1.1-rc.2-x64.zip'),
    ])
    expect(expectedInstallerPaths({
      artifactRoot: path.join('artifacts'),
      platform: 'win32',
      productName: 'DSH-GUI Canary',
      version: '0.1.1-rc.2',
    })).toEqual([
      path.join('artifacts', 'DSH-GUI Canary-Setup-0.1.1-rc.2-x64.exe'),
    ])
  })
})

describe('desktop GitHub Release upload', () => {
  it('creates a pre-release and uploads macOS installers from a clean local tree', async () => {
    const cwd = stagingRoot()
    const files = writeInstallers(cwd, 'darwin')
    const calls: string[][] = []
    const result = await publishDesktopInstallers({
      argv: ['--platform=darwin'],
      cwd,
      env: {},
      gitHead: () => COMMIT,
      gitStatus: () => '',
      gh(args) {
        calls.push(args)
        if (args[1] === 'view') {
          return { status: 1, stdout: '', stderr: 'release not found' }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
    })

    expect(result).toMatchObject({
      commit: COMMIT,
      created: true,
      dryRun: false,
      repo: 'acosmi/DS-Harness-GUI',
      tag: releaseTagName('stable', appManifest.version),
    })
    expect(result.files).toEqual(files)
    expect(calls[0]).toEqual([
      'release', 'view', result.tag, '--repo', 'acosmi/DS-Harness-GUI', '--json', 'tagName,targetCommitish',
    ])
    expect(calls[1]?.slice(0, 8)).toEqual([
      'release', 'create', result.tag, '--repo', 'acosmi/DS-Harness-GUI', '--target', COMMIT, '--title',
    ])
    expect(calls[1]).toContain('--prerelease')
    expect(calls[1]).toContain(releaseNotes({
      channel: 'stable',
      commit: COMMIT,
      productName: identity.channels.stable.productName,
      version: appManifest.version,
    }))
    expect(calls[2]).toEqual([
      'release', 'upload', result.tag, ...files, '--repo', 'acosmi/DS-Harness-GUI', '--clobber',
    ])
  })

  it('uploads Windows installers onto an existing release at the same commit', async () => {
    const cwd = stagingRoot()
    const files = writeInstallers(cwd, 'win32')
    const calls: string[][] = []
    const result = await publishDesktopInstallers({
      argv: ['--platform=win32'],
      cwd,
      env: { GITHUB_REPOSITORY: 'acosmi/DS-Harness-GUI', GITHUB_SHA: COMMIT },
      gitHead: () => COMMIT,
      gitStatus: () => '',
      gh(args) {
        calls.push(args)
        if (args[1] === 'view') {
          return {
            status: 0,
            stdout: JSON.stringify({ tagName: 'dsh-gui-v1', targetCommitish: 'main' }),
            stderr: '',
          }
        }
        if (args[0] === 'api') {
          return { status: 0, stdout: `${COMMIT}\n`, stderr: '' }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
    })

    expect(result.created).toBe(false)
    expect(calls.some(args => args[1] === 'create')).toBe(false)
    expect(calls.at(-1)).toEqual([
      'release', 'upload', result.tag, ...files, '--repo', 'acosmi/DS-Harness-GUI', '--clobber',
    ])
  })

  it('refuses a dirty worktree, a missing installer, a foreign repository, and a different release commit', async () => {
    const cwd = stagingRoot()
    writeInstallers(cwd, 'darwin')
    await expect(publishDesktopInstallers({
      argv: ['--platform=darwin'],
      cwd,
      env: {},
      gitHead: () => COMMIT,
      gitStatus: () => ' M downstream/apps/desktop/package.json\n',
      gh: () => ({ status: 0, stdout: '', stderr: '' }),
    })).rejects.toThrow(/clean worktree/)

    await expect(publishDesktopInstallers({
      argv: ['--platform=win32'],
      cwd,
      env: {},
      gitHead: () => COMMIT,
      gitStatus: () => '',
      gh: () => ({ status: 0, stdout: '', stderr: '' }),
    })).rejects.toThrow(/missing installer files/)

    await expect(publishDesktopInstallers({
      argv: ['--platform=darwin'],
      cwd,
      env: { GITHUB_REPOSITORY: 'someone/else' },
      gitHead: () => COMMIT,
      gitStatus: () => '',
      gh: () => ({ status: 0, stdout: '', stderr: '' }),
    })).rejects.toThrow(/someone\/else/)

    await expect(publishDesktopInstallers({
      argv: ['--platform=darwin'],
      cwd,
      env: {},
      gitHead: () => COMMIT,
      gitStatus: () => '',
      gh(args) {
        if (args[1] === 'view') {
          return {
            status: 0,
            stdout: JSON.stringify({ tagName: 'dsh-gui-v1', targetCommitish: COMMIT.replace(/7/g, '0') }),
            stderr: '',
          }
        }
        return { status: 0, stdout: 'ffffffffffffffffffffffffffffffffffffffff\n', stderr: '' }
      },
    })).rejects.toThrow(/targets/)
  })

  it('dry-runs macOS create without calling gh mutate verbs', async () => {
    const cwd = stagingRoot()
    writeInstallers(cwd, 'darwin')
    const calls: string[][] = []
    const result = await publishDesktopInstallers({
      argv: ['--platform=darwin', '--dry-run'],
      cwd,
      env: {},
      gitHead: () => COMMIT,
      gitStatus: () => '',
      gh(args) {
        calls.push(args)
        return { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' }
      },
    })
    expect(result.created).toBe(true)
    expect(result.dryRun).toBe(true)
    expect(calls.every(args => args[1] === 'view')).toBe(true)
  })
})
