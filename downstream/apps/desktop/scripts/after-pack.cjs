const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const {
  flipFuses,
  FuseVersion,
  FuseV1Options,
} = require('@electron/fuses')
const asar = require('@electron/asar')
const identity = require('../../../release/identity.json')
const { assertAsarRuntimeClosure } = require('./runtime-closure.cjs')
const { desktopChannel, desktopReleaseMode, desktopTrustedSigning } = require('./build-environment.cjs')

const PLUTIL = '/usr/bin/plutil'
const UNUSED_PERMISSION_KEYS = [
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
]
const ARCH_NAMES = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
}

function readPlist(filePath) {
  return JSON.parse(childProcess.execFileSync(PLUTIL, ['-convert', 'json', '-o', '-', filePath], {
    encoding: 'utf8',
  }))
}

function writePlist(filePath, value) {
  const temporaryPath = `${filePath}.dsh-gui.json`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  try {
    childProcess.execFileSync(PLUTIL, ['-convert', 'xml1', '-o', filePath, temporaryPath])
  } finally {
    fs.rmSync(temporaryPath, { force: true })
  }
}

function assertBundleIdentifier(filePath, expected) {
  const plist = readPlist(filePath)
  if (plist.CFBundleIdentifier !== expected) {
    throw new Error(`Unexpected bundle identifier in ${filePath}: ${String(plist.CFBundleIdentifier)}`)
  }
  return plist
}

function assertMacHelperIdentifiers(actualIdentifiers, productName, macIdentity) {
  const expectedHelpers = new Map([
    [`${productName} Helper.app`, { identifier: macIdentity.helperBundleId, required: true }],
    [`${productName} Helper (Renderer).app`, { identifier: macIdentity.helperRendererBundleId, required: true }],
    [`${productName} Helper (Plugin).app`, { identifier: macIdentity.helperPluginBundleId, required: true }],
    [`${productName} Helper (GPU).app`, { identifier: macIdentity.helperGpuBundleId, required: true }],
    [`${productName} Helper EH.app`, { identifier: macIdentity.helperEhBundleId, required: false }],
  ])

  for (const [helperName, expectation] of expectedHelpers) {
    if (expectation.required && !actualIdentifiers.has(helperName)) {
      throw new Error(`Required Electron helper is missing: ${helperName}`)
    }
  }
  for (const [helperName, actualIdentifier] of actualIdentifiers) {
    const expectation = expectedHelpers.get(helperName)
    if (expectation === undefined) {
      throw new Error(`Unrecognized Electron helper requires an explicit release identity: ${helperName}`)
    }
    if (actualIdentifier !== expectation.identifier) {
      throw new Error(`Unexpected bundle identifier in ${helperName}: ${String(actualIdentifier)}`)
    }
  }
}

async function signDevelopmentApp(appPath) {
  const { sign } = await import('@electron/osx-sign')
  const entitlements = path.resolve(__dirname, '../resources/entitlements.mac.plist')
  const options = {
    app: appPath,
    platform: 'darwin',
    identity: '-',
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile: () => ({
      entitlements,
      hardenedRuntime: false,
      timestamp: 'none',
    }),
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await sign(options)
      childProcess.execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (attempt === 1 || !message.includes('internal error in Code Signing subsystem')) throw error
    }
  }
}

module.exports = async function afterPack(context) {
  const channel = desktopChannel()
  const channelIdentity = identity.channels[channel]
  const productName = channelIdentity.productName
  const executablePath = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${productName}.app`, 'Contents', 'MacOS', productName)
    : path.join(context.appOutDir, `${channelIdentity.windows.executableName}.exe`)
  const resourcesPath = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${productName}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
  const arch = ARCH_NAMES[context.arch]
  if (arch === undefined) throw new Error(`Unsupported packaged architecture ${String(context.arch)}`)
  const closure = assertAsarRuntimeClosure(
    asar,
    path.join(resourcesPath, 'app.asar'),
    `${context.electronPlatformName}-${arch}`,
  )
  console.log(`dsh-gui package: verified ${closure.packages} packages across ${closure.entries} ASAR entries`)

  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    resetAdHocDarwinSignature: false,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true,
  })

  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(context.appOutDir, `${productName}.app`)
  const infoPath = path.join(appPath, 'Contents', 'Info.plist')
  const plist = assertBundleIdentifier(infoPath, channelIdentity.bundleId)

  delete plist.NSAppTransportSecurity
  for (const key of UNUSED_PERMISSION_KEYS) delete plist[key]
  writePlist(infoPath, plist)

  const frameworksPath = path.join(appPath, 'Contents', 'Frameworks')
  const actualHelperIdentifiers = new Map()
  for (const helper of fs.readdirSync(frameworksPath, { withFileTypes: true })) {
    if (!helper.isDirectory() || !helper.name.endsWith('.app')) continue
    const helperInfoPath = path.join(frameworksPath, helper.name, 'Contents', 'Info.plist')
    actualHelperIdentifiers.set(helper.name, readPlist(helperInfoPath).CFBundleIdentifier)
  }
  assertMacHelperIdentifiers(actualHelperIdentifiers, productName, channelIdentity.mac)

  if (!desktopTrustedSigning(desktopReleaseMode())) {
    await signDevelopmentApp(appPath)
  }
}

module.exports.assertMacHelperIdentifiers = assertMacHelperIdentifiers
