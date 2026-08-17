const path = require('node:path')
const identity = require('../../release/identity.json')
const {
  desktopChannel,
  desktopMacIdentity,
  desktopReleaseMode,
  desktopTrustedSigning,
} = require('./scripts/build-environment.cjs')

const channel = desktopChannel()
const channelIdentity = identity.channels[channel]
const releaseMode = desktopReleaseMode()
const trustedSigning = desktopTrustedSigning(releaseMode)
const repositoryRoot = path.resolve(__dirname, '../../..')
const productIcon = path.join(repositoryRoot, 'assets/branding/dsh-gui-whale-browser-logo-v6.png')

module.exports = {
  appId: channelIdentity.bundleId,
  productName: channelIdentity.productName,
  electronVersion: '43.4.0',
  asar: true,
  asarUnpack: [
    '**/*.node',
    '**/node-pty/**',
    '**/koffi/**',
    '**/@koromix/koffi-*/**',
    '**/@img/sharp-*/**',
    '**/@img/sharp-libvips-*/**',
    '**/node-addon-require-builtin-*/**',
  ],
  compression: 'maximum',
  npmRebuild: false,
  buildDependenciesFromSource: false,
  forceCodeSigning: trustedSigning,
  directories: {
    output: path.resolve(__dirname, '../../../.artifacts/desktop', channel),
    buildResources: path.resolve(__dirname, 'resources'),
  },
  files: [
    'dist/**/*',
    'node_modules/**/*',
    'package.json',
    '!dist/**/*.map',
    '!node_modules/.pnpm/**',
    '!node_modules/.modules.yaml',
    '!**/*.map',
    '!**/.env',
    '!**/tests/**',
    '!**/test/**',
    '!**/docs/**',
  ],
  extraResources: [
    { from: path.join(repositoryRoot, 'apps/cli/config/agent-presets'), to: 'config/agent-presets' },
    { from: path.join(repositoryRoot, 'downstream/upstream-baseline.json'), to: 'provenance/upstream-baseline.json' },
    { from: path.join(repositoryRoot, 'downstream/release/identity.json'), to: 'provenance/identity.json' },
    { from: path.join(repositoryRoot, 'downstream/release/support-matrix.json'), to: 'provenance/support-matrix.json' },
    { from: path.join(repositoryRoot, 'downstream/release/native-modules.json'), to: 'provenance/native-modules.json' },
    { from: path.join(repositoryRoot, 'downstream/release/external-inputs.json'), to: 'provenance/external-inputs.json' },
    { from: path.join(repositoryRoot, 'downstream/release/responsibilities.json'), to: 'provenance/responsibilities.json' },
    { from: path.join(repositoryRoot, 'LICENSE'), to: 'licenses/DeepSeek-Harness-MIT.txt' },
    { from: path.join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), to: 'licenses/THIRD_PARTY_NOTICES.md' },
  ],
  afterPack: path.resolve(__dirname, 'scripts/after-pack.cjs'),
  afterSign: path.resolve(__dirname, 'scripts/after-sign.cjs'),
  protocols: [{
    name: 'DSH-GUI',
    schemes: [channelIdentity.protocol],
  }],
  mac: {
    category: 'public.app-category.developer-tools',
    icon: productIcon,
    identity: desktopMacIdentity(identity.macSigning.identitySha1, releaseMode),
    sign: trustedSigning ? path.resolve(__dirname, 'scripts/sign-mac.cjs') : undefined,
    notarize: trustedSigning,
    target: ['dmg', 'zip'],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    minimumSystemVersion: '12.0',
    helperBundleId: channelIdentity.mac.helperBundleId,
    helperRendererBundleId: channelIdentity.mac.helperRendererBundleId,
    helperPluginBundleId: channelIdentity.mac.helperPluginBundleId,
    helperGPUBundleId: channelIdentity.mac.helperGpuBundleId,
    helperEHBundleId: channelIdentity.mac.helperEhBundleId,
    entitlements: path.resolve(__dirname, 'resources/entitlements.mac.plist'),
    entitlementsInherit: path.resolve(__dirname, 'resources/entitlements.mac.plist'),
    artifactName: '${productName}-${version}-${arch}.${ext}',
  },
  dmg: {
    sign: trustedSigning,
  },
  win: {
    icon: productIcon,
    target: ['nsis'],
    artifactName: '${productName}-Setup-${version}-${arch}.${ext}',
    executableName: channelIdentity.windows.executableName,
  },
  nsis: {
    guid: channelIdentity.windows.installerGuid,
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: channelIdentity.windows.startMenuShortcut,
  },
  publish: null,
}
