/** Thin DSH-GUI Electron main entry. */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import {
  registerDesktopScheme,
  runDesktopMain,
} from '@acosmi/dsh-desktop-runtime-electron/main'

const directory = dirname(fileURLToPath(import.meta.url))
const presetRoot = app.isPackaged
  ? join(process.resourcesPath, 'config', 'agent-presets')
  : join(directory, '..', '..', '..', '..', 'apps', 'cli', 'config', 'agent-presets')

registerDesktopScheme()
void runDesktopMain({
  channel: __DSH_BUILD_FACTS__.channel,
  identity: __DSH_BUILD_FACTS__.identity,
  preloadPath: join(directory, 'preload.cjs'),
  utilityPath: join(directory, 'utility.js'),
  rendererRoot: join(directory, 'renderer'),
  rendererAssetManifest: join(directory, 'renderer', 'assets.manifest.json'),
  presetRoot,
  productInfo: {
    productName: 'DSH-GUI',
    displayNameZh: 'DeepSeek Harness 桌面端',
    channel: __DSH_BUILD_FACTS__.channel,
    productCommit: __DSH_BUILD_FACTS__.productCommit,
    upstreamCommit: __DSH_BUILD_FACTS__.upstreamCommit,
    sdkVersion: __DSH_BUILD_FACTS__.sdkVersion,
    signing: __DSH_BUILD_FACTS__.signing,
    disclaimer: 'DSH-GUI is a community distribution maintained by Acosmi and is not an official DeepSeek distribution.',
  },
  development: process.env.NODE_ENV !== 'production',
})
