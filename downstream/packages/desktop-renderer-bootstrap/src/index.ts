/** Build-time generation of the immutable DSH-GUI renderer plugin graph. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import { DESKTOP_RENDERER_ORIGIN } from '@acosmi/dsh-desktop-carrier-electron/protocol'

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
export interface DesktopBootGraph {
  readonly rev: string
  readonly entries: readonly DesktopBootEntry[]
}

/** One renderer plugin row. */
export interface DesktopBootEntry {
  readonly id: string
  readonly url: string
  readonly rev: string
  readonly inject?: readonly string[]
  readonly immediately?: boolean
}

/** Complete build-time renderer payload. */
export interface DesktopRendererAssets {
  readonly graph: DesktopBootGraph
  readonly assets: readonly DesktopClientAsset[]
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
  const entries: DesktopBootEntry[] = []
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
    })
  }
  assertClosedInjectionGraph(entries, shellStaticModules)
  return {
    graph: { rev: shortHash(JSON.stringify(entries)), entries },
    assets,
  }
}

function assertClosedInjectionGraph(
  entries: readonly DesktopBootEntry[],
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
  return {
    exports: raw.exports,
    client: {
      platform: 'web',
      ...(record.inject === undefined ? {} : { inject: record.inject as string[] }),
      ...(record.immediately === undefined ? {} : { immediately: record.immediately }),
    },
  }
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

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

function fileStem(id: string): string {
  return id.replace(/^@/u, '').replaceAll('/', '-').replace(/[^A-Za-z0-9._-]/gu, '-')
}
