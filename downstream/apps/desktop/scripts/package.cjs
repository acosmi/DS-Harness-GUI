const { spawn } = require('node:child_process')
const fsp = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const identity = require('../../../release/identity.json')
const appManifest = require('../package.json')
const {
  assertFilesystemRuntimeClosure,
  assertNoDeployLifecycleScripts,
  assertSafeStagingPath,
  assertUtilityImports,
  materializeStagedLinks,
  normalizeStagedManifestDependencies,
  prepareTargetRuntime,
  withPreservedFile,
} = require('./runtime-closure.cjs')
const {
  desktopChannel,
  desktopMacNotarizationCredentials,
  desktopReleaseMode,
  desktopTrustedSigning,
} = require('./build-environment.cjs')
const {
  finalizeMacArtifacts,
  macArtifactPaths,
  removeMacArtifactResidue,
} = require('./mac-artifacts.cjs')

const APP_PACKAGE = '@acosmi/dsh-desktop-app'
const repositoryRoot = path.resolve(__dirname, '../../../..')
const appRoot = path.resolve(__dirname, '..')
const configPath = path.join(appRoot, 'electron-builder.config.cjs')
const workspaceStatePath = path.join(repositoryRoot, 'node_modules', '.pnpm-workspace-state-v1.json')
const electronBuilderCli = require.resolve('electron-builder/cli.js')
const MAX_CAPTURED_OUTPUT_BYTES = 8 * 1024 * 1024
const targetDefinitions = {
  'darwin-arm64': { os: 'darwin', cpu: 'arm64', builder: ['--mac', '--arm64'] },
  'darwin-x64': { os: 'darwin', cpu: 'x64', builder: ['--mac', '--x64'] },
  'win32-x64': { os: 'win32', cpu: 'x64', builder: ['--win', '--x64'] },
}

function hostTarget() {
  const target = `${process.platform}-${process.arch}`
  if (targetDefinitions[target] === undefined) {
    throw new Error(`Unsupported desktop packaging host ${target}`)
  }
  return target
}

function parseCli(argv) {
  let targetValue
  let directoryOnly = false
  for (const argument of argv) {
    if (argument === '--dir') directoryOnly = true
    else if (argument.startsWith('--target=')) targetValue = argument.slice('--target='.length)
    else throw new Error(`Unknown desktop packaging argument ${JSON.stringify(argument)}`)
  }
  const targets = (targetValue ?? 'host').split(',').map(value => value.trim()).filter(Boolean)
    .map(value => value === 'host' ? hostTarget() : value)
  if (targets.length === 0) throw new Error('Desktop packaging target list is empty')
  if (new Set(targets).size !== targets.length) throw new Error('Desktop packaging targets must be unique')
  for (const target of targets) {
    if (targetDefinitions[target] === undefined) throw new Error(`Unsupported desktop packaging target ${target}`)
  }
  return { directoryOnly, targets }
}

function commandName(name) {
  return process.platform === 'win32' && name === 'pnpm' ? 'pnpm.cmd' : name
}

function run(label, command, args, options = {}) {
  console.log(`dsh-gui package: ${label}`)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: options.capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, CI: 'true' },
    })
    const stdoutChunks = []
    const stderrChunks = []
    let capturedBytes = 0
    let captureError
    if (options.capture) {
      const append = target => chunk => {
        if (captureError !== undefined) return
        const copy = Buffer.from(chunk)
        capturedBytes += copy.byteLength
        if (capturedBytes > MAX_CAPTURED_OUTPUT_BYTES) {
          captureError = new Error(`dsh-gui package: ${label} exceeded the captured-output limit`)
          child.kill('SIGTERM')
          return
        }
        target.push(copy)
      }
      child.stdout.on('data', append(stdoutChunks))
      child.stderr.on('data', append(stderrChunks))
    }
    child.once('error', error => reject(new Error(`dsh-gui package: ${label} failed to spawn: ${error.message}`)))
    child.once('exit', (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      const captured = [stdout, stderr].filter(value => value.length > 0).join('\n')
      if (captureError !== undefined) reject(captureError)
      else if (code === 0) resolve(captured)
      else {
        const detail = captured.trim().split('\n').slice(-20).join('\n')
        reject(new Error(
          `dsh-gui package: ${label} failed (${code === null ? `signal ${signal}` : `exit ${code}`})${
            detail === '' ? '' : `\n${detail}`
          }`,
        ))
      }
    })
  })
}

async function stage(target, staging) {
  const definition = targetDefinitions[target]
  assertSafeStagingPath(tmpdir(), staging)
  const deployOutput = await withPreservedFile(workspaceStatePath, () => run(`deploy ${target}`, commandName('pnpm'), [
    '--reporter=ndjson',
    '--filter',
    APP_PACKAGE,
    'deploy',
    '--prod',
    '--ignore-scripts',
    '--config.inject-workspace-packages=true',
    '--config.node-linker=hoisted',
    '--config.link-workspace-packages=true',
    '--config.strict-dep-builds=false',
    `--os=${definition.os}`,
    `--cpu=${definition.cpu}`,
    staging,
  ], { capture: true }))
  assertNoDeployLifecycleScripts(deployOutput)
  console.log('dsh-gui package: dependency lifecycle scripts remained disabled during deploy')
  await materializeStagedLinks(staging)
  prepareTargetRuntime(staging, target)
  const normalizedManifests = normalizeStagedManifestDependencies(staging)
  const packageCount = assertFilesystemRuntimeClosure(staging)
  assertUtilityImports(staging)
  console.log(
    `dsh-gui package: ${target} staging contains ${packageCount} resolved package manifests; normalized ${normalizedManifests}`,
  )
  return staging
}

async function main() {
  const cli = parseCli(process.argv.slice(2))
  const releaseMode = desktopReleaseMode()
  const trustedSigning = desktopTrustedSigning(releaseMode)
  const channel = desktopChannel()
  const macArtifacts = new Map()
  if (!cli.directoryOnly) {
    for (const target of cli.targets) {
      if (targetDefinitions[target].os !== 'darwin') continue
      const artifacts = macArtifactPaths(
        path.join(repositoryRoot, '.artifacts', 'desktop', channel),
        identity.channels[channel].productName,
        appManifest.version,
        targetDefinitions[target].cpu,
      )
      macArtifacts.set(target, artifacts)
      const removed = removeMacArtifactResidue(artifacts)
      if (removed.length > 0) {
        console.log(`dsh-gui package: removed ${removed.length} old ${target} artifact files`)
      }
    }
  }
  if (trustedSigning && cli.targets.some(target => targetDefinitions[target].os === 'darwin')
    && desktopMacNotarizationCredentials() === null) {
    throw new Error('trusted macOS packaging requires complete Apple notarization credentials')
  }
  for (const target of cli.targets) {
    const staging = await fsp.mkdtemp(path.join(tmpdir(), `dsh-gui-desktop-staging-${channel}-${target}-`))
    try {
      await stage(target, staging)
      const builderArgs = [
        electronBuilderCli,
        '--projectDir',
        staging,
        '--config',
        configPath,
        '--publish',
        'never',
        ...targetDefinitions[target].builder,
      ]
      if (cli.directoryOnly) builderArgs.push('--dir')
      await run(`electron-builder ${target}`, process.execPath, builderArgs)
      if (!cli.directoryOnly && trustedSigning && targetDefinitions[target].os === 'darwin') {
        const arch = targetDefinitions[target].cpu
        const artifacts = macArtifacts.get(target)
        if (artifacts === undefined) throw new Error(`missing macOS artifact paths for ${target}`)
        const result = await finalizeMacArtifacts({
          channel,
          dmgPath: artifacts.dmgPath,
          expectedArchitecture: arch === 'arm64' ? 'arm64' : 'x86_64',
          zipPath: artifacts.zipPath,
        })
        console.log(`dsh-gui package: ${target} DMG notarization ${result.submissionId}`)
        console.log(`dsh-gui package: ${target} DMG SHA-256 ${result.dmgSha256}`)
        console.log(`dsh-gui package: ${target} ZIP SHA-256 ${result.zipSha256}`)
      }
    } finally {
      assertSafeStagingPath(tmpdir(), staging)
      await fsp.rm(staging, { recursive: true, force: true })
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
