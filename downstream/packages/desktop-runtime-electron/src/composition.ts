/** Product-owned additions applied after the upstream desktop profile patches. */

import { isAbsolute } from 'node:path'

/** Exact Loader patch that mounts the read-only preset roster shipped in resources. */
export interface DesktopPresetPatch {
  readonly id: 'agent-presets'
  readonly config: {
    readonly default: 'standard'
    readonly roots: readonly [{ readonly path: string; readonly trust: 'system' }]
  }
}

/**
 * Bind the packaged preset tree as the sole system preset root.
 * @param presetRoot - absolute path to the application-owned preset resources.
 * @returns Loader patch appended after the upstream and channel patches.
 */
export function desktopPresetPatch(presetRoot: string): DesktopPresetPatch {
  if (!isAbsolute(presetRoot)) throw new Error('desktop preset root must be absolute')
  return {
    id: 'agent-presets',
    config: {
      default: 'standard',
      roots: [{ path: presetRoot, trust: 'system' }],
    },
  }
}
