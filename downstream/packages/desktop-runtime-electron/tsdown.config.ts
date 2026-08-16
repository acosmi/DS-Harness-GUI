import { defineConfig } from 'tsdown'

export default defineConfig(({ env }) => {
  if (env?.DSH_BUILD_FACE === 'client') return { entry: '' }
  return {
    entry: {
      index: 'lib/types/index.js',
      main: 'lib/types/main.js',
      preload: 'lib/types/preload.js',
      utility: 'lib/types/utility.js',
      messages: 'lib/types/messages.js',
      composition: 'lib/types/composition.js',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    external: ['electron'],
  }
})
