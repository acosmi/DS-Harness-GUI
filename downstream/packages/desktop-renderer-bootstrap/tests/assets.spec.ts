import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import { PLATFORM_MODULES } from '@deepseek-ai/dsh-client-web/src/platform.ts'
import { describe, expect, it } from 'vitest'
import { validateDesktopGraph } from '../src/client.ts'
import {
  DESKTOP_CLIENT_ALLOWLIST,
  buildDesktopBootPrelude,
  composeDesktopBootGraph,
  injectDesktopBootPrelude,
  renderDesktopAssetManifest,
  verifyDesktopBootDocument,
  verifyDesktopRendererOutput,
} from '../src/index.ts'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const RUNTIME_ID = '@deepseek-ai/dsh-client-runtime'
const MODULES_SOURCE = 'modules'
const RUNTIME_SOURCE = 'runtime'

function contentRev(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16)
}

function bootstrapGraph(): WebBootGraph {
  const modulesRev = contentRev(MODULES_SOURCE)
  const runtimeRev = contentRev(RUNTIME_SOURCE)
  return {
    rev: 'graph',
    entries: [
      { id: MODULES_ID, url: `app://dsh-gui/plugins/modules-a.js?rev=${modulesRev}`, rev: modulesRev },
      { id: RUNTIME_ID, url: `app://dsh-gui/plugins/runtime-b.js?rev=${runtimeRev}`, rev: runtimeRev },
    ],
  }
}

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

  it('emits and verifies a content-addressed external facade before blocking parser preloads', () => {
    const prelude = buildDesktopBootPrelude(bootstrapGraph())
    const input = [
      '<html><head>',
      '<meta http-equiv="Content-Security-Policy" content="script-src \'self\'" />',
      '<script type="module" src="./assets/index.js"></script>',
      '</head></html>',
    ].join('')
    const html = injectDesktopBootPrelude(input, prelude)
    const facadeAt = html.indexOf(`src="./${prelude.facade.fileName}"`)
    const modulesAt = html.indexOf(`src="${bootstrapGraph().entries[0]?.url}"`)
    const runtimeAt = html.indexOf(`src="${bootstrapGraph().entries[1]?.url}"`)
    const entryAt = html.indexOf('type="module"')
    const policyAt = html.indexOf('http-equiv="Content-Security-Policy"')

    expect(prelude.facade.fileName).toMatch(/^bootstrap\/module-loader-[0-9a-f]{16}\.js$/u)
    expect([facadeAt, modulesAt, runtimeAt, entryAt]).toEqual([
      facadeAt, modulesAt, runtimeAt, entryAt,
    ].toSorted((left, right) => left - right))
    expect(policyAt).toBeLessThan(facadeAt)
    expect(html).not.toContain('<script>')
    expect(html).toContain('content="script-src \'self\'"')
    expect(() => verifyDesktopBootDocument(html, prelude)).not.toThrow()

    const window: { __ModuleLoader__?: { mode: string } } = {}
    runInNewContext(prelude.facade.source, { window })
    expect(window.__ModuleLoader__?.mode).toBe('queue')

    const files = new Map<string, string | Uint8Array>([
      ['index.html', html],
      [prelude.facade.fileName, prelude.facade.source],
      ['plugins/modules-a.js', MODULES_SOURCE],
      ['plugins/runtime-b.js', RUNTIME_SOURCE],
    ])
    expect(() => verifyDesktopRendererOutput(files, prelude)).not.toThrow()
    const manifest = JSON.parse(renderDesktopAssetManifest(files)) as { files: Array<{ path: string }> }
    expect(manifest.files.map(file => file.path)).toContain(prelude.facade.fileName)

    const invalid = new Map(files)
    invalid.delete(prelude.facade.fileName)
    expect(() => verifyDesktopRendererOutput(invalid, prelude)).toThrow(/omits the module-loader facade/u)
    invalid.set(prelude.facade.fileName, 'changed')
    expect(() => verifyDesktopRendererOutput(invalid, prelude)).toThrow(/changed the module-loader facade/u)
    invalid.set(prelude.facade.fileName, prelude.facade.source)
    invalid.delete('plugins/modules-a.js')
    expect(() => verifyDesktopRendererOutput(invalid, prelude)).toThrow(/omits parser preload/u)
    invalid.set('plugins/modules-a.js', 'changed')
    expect(() => verifyDesktopRendererOutput(invalid, prelude)).toThrow(/changed parser preload/u)
  })

  it('preserves and orders dynamic module requests, rejecting absent suppliers', () => {
    const provider = { id: '@fixture/provider', url: 'app://dsh-gui/plugins/provider.js?rev=a', rev: 'a' }
    const consumer = {
      id: '@fixture/consumer',
      url: 'app://dsh-gui/plugins/consumer.js?rev=b',
      rev: 'b',
      external: ['@fixture/provider/client', 'react'],
    }
    const graph = composeDesktopBootGraph([consumer, provider], ['react'])

    expect(graph.entries.map(entry => entry.id)).toEqual([provider.id, consumer.id])
    expect(graph.entries[1]?.external).toEqual(['@fixture/provider/client', 'react'])
    expect(() => composeDesktopBootGraph([{
      ...consumer,
      external: ['@fixture/missing/client'],
    }, provider], ['react'])).toThrow(/unresolved module requests.*@fixture\/missing\/client/u)
  })

  it('rejects a missing entry document and invalid output path', () => {
    expect(() => renderDesktopAssetManifest(new Map())).toThrow(/omits index\.html/)
    expect(() => renderDesktopAssetManifest(new Map([
      ['index.html', 'ok'],
      ['../outside.js', 'bad'],
    ]))).toThrow(/invalid path/)
  })

  it('rejects a renderer document without a Vite module entry', () => {
    expect(() => injectDesktopBootPrelude('<main></main>', buildDesktopBootPrelude(bootstrapGraph())))
      .toThrow(/omits the Vite module entry/u)
  })

  it('requires both desktop parser preloads', () => {
    const graph = bootstrapGraph()
    graph.entries.pop()
    expect(() => buildDesktopBootPrelude(graph)).toThrow(/must include modules and runtime/u)
  })

  it('rejects missing, late, and inline boot scripts', () => {
    const prelude = buildDesktopBootPrelude(bootstrapGraph())
    const valid = injectDesktopBootPrelude(
      '<head><script type="module" src="./assets/index.js"></script></head>',
      prelude,
    )
    expect(() => verifyDesktopBootDocument(valid.replace(
      `<script src="./${prelude.facade.fileName}"></script>`,
      '',
    ), prelude)).toThrow(/boot document omits/u)
    const moduleTag = '<script type="module" src="./assets/index.js"></script>'
    expect(() => verifyDesktopBootDocument(
      moduleTag + valid.replace(moduleTag, ''),
      prelude,
    )).toThrow(/module entry does not follow/u)
    expect(() => verifyDesktopBootDocument(valid.replace(
      '</head>',
      '<script>window.bad = true</script></head>',
    ), prelude)).toThrow(/inline script/u)
    expect(() => verifyDesktopRendererOutput(new Map(), prelude)).toThrow(/omits index\.html/u)
  })
})

describe('desktop renderer graph validation', () => {
  const rev = '0123456789abcdef'
  const graph = (url: string, entryRev = rev): WebBootGraph => ({
    rev: 'graph',
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

  it('rejects malformed raw graph rows before exposing the wire upstream', () => {
    expect(() => validateDesktopGraph(undefined)).toThrow(/graph is missing/u)
    expect(() => validateDesktopGraph({ rev: 'graph' })).toThrow(/entries are missing/u)
    expect(() => validateDesktopGraph({ rev: 'graph', entries: [null] }))
      .toThrow(/entry is not an object/u)
    expect(() => validateDesktopGraph({ rev: 'graph', entries: [{ id: 'demo' }] }))
      .toThrow(/must carry string id\/url\/rev/u)
  })
})
