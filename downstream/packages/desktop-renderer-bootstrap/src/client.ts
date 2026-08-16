/** Sandboxed renderer bootstrap for the immutable desktop plugin graph. */

import { createElectronConnectionCarrier } from '@acosmi/dsh-desktop-carrier-electron/client'
import { isDesktopRendererUrl } from '@acosmi/dsh-desktop-carrier-electron/protocol'
import { installConnectionCarrier } from '@deepseek-ai/dsh-client-connection/carrier'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

/** Mounted desktop renderer and its deterministic teardown. */
export interface DesktopRendererMount {
  dispose(): void
}

/**
 * Mount the upstream Web shell over the Electron carrier and fixed graph.
 * @param root - application root element.
 * @param graph - build-time generated client graph.
 * @returns mounted shell disposer after boot settles or renders its failure page.
 */
export async function mountDesktopRenderer(
  root: HTMLElement,
  graph: WebBootGraph,
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
    dispose() {
      entry.dispose()
      uninstallCarrier()
      delete target.__DSH_BOOT__
    },
  }
}

/**
 * Validate the immutable renderer graph before exposing it to upstream code.
 * @param graph - build-time generated client graph.
 */
export function validateDesktopGraph(graph: WebBootGraph): void {
  if (graph.entries.length === 0) throw new Error('desktop renderer graph is empty')
  const ids = new Set<string>()
  for (const entry of graph.entries) {
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
