/** Closed renderer IPC operations that never reject through Electron invoke. */

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import {
  DESKTOP_PROTOCOL_VERSION,
  type DesktopProductInfo,
  type DesktopProductInfoResult,
  type DesktopStreamItem,
  type DesktopStreamOpenResult,
  type DesktopUnaryRequest,
  type DesktopUnaryResponse,
  type DesktopUpdateStatus,
} from '@acosmi/dsh-desktop-carrier-electron/protocol'
import type { DesktopUtilityBroker } from './broker.ts'
import {
  parseRendererId,
  parseRendererStreamUrl,
  parseRendererUnary,
  publicFailure,
} from './messages.ts'
import { assertTrustedSender, openOwnedRendererStream } from './renderer-stream.ts'

const UPDATE_FAILURE = 'The update check could not be completed.'

/**
 * Validate and dispatch one renderer unary request without rejecting the Electron handler.
 * @param event - invoking renderer document.
 * @param window - current application window.
 * @param broker - trusted utility-process broker.
 * @param raw - untrusted renderer payload.
 * @returns a validated Host response or an empty client-safe error response.
 */
export async function handleRendererUnary(
  event: IpcMainInvokeEvent,
  window: BrowserWindow,
  broker: Pick<DesktopUtilityBroker, 'request'>,
  raw: unknown,
): Promise<DesktopUnaryResponse> {
  let request: DesktopUnaryRequest
  try {
    assertTrustedSender(event, window)
    request = parseRendererUnary(raw)
  } catch (_rejectedRendererRequest) {
    return unaryFailure(400)
  }
  try {
    return await broker.request(request)
  } catch (_hostRequestFailure) {
    return unaryFailure(500)
  }
}

/**
 * Validate and retain one renderer stream without rejecting the Electron handler.
 * @param event - invoking renderer document.
 * @param window - current application window.
 * @param broker - trusted utility-process broker.
 * @param streams - streams owned by the current renderer document.
 * @param raw - untrusted stream URL.
 * @returns an admitted stream id or a fixed public failure.
 */
export async function handleRendererStreamOpen(
  event: IpcMainInvokeEvent,
  window: BrowserWindow,
  broker: Pick<DesktopUtilityBroker, 'openStream' | 'closeStream'>,
  streams: Set<string>,
  raw: unknown,
): Promise<DesktopStreamOpenResult> {
  let url: string
  try {
    assertTrustedSender(event, window)
    url = parseRendererStreamUrl(raw)
  } catch (_rejectedRendererStream) {
    return streamOpenFailure()
  }
  try {
    const streamId = await openOwnedRendererStream(event, window, broker, url, streams)
    return { ok: true, streamId }
  } catch (_hostStreamOpenFailure) {
    return streamOpenFailure()
  }
}

/**
 * Pull one item from a renderer-owned stream without rejecting the Electron handler.
 * @param event - invoking renderer document.
 * @param window - current application window.
 * @param broker - trusted utility-process broker.
 * @param streams - streams owned by the current renderer document.
 * @param raw - untrusted stream id.
 * @returns one validated stream item or a fixed public failure.
 */
export async function handleRendererStreamNext(
  event: IpcMainInvokeEvent,
  window: BrowserWindow,
  broker: Pick<DesktopUtilityBroker, 'nextStream' | 'closeStream'>,
  streams: Set<string>,
  raw: unknown,
): Promise<DesktopStreamItem> {
  let streamId: string
  try {
    assertTrustedSender(event, window)
    streamId = parseRendererId(raw)
    if (!streams.has(streamId)) return streamFailure()
  } catch (_rejectedRendererStream) {
    return streamFailure()
  }
  try {
    const item = await broker.nextStream(streamId)
    if (item.type === 'end' || item.type === 'error') streams.delete(streamId)
    return item
  } catch (_hostStreamFailure) {
    streams.delete(streamId)
    broker.closeStream(streamId)
    return streamFailure()
  }
}

/**
 * Read product facts for one trusted renderer without rejecting the Electron handler.
 * @param event - invoking renderer document.
 * @param window - current application window.
 * @param read - synchronous product-fact reader.
 * @returns tagged product facts or a detail-free rejection.
 */
export function handleRendererProductInfo(
  event: IpcMainInvokeEvent,
  window: BrowserWindow,
  read: () => DesktopProductInfo,
): DesktopProductInfoResult {
  try {
    assertTrustedSender(event, window)
    return { ok: true, value: read() }
  } catch (_productInfoFailure) {
    return { ok: false }
  }
}

/**
 * Run one trusted renderer update check without rejecting the Electron handler.
 * @param event - invoking renderer document.
 * @param window - current application window.
 * @param check - bounded update operation.
 * @returns update status with fixed public copy on rejection.
 */
export async function handleRendererUpdateCheck(
  event: IpcMainInvokeEvent,
  window: BrowserWindow,
  check: () => Promise<DesktopUpdateStatus>,
): Promise<DesktopUpdateStatus> {
  try {
    assertTrustedSender(event, window)
    return await check()
  } catch (_updateCheckFailure) {
    return { status: 'error', message: UPDATE_FAILURE, checkedAt: Date.now() }
  }
}

function unaryFailure(status: 400 | 500): DesktopUnaryResponse {
  return {
    version: DESKTOP_PROTOCOL_VERSION,
    status,
    headers: [],
    body: new ArrayBuffer(0),
  }
}

function streamOpenFailure(): DesktopStreamOpenResult {
  return { ok: false, message: publicFailure(undefined) }
}

function streamFailure(): DesktopStreamItem {
  return { type: 'error', message: publicFailure(undefined) }
}
