/** Renderer ownership checks for streams whose utility open completes asynchronously. */

import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { isDesktopRendererUrl } from '@acosmi/dsh-desktop-carrier-electron/protocol'
import type { DesktopUtilityBroker } from './broker.ts'

/**
 * Retain a utility stream only if the requesting renderer still owns the IPC document.
 * @param event - original renderer invocation.
 * @param window - window that admitted the invocation.
 * @param broker - utility-process stream owner.
 * @param url - already validated Host stream URL.
 * @param streams - stream identifiers retained for the current renderer document.
 * @returns the retained stream identifier.
 */
export async function openOwnedRendererStream(
  event: IpcMainInvokeEvent,
  window: BrowserWindow,
  broker: Pick<DesktopUtilityBroker, 'openStream' | 'closeStream'>,
  url: string,
  streams: Set<string>,
): Promise<string> {
  const streamId = await broker.openStream(url)
  try {
    assertTrustedSender(event, window)
    streams.add(streamId)
    return streamId
  } catch (error) {
    broker.closeStream(streamId)
    throw error
  }
}

/**
 * Reject an IPC effect unless it belongs to the current top-level application document.
 * @param event - renderer IPC event whose live document owns the effect.
 * @param window - current application window.
 */
export function assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent, window: BrowserWindow): void {
  if (window.isDestroyed() || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('desktop IPC rejected sender')
  }
  let senderUrl: URL
  try {
    senderUrl = new URL(event.senderFrame.url)
  } catch {
    throw new Error('desktop IPC rejected sender URL')
  }
  if (!isDesktopRendererUrl(senderUrl) || senderUrl.pathname !== '/index.html'
    || senderUrl.search !== '' || senderUrl.hash !== '') {
    throw new Error('desktop IPC rejected sender document')
  }
}
