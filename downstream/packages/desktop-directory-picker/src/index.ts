/** Native directory-picker provider over the Electron main-process dialog bridge. */

import type { Context } from '@deepseek-ai/cordis'
import {
  DirectoryPicker,
  type DirectoryPickerNativeCapability,
} from '@deepseek-ai/dsh-host-directory-picker'

/** Utility-process view of the trusted main-process directory chooser. */
export interface DesktopDirectoryPickerBridge {
  /**
   * Request one native directory choice.
   * @param signal - caller lifetime; abort closes or abandons the dialog request.
   * @returns a canonical absolute directory or `null` when cancelled.
   */
  pick(signal: AbortSignal): Promise<string | null>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Main-process native directory dialog available to the desktop Host. */
    desktopDirectoryPicker: DesktopDirectoryPickerBridge
  }
}

/** Provide the main-process dialog bridge before the plugin tree mounts. */
export function provideDesktopDirectoryPicker(ctx: Context, bridge: DesktopDirectoryPickerBridge): void {
  ctx.provide('desktopDirectoryPicker', bridge)
}

/** Desktop-native implementation of the Harness directory-picker seam. */
export class DesktopDirectoryPicker extends DirectoryPicker {
  static inject = ['desktopDirectoryPicker']

  private readonly native: DirectoryPickerNativeCapability = {
    kind: 'native',
    pick: signal => this.ctx.desktopDirectoryPicker.pick(signal),
  }

  /** @param ctx - utility-process context carrying the dialog bridge. */
  constructor(ctx: Context) {
    super(ctx)
  }

  /** Return the stable native-picker capability. */
  capability(): DirectoryPickerNativeCapability {
    return this.native
  }
}

/** Install the native directory-picker provider. */
export function apply(ctx: Context): void {
  new DesktopDirectoryPicker(ctx)
}
