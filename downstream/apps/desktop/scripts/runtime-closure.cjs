const childProcess = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const ELECTRON_PROVIDED_PACKAGES = new Set(['electron'])
const REQUIRED_APP_FILES = [
  '/dist/main.js',
  '/dist/preload.cjs',
  '/dist/renderer/assets.manifest.json',
  '/dist/renderer/index.html',
  '/dist/utility.js',
  '/package.json',
]

function packageSegments(name) {
  const segments = name.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Invalid dependency name ${JSON.stringify(name)}`)
  }
  return segments
}

function dependencySets(manifest) {
  const required = new Set(Object.keys(manifest.dependencies ?? {}))
  const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}))
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    if (manifest.peerDependenciesMeta?.[name]?.optional === true) optional.add(name)
    else required.add(name)
  }
  return { required: [...required].sort(), optional: [...optional].sort() }
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

function resolveFilesystemManifest(root, fromManifest, dependency) {
  let directory = path.dirname(fromManifest)
  const segments = packageSegments(dependency)
  while (isWithin(root, directory)) {
    const candidate = path.join(directory, 'node_modules', ...segments, 'package.json')
    if (fs.existsSync(candidate)) return candidate
    if (directory === root) break
    directory = path.dirname(directory)
  }
  return undefined
}

function assertFilesystemRuntimeClosure(staging) {
  const root = path.resolve(staging)
  const rootManifest = path.join(root, 'package.json')
  const queue = [{ manifestPath: rootManifest, chain: ['desktop app'] }]
  const visited = new Set()

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    if (visited.has(current.manifestPath)) continue
    visited.add(current.manifestPath)
    const manifest = JSON.parse(fs.readFileSync(current.manifestPath, 'utf8'))
    const { required, optional } = dependencySets(manifest)
    for (const dependency of required) {
      if (ELECTRON_PROVIDED_PACKAGES.has(dependency)) continue
      const manifestPath = resolveFilesystemManifest(root, current.manifestPath, dependency)
      if (manifestPath === undefined) {
        throw new Error(`Staged runtime dependency is missing: ${[...current.chain, dependency].join(' -> ')}`)
      }
      queue.push({ manifestPath, chain: [...current.chain, dependency] })
    }
    for (const dependency of optional) {
      const manifestPath = resolveFilesystemManifest(root, current.manifestPath, dependency)
      if (manifestPath !== undefined) queue.push({ manifestPath, chain: [...current.chain, dependency] })
    }
  }

  return visited.size
}

function normalizeStagedManifestDependencies(staging) {
  const root = path.resolve(staging)
  const queue = [path.join(root, 'package.json')]
  const visited = new Set()
  let changedManifests = 0

  for (let index = 0; index < queue.length; index += 1) {
    const manifestPath = queue[index]
    if (visited.has(manifestPath)) continue
    visited.add(manifestPath)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    let changed = false
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const dependencies = manifest[field]
      if (dependencies === undefined) continue
      for (const dependency of Object.keys(dependencies).sort()) {
        if (ELECTRON_PROVIDED_PACKAGES.has(dependency)) continue
        const dependencyManifestPath = resolveFilesystemManifest(root, manifestPath, dependency)
        if (dependencyManifestPath !== undefined) queue.push(dependencyManifestPath)
        const specifier = dependencies[dependency]
        if (typeof specifier !== 'string' || (!specifier.startsWith('link:') && !specifier.startsWith('workspace:'))) {
          continue
        }
        if (dependencyManifestPath === undefined) {
          if (field === 'optionalDependencies' || manifest.peerDependenciesMeta?.[dependency]?.optional === true) continue
          throw new Error(`Cannot normalize missing staged workspace dependency ${dependency} from ${manifestPath}`)
        }
        const dependencyManifest = JSON.parse(fs.readFileSync(dependencyManifestPath, 'utf8'))
        if (typeof dependencyManifest.version !== 'string') {
          throw new Error(`Cannot normalize ${dependency}: ${dependencyManifestPath} has no version`)
        }
        dependencies[dependency] = dependencyManifest.version
        changed = true
      }
    }
    if (changed) {
      const temporaryPath = `${manifestPath}.dsh-gui-${process.pid}-${index}`
      fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`)
      fs.renameSync(temporaryPath, manifestPath)
      changedManifests += 1
    }
  }

  return changedManifests
}

function resolveAsarManifest(entries, fromManifest, dependency) {
  let directory = path.posix.dirname(fromManifest)
  const segments = packageSegments(dependency)
  while (directory.startsWith('/')) {
    const candidate = path.posix.join(directory, 'node_modules', ...segments, 'package.json')
    if (entries.has(candidate)) return candidate
    if (directory === '/') break
    directory = path.posix.dirname(directory)
  }
  return undefined
}

function assertNativeRuntime(entries, target) {
  const separator = target.lastIndexOf('-')
  const platform = target.slice(0, separator)
  const arch = target.slice(separator + 1)
  const ptyPrebuildRoot = '/node_modules/node-pty/prebuilds'
  const targetPtyPrebuild = `${ptyPrebuildRoot}/${platform}-${arch}`
  for (const entry of entries) {
    if (entry.startsWith(`${ptyPrebuildRoot}/`)
      && entry !== targetPtyPrebuild
      && !entry.startsWith(`${targetPtyPrebuild}/`)) {
      throw new Error(`Packaged native runtime contains a non-target node-pty prebuild: ${entry}`)
    }
  }
  const platformPackages = [
    `/node_modules/@img/sharp-${platform}-${arch}/`,
    `/node_modules/@koromix/koffi-${platform}-${arch}/`,
    `/node_modules/node-addon-require-builtin-${platform}-${arch}${platform === 'win32' ? '-msvc' : ''}/`,
    `/node_modules/node-pty/prebuilds/${platform}-${arch}/`,
  ]
  for (const prefix of platformPackages) {
    if (![...entries].some(entry => entry.startsWith(prefix) && entry.endsWith('.node'))) {
      throw new Error(`Packaged native runtime is missing a .node binary below ${prefix}`)
    }
  }
  if (platform === 'darwin') {
    const helper = `/node_modules/node-pty/prebuilds/${platform}-${arch}/spawn-helper`
    if (!entries.has(helper)) throw new Error(`Packaged native runtime is missing ${helper}`)
  }
}

function assertAsarRuntimeClosure(asar, archivePath, target) {
  const entries = new Set(asar.listPackage(archivePath, { isPack: false }))
  for (const required of REQUIRED_APP_FILES) {
    if (!entries.has(required)) throw new Error(`Packaged desktop app is missing ${required}`)
  }

  const queue = [{ manifestPath: '/package.json', chain: ['desktop app'] }]
  const visited = new Set()
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    if (visited.has(current.manifestPath)) continue
    visited.add(current.manifestPath)
    const manifest = JSON.parse(asar.extractFile(archivePath, current.manifestPath.slice(1)).toString('utf8'))
    const { required, optional } = dependencySets(manifest)
    for (const dependency of required) {
      if (ELECTRON_PROVIDED_PACKAGES.has(dependency)) continue
      const manifestPath = resolveAsarManifest(entries, current.manifestPath, dependency)
      if (manifestPath === undefined) {
        throw new Error(`Packaged runtime dependency is missing: ${[...current.chain, dependency].join(' -> ')}`)
      }
      queue.push({ manifestPath, chain: [...current.chain, dependency] })
    }
    for (const dependency of optional) {
      const manifestPath = resolveAsarManifest(entries, current.manifestPath, dependency)
      if (manifestPath !== undefined) queue.push({ manifestPath, chain: [...current.chain, dependency] })
    }
  }

  assertNativeRuntime(entries, target)
  return { entries: entries.size, packages: visited.size }
}

function assertSafeStagingPath(temporaryRoot, staging) {
  const expectedRoot = path.resolve(temporaryRoot)
  const resolved = path.resolve(staging)
  const name = path.basename(resolved)
  if (path.dirname(resolved) !== expectedRoot || !name.startsWith('dsh-gui-desktop-staging-')) {
    throw new Error(`Refusing to clear an unowned desktop staging path: ${resolved}`)
  }
}

function assertReviewedIgnoredBuilds(ignoredBuilds, expected) {
  if (!Array.isArray(ignoredBuilds)
    || ignoredBuilds.length !== 1
    || ignoredBuilds[0] !== expected) {
    throw new Error(`Desktop staging contains unreviewed ignored builds: ${JSON.stringify(ignoredBuilds)}`)
  }
}

function ignoredBuildsFromPnpmOutput(output) {
  const ignoredBuilds = new Set()
  let sawPolicy = false
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch (error) {
      throw new Error(`dsh-gui package: deploy emitted invalid NDJSON: ${trimmed}`, { cause: error })
    }
    if (event !== null && typeof event === 'object'
      && event.name === 'pnpm:ignored-scripts' && Array.isArray(event.packageNames)) {
      sawPolicy = true
      for (const packageName of event.packageNames) ignoredBuilds.add(packageName)
    }
  }
  if (!sawPolicy) throw new Error('dsh-gui package: deploy did not report ignored-build policy')
  return [...ignoredBuilds]
}

function prepareTargetRuntime(staging, target) {
  const separator = target.lastIndexOf('-')
  const platform = target.slice(0, separator)
  const arch = target.slice(separator + 1)
  const targetPrebuild = `${platform}-${arch}`
  const prebuilds = path.join(staging, 'node_modules', 'node-pty', 'prebuilds')
  if (!fs.existsSync(prebuilds)) throw new Error(`Staged native runtime is missing ${prebuilds}`)
  for (const entry of fs.readdirSync(prebuilds, { withFileTypes: true })) {
    const candidate = path.join(prebuilds, entry.name)
    if (entry.name === targetPrebuild) {
      if (!entry.isDirectory()) throw new Error(`Staged native runtime target is not a directory: ${candidate}`)
      continue
    }
    fs.rmSync(candidate, { recursive: true, force: true })
  }
  const targetDirectory = path.join(prebuilds, targetPrebuild)
  if (!fs.existsSync(targetDirectory)) throw new Error(`Staged native runtime is missing ${targetDirectory}`)
  if (platform !== 'darwin') return
  const helper = path.join(targetDirectory, 'spawn-helper')
  if (!fs.existsSync(helper)) throw new Error(`Staged native runtime is missing ${helper}`)
  fs.chmodSync(helper, 0o755)
  fs.accessSync(helper, fs.constants.X_OK)
}

async function copyPackage(source, destination) {
  const nestedNodeModules = path.join(source, 'node_modules')
  await fsp.cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: candidate => candidate !== nestedNodeModules && !candidate.startsWith(`${nestedNodeModules}${path.sep}`),
  })
}

async function findSymlink(directory, ignoredDirectory) {
  if (!fs.existsSync(directory)) return undefined
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name)
    if (candidate === ignoredDirectory) continue
    const metadata = await fsp.lstat(candidate)
    if (metadata.isSymbolicLink()) return candidate
    if (metadata.isDirectory()) {
      const nested = await findSymlink(candidate, ignoredDirectory)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

async function materializeStagedLinks(staging) {
  const nodeModules = path.join(staging, 'node_modules')
  const virtualStore = path.join(nodeModules, '.pnpm')
  await fsp.rm(path.join(nodeModules, '.bin'), { recursive: true, force: true })
  let remaining = await findSymlink(nodeModules, virtualStore)
  while (remaining !== undefined) {
    const source = await fsp.realpath(remaining)
    await fsp.unlink(remaining)
    await copyPackage(source, remaining)
    remaining = await findSymlink(nodeModules, virtualStore)
  }
  await fsp.rm(virtualStore, { recursive: true, force: true })
  await fsp.rm(path.join(nodeModules, '.modules.yaml'), { force: true })
  const unresolved = await findSymlink(nodeModules, '')
  if (unresolved !== undefined) throw new Error(`Desktop staging still contains a symbolic link: ${unresolved}`)
}

async function withPreservedFile(filePath, operation) {
  let original
  try {
    const metadata = await fsp.stat(filePath)
    if (!metadata.isFile()) throw new Error(`Cannot preserve non-file packaging state: ${filePath}`)
    original = {
      atime: metadata.atime,
      contents: await fsp.readFile(filePath),
      mode: metadata.mode,
      mtime: metadata.mtime,
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  try {
    return await operation()
  } finally {
    if (original === undefined) {
      await fsp.rm(filePath, { force: true })
    } else {
      const temporaryPath = `${filePath}.dsh-gui-${process.pid}`
      try {
        await fsp.writeFile(temporaryPath, original.contents, { mode: original.mode })
        await fsp.rename(temporaryPath, filePath)
        await fsp.chmod(filePath, original.mode)
        await fsp.utimes(filePath, original.atime, original.mtime)
      } finally {
        await fsp.rm(temporaryPath, { force: true })
      }
    }
  }
}

function assertUtilityImports(staging) {
  const environment = { ...process.env, NODE_ENV: 'production' }
  for (const name of [
    'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'DSH_CORDIS_CONFIG', 'DSH_PATCH', 'DSH_PROFILE',
    'DSH_TELEMETRY_MODE', 'DSH_TELEMETRY_OTLP_URL', 'DEEPSEEK_API_KEY', 'ACOSMI_TOKEN', 'ACOSMI_API_KEY',
  ]) delete environment[name]
  const result = childProcess.spawnSync(process.execPath, ['dist/utility.js'], {
    cwd: staging,
    encoding: 'utf8',
    env: environment,
    timeout: 30_000,
  })
  if (result.error !== undefined) throw result.error
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (result.status === 0 || !output.includes('desktop utility requires an Electron parent port')) {
    throw new Error(`Staged utility import smoke failed (${String(result.status)}): ${output.trim()}`)
  }
}

module.exports = {
  assertAsarRuntimeClosure,
  assertFilesystemRuntimeClosure,
  ignoredBuildsFromPnpmOutput,
  assertReviewedIgnoredBuilds,
  assertSafeStagingPath,
  assertUtilityImports,
  materializeStagedLinks,
  normalizeStagedManifestDependencies,
  prepareTargetRuntime,
  withPreservedFile,
}
