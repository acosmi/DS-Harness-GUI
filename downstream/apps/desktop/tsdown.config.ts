import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import { verifyDesktopRelease } from '@acosmi/dsh-desktop-release/verify'

const root = resolve(import.meta.dirname, '../../..')
const require = createRequire(import.meta.url)
const { desktopChannel, desktopReleaseMode, desktopTrustedSigning } = require('./scripts/build-environment.cjs') as {
  desktopChannel(): 'stable' | 'canary'
  desktopReleaseMode(): 'development' | 'candidate' | 'stable'
  desktopTrustedSigning(releaseMode: 'development' | 'candidate' | 'stable'): boolean
}
const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const productCommit = process.env.DSH_PRODUCT_COMMIT ?? headCommit
if (productCommit !== headCommit) throw new Error('DSH_PRODUCT_COMMIT must match the checked-out commit')
const worktreeDirty = execFileSync(
  'git',
  ['status', '--porcelain=v1', '--untracked-files=all'],
  { cwd: root, encoding: 'utf8' },
).trim().length > 0
const channel = desktopChannel()
const releaseMode = desktopReleaseMode()
const trustedSigning = desktopTrustedSigning(releaseMode)
const signing = trustedSigning ? 'signed' : 'development-unsigned'
const { baseline, identity } = verifyDesktopRelease(root, { requireSignedReady: releaseMode === 'stable' })
if (trustedSigning && worktreeDirty) throw new Error('signed desktop builds require a clean worktree')
if (releaseMode === 'stable' && baseline.productCommit !== headCommit) {
  throw new Error('signed desktop build must match the frozen product commit')
}
const channelIdentity = identity.channels[channel]

const buildFacts = JSON.stringify({
  channel,
  productCommit: worktreeDirty ? `dirty:${productCommit}` : productCommit,
  upstreamCommit: baseline.upstream.commit,
  sdkVersion: baseline.acosmiSdk.version,
  signing,
  identity: {
    productName: channelIdentity.productName,
    bundleId: channelIdentity.bundleId,
    windowsAumid: channelIdentity.windows.aumid,
    protocol: channelIdentity.protocol,
    userDataDirectory: channelIdentity.userDataDirectory,
    harnessDirectory: channelIdentity.harnessDirectory,
    vaultFilename: channelIdentity.vaultFilename,
    profileFilename: channelIdentity.profileFilename,
    secretNamespace: channelIdentity.secretNamespace,
    oauthIssuer: 'https://acosmi.com',
  },
})

export default defineConfig([
  {
    entry: { main: 'src/main.ts', utility: 'src/utility.ts' },
    outDir: 'dist',
    format: ['esm'],
    platform: 'node',
    target: 'node24',
    fixedExtension: false,
    clean: false,
    dts: false,
    external: ['electron'],
    define: { __DSH_BUILD_FACTS__: buildFacts },
  },
  {
    entry: { preload: 'src/preload.ts' },
    outDir: 'dist',
    format: ['cjs'],
    platform: 'node',
    target: 'node24',
    fixedExtension: false,
    clean: false,
    dts: false,
    external: ['electron'],
    noExternal: [/^@acosmi\/dsh-desktop-/u],
  },
])
