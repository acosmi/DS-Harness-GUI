/** Build-time generation of the immutable DSH-GUI renderer plugin graph. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import { DESKTOP_RENDERER_ORIGIN } from '@acosmi/dsh-desktop-carrier-electron/protocol'
import {
  clientBootAssets,
  orderByModuleGraph,
  stripClientSuffix,
  type WebBootEntry,
} from '@deepseek-ai/dsh-client-modules'

/** Client packages admitted to the production desktop renderer. */
export const DESKTOP_CLIENT_ALLOWLIST = [
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-cordis-client-runner',
  '@deepseek-ai/dsh-client-ui-theme',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-general',
  '@deepseek-ai/dsh-client-ui-settings-models',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-cordis',
  '@deepseek-ai/dsh-client-ui-workflow-run',
  '@deepseek-ai/dsh-client-ui-deliverables',
  '@deepseek-ai/dsh-session-log-export',
  '@deepseek-ai/dsh-client-ui-workspace',
  '@deepseek-ai/dsh-client-ui-directory-picker-native',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-commands',
  '@deepseek-ai/dsh-client-ui-skill',
  '@deepseek-ai/dsh-client-ui-subagent',
  '@deepseek-ai/dsh-client-ui-jobs',
  '@deepseek-ai/dsh-client-ui-goal',
  '@deepseek-ai/dsh-client-ui-message-feedback',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-permission-presets',
  '@deepseek-ai/dsh-client-ui-agent-preset',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-ui-user-questions',
  '@deepseek-ai/dsh-client-ui-trajectory',
  '@acosmi/dsh-api-remotes-acosmi',
  '@acosmi/dsh-ui-acosmi-account',
  '@acosmi/dsh-ui-desktop',
] as const

/** One immutable client bundle copied into renderer assets. */
export interface DesktopClientAsset {
  readonly id: string
  readonly fileName: string
  readonly source: string
  readonly rev: string
}

/** Renderer manifest produced from package metadata and exact bundle bytes. */
export type DesktopBootGraph = import('@deepseek-ai/dsh-client-modules/client').WebBootGraph

/** One immutable parser-stage renderer asset. */
export interface DesktopBootAsset {
  readonly fileName: string
  readonly source: string
}

/** Parser-stage files and graph rows that must precede the Vite module. */
export interface DesktopBootPrelude {
  readonly facade: DesktopBootAsset
  readonly parserPreloads: readonly [modules: WebBootEntry, runtime: WebBootEntry]
}

/** Complete build-time renderer payload. */
export interface DesktopRendererAssets extends DesktopBootPrelude {
  readonly graph: DesktopBootGraph
  readonly assets: readonly DesktopClientAsset[]
}

/**
 * Add the CSP-compatible external boot prelude before the Vite module entry.
 * @param html - Vite's transformed renderer document.
 * @param assets - build-time renderer payload.
 * @returns the document with blocking facade, modules, and runtime scripts.
 */
export function injectDesktopBootPrelude(
  html: string,
  assets: DesktopBootPrelude,
): string {
  const sources = [
    `./${assets.facade.fileName}`,
    ...assets.parserPreloads.map(entry => entry.url),
  ]
  const scripts = sources
    .map(source => `<script src="${escapeHtmlAttribute(source)}"></script>`)
    .join('')
  const moduleEntry = findModuleEntry(html)
  if (moduleEntry === undefined) throw new Error('desktop renderer index omits the Vite module entry')
  return `${html.slice(0, moduleEntry)}${scripts}${html.slice(moduleEntry)}`
}

/**
 * Verify that the built renderer preserves the blocking boot order under CSP.
 * @param html - final Vite renderer document.
 * @param assets - expected facade and parser preload rows.
 */
export function verifyDesktopBootDocument(
  html: string,
  assets: DesktopBootPrelude,
): void {
  const requiredSources = [
    `./${assets.facade.fileName}`,
    ...assets.parserPreloads.map(entry => entry.url),
  ]
  let cursor = -1
  for (const source of requiredSources) {
    const tag = `<script src="${escapeHtmlAttribute(source)}"></script>`
    const found = html.indexOf(tag, cursor + 1)
    if (found === -1) throw new Error(`desktop renderer boot document omits ${source}`)
    cursor = found
  }
  const moduleEntry = findModuleEntry(html)
  if (moduleEntry === undefined || moduleEntry <= cursor) {
    throw new Error('desktop renderer module entry does not follow parser preloads')
  }
  for (const match of html.matchAll(/<script\b([^>]*)>/gu)) {
    if (!/\bsrc="[^"]+"/u.test(match[1] ?? '')) {
      throw new Error('desktop renderer boot document contains an inline script')
    }
  }
}

/**
 * Verify the final renderer document and every parser-stage file before hashing it.
 * @param files - final Vite output paths and exact emitted bytes.
 * @param assets - expected facade and parser preload rows.
 */
export function verifyDesktopRendererOutput(
  files: ReadonlyMap<string, string | Uint8Array>,
  assets: DesktopBootPrelude,
): void {
  const index = files.get('index.html')
  if (index === undefined) throw new Error('desktop renderer output omits index.html')
  verifyDesktopBootDocument(Buffer.from(index).toString('utf8'), assets)
  const facade = files.get(assets.facade.fileName)
  if (facade === undefined) throw new Error('desktop renderer output omits the module-loader facade')
  if (!Buffer.from(facade).equals(Buffer.from(assets.facade.source))) {
    throw new Error('desktop renderer output changed the module-loader facade bytes')
  }
  for (const entry of assets.parserPreloads) {
    const path = new URL(entry.url).pathname.slice(1)
    const content = files.get(path)
    if (content === undefined) throw new Error(`desktop renderer output omits parser preload ${entry.id}`)
    if (shortHash(content) !== entry.rev) {
      throw new Error(`desktop renderer output changed parser preload ${entry.id}`)
    }
  }
}

/**
 * Build the immutable external facade and locate its required graph rows.
 * @param graph - composed renderer graph.
 * @returns content-addressed facade and blocking preload rows.
 */
export function buildDesktopBootPrelude(graph: DesktopBootGraph): DesktopBootPrelude {
  const boot = clientBootAssets(graph)
  const modules = boot.parserPreloads[0]
  const runtime = boot.parserPreloads[1]
  if (modules === undefined || runtime === undefined) {
    throw new Error('desktop renderer boot graph must include modules and runtime parser preloads')
  }
  const facadeSource = `${boot.facadeSource}\n`
  return {
    facade: {
      fileName: `bootstrap/module-loader-${shortHash(facadeSource)}.js`,
      source: facadeSource,
    },
    parserPreloads: [modules, runtime],
  }
}

/**
 * Render the strict per-file integrity manifest consumed by Electron main.
 * @param files - final Vite output paths and exact emitted bytes.
 * @returns deterministic JSON with one SHA-256 record per renderer asset.
 */
export function renderDesktopAssetManifest(
  files: ReadonlyMap<string, string | Uint8Array>,
): string {
  if (!files.has('index.html')) throw new Error('desktop renderer output omits index.html')
  const entries = [...files].sort(([left], [right]) => left.localeCompare(right)).map(([path, content]) => {
    if (path.length === 0 || path.startsWith('/') || path.includes('\\')
      || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
      throw new Error('desktop renderer output contains an invalid path')
    }
    return {
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
    }
  })
  return `${JSON.stringify({ version: 2, files: entries }, null, 2)}\n`
}

interface ClientDeclaration {
  readonly platform: string
  readonly inject?: readonly string[]
  readonly immediately?: boolean
  readonly external?: readonly string[]
}

/**
 * Resolve and hash every admitted client bundle from the application dependency graph.
 * @param anchorUrl - `import.meta.url` of the composing application config.
 * @param shellStaticModules - exact module specifiers seeded by the composing shell.
 * @returns immutable manifest and assets for Vite emission.
 */
export function buildDesktopRendererAssets(
  anchorUrl: string,
  shellStaticModules: readonly string[],
): DesktopRendererAssets {
  const require = createRequire(anchorUrl)
  const assets: DesktopClientAsset[] = []
  const entries: WebBootEntry[] = []
  const seen = new Set<string>()
  for (const id of DESKTOP_CLIENT_ALLOWLIST) {
    if (seen.has(id)) throw new Error(`desktop renderer allowlist contains duplicate ${id}`)
    seen.add(id)
    const packageJsonPath = require.resolve(`${id}/package.json`)
    const pkg = parsePackageJson(id, packageJsonPath)
    const clientExport = clientExportOf(id, pkg.exports)
    const packageRoot = dirname(packageJsonPath)
    const clientPath = resolve(packageRoot, clientExport)
    if (relative(packageRoot, clientPath).split(sep).includes('..')) {
      throw new Error(`desktop renderer rejected client export outside ${id}`)
    }
    const source = stripSourceMap(readFileSync(clientPath, 'utf8'))
    const rev = shortHash(source)
    const fileName = `plugins/${fileStem(id)}-${rev}.js`
    assets.push({ id, fileName, source, rev })
    entries.push({
      id,
      url: `${DESKTOP_RENDERER_ORIGIN}/${fileName}?rev=${rev}`,
      rev,
      ...(pkg.client.inject === undefined ? {} : { inject: [...pkg.client.inject] }),
      ...(pkg.client.immediately === true ? { immediately: true } : {}),
      ...(pkg.client.external === undefined ? {} : { external: [...pkg.client.external] }),
    })
  }
  const graph = composeDesktopBootGraph(entries, shellStaticModules)
  return {
    graph,
    assets,
    ...buildDesktopBootPrelude(graph),
  }
}

/**
 * Close and order the immutable desktop module graph.
 * @param entries - allowlisted renderer rows before module ordering.
 * @param shellStaticModules - exact shell-seeded module specifiers.
 * @returns topologically ordered graph with a content revision.
 */
export function composeDesktopBootGraph(
  entries: readonly WebBootEntry[],
  shellStaticModules: readonly string[],
): DesktopBootGraph {
  const orderedEntries = orderByModuleGraph(entries)
  assertClosedInjectionGraph(orderedEntries, shellStaticModules)
  assertClosedModuleGraph(orderedEntries, shellStaticModules)
  return { rev: shortHash(JSON.stringify(orderedEntries)), entries: orderedEntries }
}

function assertClosedInjectionGraph(
  entries: readonly WebBootEntry[],
  shellStaticModules: readonly string[],
): void {
  const services = new Set(entries.map(entry => entry.id))
  const staticModules: ReadonlySet<string> = new Set(shellStaticModules)
  const missing = new Map<string, string[]>()
  for (const entry of entries) {
    for (const service of entry.inject ?? []) {
      if (services.has(service) || !service.startsWith('@')
        || staticModules.has(service)) continue
      const consumers = missing.get(service) ?? []
      consumers.push(entry.id)
      missing.set(service, consumers)
    }
  }
  if (missing.size === 0) return
  const details = [...missing]
    .map(([service, consumers]) => `${service} required by ${consumers.join(', ')}`)
    .join('; ')
  throw new Error(`desktop renderer allowlist has unresolved package services: ${details}`)
}

function assertClosedModuleGraph(
  entries: readonly WebBootEntry[],
  shellStaticModules: readonly string[],
): void {
  const dynamicModules = new Set(entries.map(entry => entry.id))
  const staticModules = new Set(shellStaticModules)
  const missing = new Map<string, string[]>()
  for (const entry of entries) {
    for (const request of entry.external ?? []) {
      if (staticModules.has(request) || dynamicModules.has(stripClientSuffix(request))) continue
      const consumers = missing.get(request) ?? []
      consumers.push(entry.id)
      missing.set(request, consumers)
    }
  }
  if (missing.size === 0) return
  const details = [...missing]
    .map(([request, consumers]) => `${request} requested by ${consumers.join(', ')}`)
    .join('; ')
  throw new Error(`desktop renderer allowlist has unresolved module requests: ${details}`)
}

function parsePackageJson(
  id: string,
  packageJsonPath: string,
): { exports: unknown; client: ClientDeclaration } {
  const raw = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>
  const dsh = raw.dsh
  if (typeof dsh !== 'object' || dsh === null) throw new Error(`desktop renderer: ${id} has no dsh metadata`)
  const client = (dsh as Record<string, unknown>).client
  if (typeof client !== 'object' || client === null) throw new Error(`desktop renderer: ${id} has no dsh.client declaration`)
  const record = client as Record<string, unknown>
  if (record.platform !== 'web') throw new Error(`desktop renderer: ${id} is not a web client package`)
  if (record.inject !== undefined
    && (!Array.isArray(record.inject) || record.inject.some(value => typeof value !== 'string'))) {
    throw new Error(`desktop renderer: ${id} has invalid dsh.client.inject`)
  }
  if (record.immediately !== undefined && typeof record.immediately !== 'boolean') {
    throw new Error(`desktop renderer: ${id} has invalid dsh.client.immediately`)
  }
  if (record.external !== undefined
    && (!Array.isArray(record.external) || record.external.some(value => typeof value !== 'string'))) {
    throw new Error(`desktop renderer: ${id} has invalid dsh.client.external`)
  }
  return {
    exports: raw.exports,
    client: {
      platform: 'web',
      ...(record.inject === undefined ? {} : { inject: record.inject as string[] }),
      ...(record.immediately === undefined ? {} : { immediately: record.immediately }),
      ...(record.external === undefined ? {} : { external: record.external as string[] }),
    },
  }
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function findModuleEntry(html: string): number | undefined {
  return /<script\b(?=[^>]*\btype="module")[^>]*>/u.exec(html)?.index
}

function clientExportOf(id: string, exportsField: unknown): string {
  if (typeof exportsField !== 'object' || exportsField === null) {
    throw new Error(`desktop renderer: ${id} exports is not an object`)
  }
  const value = (exportsField as Record<string, unknown>)['./client']
  const path = typeof value === 'string'
    ? value
    : typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>).default
      : undefined
  if (typeof path !== 'string' || !path.startsWith('./')) {
    throw new Error(`desktop renderer: ${id} has no relative ./client default export`)
  }
  return path
}

function stripSourceMap(source: string): string {
  return source.replace(/\n?\/\/# sourceMappingURL=[^\n]*\n?$/u, '\n')
}

function shortHash(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

function fileStem(id: string): string {
  return id.replace(/^@/u, '').replaceAll('/', '-').replace(/[^A-Za-z0-9._-]/gu, '-')
}
