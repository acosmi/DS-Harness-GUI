import { createHash } from 'node:crypto'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import { PLATFORM_MODULES } from '@deepseek-ai/dsh-client-web/src/platform.ts'
import { describe, expect, it } from 'vitest'
import { validateDesktopGraph } from '../src/client.ts'
import { DESKTOP_CLIENT_ALLOWLIST, renderDesktopAssetManifest } from '../src/index.ts'

describe('desktop renderer asset manifest generation', () => {
  it('includes the dynamic UI renderer in the production client graph', () => {
    expect(DESKTOP_CLIENT_ALLOWLIST).toContain('@deepseek-ai/dsh-client-ui-renderer')
  })

  it('keeps UI primitives in the shell-static baseline instead of the dynamic graph', () => {
    expect(PLATFORM_MODULES).toContain('@deepseek-ai/dsh-client-ui-primitives')
    expect(DESKTOP_CLIENT_ALLOWLIST).not.toContain('@deepseek-ai/dsh-client-ui-primitives')
  })

  it('records deterministic SHA-256 values for exact final bytes', () => {
    const files = new Map<string, string | Uint8Array>([
      ['plugins/demo.js', new Uint8Array([1, 2, 3])],
      ['index.html', '<main></main>'],
    ])
    const manifest = JSON.parse(renderDesktopAssetManifest(files)) as {
      version: number
      files: Array<{ path: string; sha256: string }>
    }
    expect(manifest).toEqual({
      version: 2,
      files: [
        {
          path: 'index.html',
          sha256: createHash('sha256').update('<main></main>').digest('hex'),
        },
        {
          path: 'plugins/demo.js',
          sha256: createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'),
        },
      ],
    })
  })

  it('rejects a missing entry document and invalid output path', () => {
    expect(() => renderDesktopAssetManifest(new Map())).toThrow(/omits index\.html/)
    expect(() => renderDesktopAssetManifest(new Map([
      ['index.html', 'ok'],
      ['../outside.js', 'bad'],
    ]))).toThrow(/invalid path/)
  })
})

describe('desktop renderer graph validation', () => {
  const rev = '0123456789abcdef'
  const graph = (url: string, entryRev = rev): WebBootGraph => ({
    entries: [{ id: 'demo', url, rev: entryRev }],
  })

  it('accepts the exact custom-scheme plugin URL without relying on URL.origin', () => {
    expect(new URL(`app://dsh-gui/plugins/demo.${rev}.js?rev=${rev}`).origin).toBe('null')
    expect(() => validateDesktopGraph(graph(
      `app://dsh-gui/plugins/demo.${rev}.js?rev=${rev}`,
    ))).not.toThrow()
  })

  it('rejects extra URL components and non-canonical revisions', () => {
    expect(() => validateDesktopGraph(graph(
      `app://dsh-gui/plugins/demo.${rev}.js?rev=${rev}&extra=1`,
    ))).toThrow(/revision/)
    expect(() => validateDesktopGraph(graph(
      `app://user@dsh-gui/plugins/demo.${rev}.js?rev=${rev}`,
    ))).toThrow(/bundle URL/)
    expect(() => validateDesktopGraph(graph(
      `app://dsh-gui/plugins/demo.${rev}.js?rev=${rev}#fragment`,
    ))).toThrow(/bundle URL/)
    expect(() => validateDesktopGraph(graph(
      `app://dsh-gui/plugins/demo.${rev}.js?rev=${rev}`,
      '0123456789ABCDEf',
    ))).toThrow(/revision/)
  })
})
