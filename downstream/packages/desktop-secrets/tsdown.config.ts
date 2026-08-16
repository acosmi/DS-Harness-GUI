import { defineConfig } from 'tsdown'

export default defineConfig(({ env }) => {
  if (env?.DSH_BUILD_FACE === 'client') return { entry: '' }
  return {
    entry: {
      index: 'lib/types/index.js',
      vault: 'lib/types/vault.js',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }
})
