import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import {
  buildDesktopRendererAssets,
  renderDesktopAssetManifest,
} from '@acosmi/dsh-desktop-renderer-bootstrap'
import { PLATFORM_MODULES } from '@deepseek-ai/dsh-client-web/src/platform.ts'
import { DSH_GUI_LOGO_ASSET_PATH } from '../../packages/ui-desktop/src/client/branding.ts'

const renderer = buildDesktopRendererAssets(import.meta.url, PLATFORM_MODULES)
const source = (relativePath: string): string => fileURLToPath(new URL(relativePath, import.meta.url))
const productLogo = readFileSync(source(`../../../assets/${DSH_GUI_LOGO_ASSET_PATH}`))

function desktopAssets(): Plugin {
  const outputDirectory = source('./dist/renderer/')
  return {
    name: 'dsh-gui-desktop-assets',
    apply: 'build',
    enforce: 'post',
    buildStart() {
      for (const asset of renderer.assets) {
        this.emitFile({ type: 'asset', fileName: asset.fileName, source: asset.source })
      }
      this.emitFile({ type: 'asset', fileName: DSH_GUI_LOGO_ASSET_PATH, source: productLogo })
    },
    closeBundle() {
      const files = readFinalOutput(outputDirectory)
      writeFileSync(
        join(outputDirectory, 'assets.manifest.json'),
        renderDesktopAssetManifest(files),
      )
    },
  }
}

function readFinalOutput(root: string, prefix = ''): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (relativePath === 'assets.manifest.json') continue
    if (entry.isDirectory()) {
      for (const [path, content] of readFinalOutput(root, relativePath)) files.set(path, content)
    } else if (entry.isFile()) {
      files.set(relativePath, readFileSync(join(root, relativePath)))
    } else {
      throw new Error('desktop renderer output contains a non-file entry')
    }
  }
  return files
}

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react(), tsconfigPaths({ projects: [resolveRoot('tsconfig.renderer.json')] }), desktopAssets()],
  define: {
    __DSH_DESKTOP_BOOT__: JSON.stringify(renderer.graph),
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    'process.env.CORDIS_SHARED': 'undefined',
  },
  resolve: {
    // Browserize the shell's Node import as apps/web does. The Electron
    // renderer consumes the current upstream shell source while every product
    // client plugin remains an immutable runtime bundle from the allowlist.
    alias: [
      { find: /^node:module$/, replacement: source('../../../apps/web/src/node-module-stub.ts') },
      { find: /^@deepseek-ai\/dsh-client-web$/, replacement: source('../../../packages/client/web/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-slots$/, replacement: source('../../../packages/client/ui-slots/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: source('../../../packages/client/ui-primitives/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-attachment$/, replacement: source('../../../packages/client/ui-attachment/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-modules\/client$/, replacement: source('../../../packages/client/modules/src/client/index.ts') },
    ],
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    sourcemap: false,
    target: 'chrome142',
  },
})

function resolveRoot(filename: string): string {
  return fileURLToPath(new URL(filename, import.meta.url))
}
