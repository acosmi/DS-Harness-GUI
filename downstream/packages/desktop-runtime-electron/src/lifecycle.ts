/** Pure teardown policy for Electron window and Host-lifetime callbacks. */

/** Action taken when macOS sends `activate` after Dock click or reopen. */
export type DesktopActivateAction = 'ignore' | 'show' | 'open'

/**
 * Decide what `activate` may do once quit or Host teardown has started.
 * @param stopping - true after `before-quit` or an unrecoverable Host failure.
 * @param windowLive - true when a `BrowserWindow` exists and is not destroyed.
 * @returns ignore during teardown, show a live window, or open a replacement.
 */
export function desktopActivateAction(stopping: boolean, windowLive: boolean): DesktopActivateAction {
  if (stopping) return 'ignore'
  if (windowLive) return 'show'
  return 'open'
}

/**
 * Whether a second-instance event may focus the existing window.
 * Recreating a window from this path is never allowed.
 * @param stopping - true after teardown has started.
 * @param windowLive - true when a `BrowserWindow` exists and is not destroyed.
 * @returns true only for a live window outside teardown.
 */
export function canFocusExistingWindow(stopping: boolean, windowLive: boolean): boolean {
  return !stopping && windowLive
}

/**
 * Whether an unexpected renderer crash should prompt the user to restart.
 * @param stopping - true after teardown has started.
 * @param reason - Electron `render-process-gone` reason.
 * @returns false during teardown and for a clean renderer exit.
 */
export function shouldPromptRendererRestart(stopping: boolean, reason: string): boolean {
  return !stopping && reason !== 'clean-exit'
}
