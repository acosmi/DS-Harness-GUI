import { defineConfig } from 'tsdown'

export default defineConfig(({ env }) => {
  const face = env?.DSH_BUILD_FACE
  if (face !== undefined && face !== 'host' && face !== 'client') {
    throw new Error(`desktop-carrier: invalid build face ${String(face)}`)
  }
  const entries = face === 'client'
    ? { client: 'lib/types/client.js', protocol: 'lib/types/protocol.js' }
    : { index: 'lib/types/index.js', protocol: 'lib/types/protocol.js' }
  return {
    entry: entries,
    outDir: 'lib',
    format: ['esm'],
    platform: face === 'client' ? 'browser' : 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }
})
