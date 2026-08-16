import { defineConfig } from 'tsdown'

export default defineConfig(({ env }) => {
  const face = env?.DSH_BUILD_FACE
  if (face !== undefined && face !== 'host' && face !== 'client') {
    throw new Error(`desktop-renderer-bootstrap: invalid build face ${String(face)}`)
  }
  if (face === 'client') {
    return {
      entry: { client: 'lib/types/client.js' },
      outDir: 'lib',
      format: ['esm'],
      platform: 'browser',
      target: 'es2024',
      fixedExtension: false,
      dts: false,
      clean: false,
      external: [
        '@acosmi/dsh-desktop-carrier-electron/client',
        '@deepseek-ai/dsh-client-connection/carrier',
        '@deepseek-ai/dsh-client-web',
      ],
    }
  }
  return {
    entry: { index: 'lib/types/index.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }
})
