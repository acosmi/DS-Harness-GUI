'use strict'

const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const identity = require('../../../release/identity.json')
const appManifest = require('../package.json')
const { desktopChannel } = require('./build-environment.cjs')

const repositoryRoot = path.resolve(__dirname, '../../../..')

/**
 * @param {string} name
 * @returns {string}
 */
function commandName(name) {
  return process.platform === 'win32' && name === 'gh' ? 'gh.exe' : name
}

/**
 * Parse the identity ledger's public GitHub URL into an owner/name slug.
 * @param {string} repositoryUrl - HTTPS GitHub repository URL.
 * @returns {string} `owner/name` slug.
 */
function githubRepositorySlug(repositoryUrl) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(repositoryUrl)
  if (match === null) {
    throw new Error(`desktop GitHub Release repository must be an https://github.com/owner/name URL, received ${JSON.stringify(repositoryUrl)}`)
  }
  return match[1]
}

/**
 * Name the GitHub Release tag for one channel and application version.
 * @param {'stable' | 'canary'} channel
 * @param {string} version
 * @returns {string}
 */
function releaseTagName(channel, version) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('desktop GitHub Release version is empty')
  }
  return channel === 'canary' ? `dsh-gui-canary-v${version}` : `dsh-gui-v${version}`
}

/** SemVer pre-release versions stay marked as GitHub pre-releases. */
function isPrereleaseVersion(version) {
  return version.includes('-')
}

/**
 * Resolve the exact installer files one platform must upload.
 * @param {{ artifactRoot: string; platform: 'darwin' | 'win32'; productName: string; version: string }} options
 * @returns {string[]}
 */
function expectedInstallerPaths(options) {
  if (options.platform === 'darwin') {
    return ['arm64', 'x64'].flatMap(arch => [
      path.join(options.artifactRoot, `${options.productName}-${options.version}-${arch}.dmg`),
      path.join(options.artifactRoot, `${options.productName}-${options.version}-${arch}.zip`),
    ])
  }
  if (options.platform === 'win32') {
    return [path.join(options.artifactRoot, `${options.productName}-Setup-${options.version}-x64.exe`)]
  }
  throw new Error(`unsupported desktop GitHub Release platform ${JSON.stringify(options.platform)}`)
}

function parseCli(argv) {
  let platform
  let dryRun = false
  for (const argument of argv) {
    if (argument === '--dry-run') dryRun = true
    else if (argument.startsWith('--platform=')) platform = argument.slice('--platform='.length)
    else throw new Error(`Unknown desktop GitHub Release argument ${JSON.stringify(argument)}`)
  }
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error('desktop GitHub Release requires --platform=darwin or --platform=win32')
  }
  return { dryRun, platform }
}

function assertGitWorktreeClean(status) {
  if (status.trim().length > 0) {
    throw new Error('desktop GitHub Release upload requires a clean worktree')
  }
}

function assertInstallerFiles(files) {
  const missing = files.filter(file => {
    try {
      return !fs.statSync(file).isFile()
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return true
      throw error
    }
  })
  if (missing.length > 0) {
    throw new Error(`desktop GitHub Release is missing installer files:\n${missing.join('\n')}`)
  }
}

function releaseNotes(options) {
  return [
    `${options.productName} ${options.version} (${options.channel}) installer distribution for commit ${options.commit}.`,
    '',
    'macOS arm64 and x64 installers are packaged on a local Mac and uploaded to this GitHub Release. The Windows x64 NSIS installer is packaged by the dispatch-only desktop-windows-package workflow on windows-latest.',
    '',
    'This GitHub Release does not mark stable promotion or close a release-ledger input.',
  ].join('\n')
}

function ghOutput(result) {
  return `${result.stderr}\n${result.stdout}`
}

function assertGhOk(result, label) {
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${ghOutput(result).trim()}`)
  }
}

function parseReleaseView(stdout) {
  let value
  try {
    value = JSON.parse(stdout)
  } catch (error) {
    throw new Error('gh release view returned malformed JSON', { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || typeof value.targetCommitish !== 'string' || value.targetCommitish.length === 0) {
    throw new Error('gh release view did not return a target commit')
  }
  return value.targetCommitish
}

function isReleaseAbsent(result) {
  if (result.error !== undefined) return false
  if (result.status === 0) return false
  return /not found|HTTP 404/i.test(ghOutput(result))
}

/**
 * Upload one platform's installers to the identity ledger's GitHub Release.
 * @param {{ argv?: string[]; cwd?: string; env?: NodeJS.ProcessEnv; gitHead?: (cwd: string) => string; gitStatus?: (cwd: string) => string; gh?: (args: string[], cwd: string, env: NodeJS.ProcessEnv) => { error?: Error; status: number | null; stderr: string; stdout: string } }} [options]
 * @returns {Promise<{ commit: string; created: boolean; dryRun: boolean; files: string[]; repo: string; tag: string }>}
 */
async function publishDesktopInstallers(options = {}) {
  const cwd = options.cwd ?? repositoryRoot
  const env = options.env ?? process.env
  const cli = parseCli(options.argv ?? process.argv.slice(2))
  const channel = desktopChannel(env)
  const repo = githubRepositorySlug(identity.repository)
  const runningRepo = env.GITHUB_REPOSITORY
  if (typeof runningRepo === 'string' && runningRepo.length > 0 && runningRepo !== repo) {
    throw new Error(`desktop GitHub Release refuses ${runningRepo}; identity ledger records ${repo}`)
  }
  const version = appManifest.version
  const productName = identity.channels[channel].productName
  const tag = releaseTagName(channel, version)
  const artifactRoot = path.join(cwd, '.artifacts', 'desktop', channel)
  const files = expectedInstallerPaths({
    artifactRoot,
    platform: cli.platform,
    productName,
    version,
  })
  const gitStatus = options.gitStatus ?? (directory => execFileSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: directory, encoding: 'utf8' },
  ))
  const gitHead = options.gitHead ?? (directory => execFileSync(
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: directory, encoding: 'utf8' },
  ).trim())
  const gh = options.gh ?? ((args, directory, environment) => {
    const result = spawnSync(commandName('gh'), args, {
      cwd: directory,
      encoding: 'utf8',
      env: environment,
    })
    return {
      error: result.error,
      status: result.status,
      stderr: result.stderr ?? '',
      stdout: result.stdout ?? '',
    }
  })
  assertGitWorktreeClean(gitStatus(cwd))
  const commit = typeof env.GITHUB_SHA === 'string' && env.GITHUB_SHA.length > 0
    ? env.GITHUB_SHA
    : gitHead(cwd)
  if (typeof env.GITHUB_SHA === 'string' && env.GITHUB_SHA.length > 0) {
    const head = gitHead(cwd)
    if (head !== env.GITHUB_SHA) {
      throw new Error(`desktop GitHub Release commit ${env.GITHUB_SHA} does not match HEAD ${head}`)
    }
  }
  assertInstallerFiles(files)
  const view = gh(
    ['release', 'view', tag, '--repo', repo, '--json', 'tagName,targetCommitish'],
    cwd,
    env,
  )
  let created = false
  if (isReleaseAbsent(view)) {
    const createArgs = [
      'release',
      'create',
      tag,
      '--repo',
      repo,
      '--target',
      commit,
      '--title',
      `${productName} ${version}`,
      '--notes',
      releaseNotes({ channel, commit, productName, version }),
    ]
    if (isPrereleaseVersion(version)) createArgs.push('--prerelease')
    if (cli.dryRun) {
      console.log(`dsh-gui github-release: dry-run create ${repo} ${tag} at ${commit}`)
    } else {
      assertGhOk(gh(createArgs, cwd, env), 'gh release create')
    }
    created = true
  } else {
    assertGhOk(view, 'gh release view')
    const target = parseReleaseView(view.stdout)
    let resolved = target
    if (target !== commit) {
      const resolvedCommit = gh(['api', `repos/${repo}/commits/${target}`, '--jq', '.sha'], cwd, env)
      assertGhOk(resolvedCommit, 'gh api commit')
      resolved = resolvedCommit.stdout.trim()
    }
    if (resolved !== commit) {
      throw new Error(`desktop GitHub Release ${tag} targets ${resolved}, not ${commit}`)
    }
  }
  if (cli.dryRun) {
    console.log(`dsh-gui github-release: dry-run upload ${files.length} ${cli.platform} files to ${repo} ${tag}`)
    return { commit, created, dryRun: true, files, repo, tag }
  }
  assertGhOk(
    gh(['release', 'upload', tag, ...files, '--repo', repo, '--clobber'], cwd, env),
    'gh release upload',
  )
  console.log(`dsh-gui github-release: uploaded ${files.length} ${cli.platform} files to ${repo} ${tag}`)
  return { commit, created, dryRun: false, files, repo, tag }
}

module.exports = {
  expectedInstallerPaths,
  githubRepositorySlug,
  isPrereleaseVersion,
  publishDesktopInstallers,
  releaseNotes,
  releaseTagName,
}

if (require.main === module) {
  publishDesktopInstallers().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
