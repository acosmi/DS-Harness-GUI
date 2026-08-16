import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  parseDesktopAssetManifest,
  verifyDesktopAsset,
} from '../src/assets.ts'

function hash(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('desktop renderer asset integrity', () => {
  const index = new TextEncoder().encode('<main></main>')
  const plugin = new TextEncoder().encode('window.plugin = true')
  const revision = hash(plugin).slice(0, 16)
  const pluginPath = `plugins/example-${revision}.js`
  const manifest = JSON.stringify({
    version: 2,
    files: [
      { path: 'index.html', sha256: hash(index) },
      { path: pluginPath, sha256: hash(plugin) },
    ],
  })

  it('authenticates allowlisted bytes and the plugin revision', () => {
    const parsed = parseDesktopAssetManifest(manifest)
    expect(() => verifyDesktopAsset(parsed, 'index.html', '', index)).not.toThrow()
    expect(() => verifyDesktopAsset(parsed, pluginPath, `?rev=${revision}`, plugin)).not.toThrow()
  })

  it('rejects malformed manifests, byte changes, and revision mismatches', () => {
    expect(() => parseDesktopAssetManifest(JSON.stringify({ version: 1, files: [] }))).toThrow(/invalid/)
    expect(() => parseDesktopAssetManifest(JSON.stringify({
      version: 2,
      files: [
        { path: 'index.html', sha256: hash(index) },
        { path: 'index.html', sha256: hash(index) },
      ],
    }))).toThrow(/duplicate/)
    const parsed = parseDesktopAssetManifest(manifest)
    expect(() => verifyDesktopAsset(parsed, 'index.html', '?rev=bad', index)).toThrow(/query parameters/)
    expect(() => verifyDesktopAsset(parsed, pluginPath, '?rev=0000000000000000', plugin)).toThrow(/revision/)
    expect(() => verifyDesktopAsset(parsed, pluginPath, `?rev=${revision}`, new Uint8Array([1])))
      .toThrow(/hash/)
    expect(() => verifyDesktopAsset(parsed, 'missing.js', '', new Uint8Array())).toThrow(/allowlisted/)
  })
})
