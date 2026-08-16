/** Sandboxed preload exposing the exact versioned desktop bridge. */

import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_PROTOCOL_VERSION,
  type DesktopPreloadBridge,
  type DesktopProductInfoResult,
  type DesktopStreamItem,
  type DesktopStreamOpenResult,
  type DesktopUnaryRequest,
  type DesktopUnaryResponse,
  type DesktopUpdateStatus,
} from '@acosmi/dsh-desktop-carrier-electron/protocol'
import { IPC } from './messages.ts'

/** Install the frozen renderer API. */
export function installDesktopPreload(): void {
  const bridge: DesktopPreloadBridge = Object.freeze({
    version: DESKTOP_PROTOCOL_VERSION,
    request: (request: DesktopUnaryRequest) => (
      ipcRenderer.invoke(IPC.request, request) as Promise<DesktopUnaryResponse>
    ),
    cancel(requestId: string) { ipcRenderer.send(IPC.cancel, requestId) },
    openStream: (url: string) => (
      ipcRenderer.invoke(IPC.streamOpen, url) as Promise<DesktopStreamOpenResult>
    ),
    nextStream: (streamId: string) => (
      ipcRenderer.invoke(IPC.streamNext, streamId) as Promise<DesktopStreamItem>
    ),
    closeStream(streamId: string) { ipcRenderer.send(IPC.streamClose, streamId) },
    productInfo: () => ipcRenderer.invoke(IPC.productInfo) as Promise<DesktopProductInfoResult>,
    checkForUpdates: () => ipcRenderer.invoke(IPC.checkForUpdates) as Promise<DesktopUpdateStatus>,
  })
  contextBridge.exposeInMainWorld('dshDesktop', bridge)
}
