/** Sandboxed renderer bootstrap for the immutable desktop plugin graph. */

import { createElectronConnectionCarrier } from '@acosmi/dsh-desktop-carrier-electron/client'
import { isDesktopRendererUrl } from '@acosmi/dsh-desktop-carrier-electron/protocol'
import { installConnectionCarrier } from '@deepseek-ai/dsh-client-connection/carrier'
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

/** Mounted desktop renderer and its deterministic teardown. */
export interface DesktopRendererMount {
  dispose(): Promise<void>
}

/**
 * Mount the upstream Web shell over the Electron carrier and fixed graph.
 * @param root - application root element.
 * @param graph - build-time generated client graph.
 * @returns mounted shell disposer after boot settles or renders its failure page.
 */
export async function mountDesktopRenderer(
  root: HTMLElement,
  graph: unknown,
): Promise<DesktopRendererMount> {
  validateDesktopGraph(graph)
  const target = globalThis as typeof globalThis & { __DSH_BOOT__?: unknown }
  if (target.__DSH_BOOT__ !== undefined) throw new Error('desktop renderer boot graph is already installed')
  target.__DSH_BOOT__ = graph
  const uninstallCarrier = installConnectionCarrier(createElectronConnectionCarrier())
  const entry = new AppWebEntry(root)
  try {
    await entry.run()
  } catch (error) {
    uninstallCarrier()
    delete target.__DSH_BOOT__
    throw error
  }
  return {
    async dispose() {
      try {
        await entry.dispose()
      } finally {
        uninstallCarrier()
        delete target.__DSH_BOOT__
      }
    },
  }
}

/**
 * Validate executable desktop bundle rows before exposing the raw graph to the upstream parser.
 * @param graph - raw build-time generated client graph.
 */
export function validateDesktopGraph(graph: unknown): void {
  if (typeof graph !== 'object' || graph === null) {
    throw new Error('desktop renderer graph is missing')
  }
  const wire = graph as Record<string, unknown>
  if (!Array.isArray(wire.entries)) throw new Error('desktop renderer graph entries are missing')
  if (wire.entries.length === 0) throw new Error('desktop renderer graph is empty')
  const ids = new Set<string>()
  for (const value of wire.entries as unknown[]) {
    if (typeof value !== 'object' || value === null) {
      throw new Error('desktop renderer graph entry is not an object')
    }
    const entry = value as Record<string, unknown>
    if (typeof entry.id !== 'string' || typeof entry.url !== 'string'
      || typeof entry.rev !== 'string') {
      throw new Error('desktop renderer graph entry must carry string id/url/rev')
    }
    if (ids.has(entry.id)) throw new Error(`desktop renderer graph contains duplicate ${entry.id}`)
    ids.add(entry.id)
    const url = new URL(entry.url)
    if (!isDesktopRendererUrl(url) || !url.pathname.startsWith('/plugins/') || url.hash !== '') {
      throw new Error('desktop renderer rejected bundle URL')
    }
    if (!/^[0-9a-f]{16}$/.test(entry.rev) || url.search !== `?rev=${entry.rev}`) {
      throw new Error(`desktop renderer rejected revision for ${entry.id}`)
    }
  }
}
