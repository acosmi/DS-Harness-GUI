import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_PROTOCOL_VERSION,
  type DesktopProductInfo,
  type DesktopUnaryRequest,
  type DesktopUnaryResponse,
} from '@acosmi/dsh-desktop-carrier-electron/protocol'
import {
  handleRendererProductInfo,
  handleRendererStreamNext,
  handleRendererStreamOpen,
  handleRendererUnary,
  handleRendererUpdateCheck,
} from '../src/renderer-ipc.ts'

const streamId = '01234567-89ab-cdef'
const publicFailure = 'The desktop Host could not complete this operation.'

function rendererFixture(): {
  event: { sender: object; senderFrame: { url: string } }
  window: { isDestroyed(): boolean; webContents: { mainFrame: { url: string } } }
} {
  const mainFrame = { url: 'app://dsh-gui/index.html' }
  const webContents = { mainFrame }
  return {
    event: { sender: webContents, senderFrame: mainFrame },
    window: { isDestroyed: () => false, webContents },
  }
}

function rendererRequest(): DesktopUnaryRequest {
  return {
    version: DESKTOP_PROTOCOL_VERSION,
    requestId: streamId,
    method: 'POST',
    url: 'app://dsh-gui/api/demo.call',
    headers: [],
    body: new ArrayBuffer(0),
  }
}

function unaryResponse(): DesktopUnaryResponse {
  return {
    version: DESKTOP_PROTOCOL_VERSION,
    status: 204,
    headers: [],
    body: new ArrayBuffer(0),
  }
}

const productInfo: DesktopProductInfo = {
  productName: 'DSH-GUI',
  displayNameZh: 'DeepSeek Harness 桌面端',
  version: '0.1.0',
  channel: 'stable',
  productCommit: 'product-commit',
  upstreamCommit: 'upstream-commit',
  sdkVersion: '2.17.0',
  electronVersion: '43.4.0',
  signing: 'development-unsigned',
  secretStorage: 'session-memory',
  updateMode: 'disabled',
  disclaimer: 'Independent distribution.',
}

describe('closed renderer IPC handlers', () => {
  it('returns structured unary responses for validation and Host failures', async () => {
    const { event, window } = rendererFixture()
    const request = vi.fn(async () => unaryResponse())
    await expect(handleRendererUnary(event as never, window as never, { request }, rendererRequest()))
      .resolves.toEqual(unaryResponse())
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ requestId: streamId }))

    await expect(handleRendererUnary(event as never, window as never, { request }, { secret: '/local/path' }))
      .resolves.toEqual({
        version: DESKTOP_PROTOCOL_VERSION,
        status: 400,
        headers: [],
        body: new ArrayBuffer(0),
      })
    expect(request).toHaveBeenCalledTimes(1)

    request.mockRejectedValueOnce(new Error('token=secret /local/path'))
    const failed = await handleRendererUnary(event as never, window as never, { request }, rendererRequest())
    expect(failed).toEqual({
      version: DESKTOP_PROTOCOL_VERSION,
      status: 500,
      headers: [],
      body: new ArrayBuffer(0),
    })
    expect(JSON.stringify(failed)).not.toMatch(/secret|local\/path/u)
  })

  it('returns tagged stream-open results and contains stream pull failures', async () => {
    const { event, window } = rendererFixture()
    const streams = new Set<string>()
    const closeStream = vi.fn()
    const openStream = vi.fn(async () => streamId)
    await expect(handleRendererStreamOpen(
      event as never,
      window as never,
      { openStream, closeStream },
      streams,
      'app://dsh-gui/api/events.host',
    )).resolves.toEqual({ ok: true, streamId })
    expect(streams).toEqual(new Set([streamId]))

    const nextStream = vi.fn().mockRejectedValueOnce(new Error('token=secret /local/path'))
    await expect(handleRendererStreamNext(
      event as never,
      window as never,
      { nextStream, closeStream },
      streams,
      streamId,
    )).resolves.toEqual({ type: 'error', message: publicFailure })
    expect(streams.size).toBe(0)
    expect(closeStream).toHaveBeenCalledWith(streamId)

    await expect(handleRendererStreamNext(
      event as never,
      window as never,
      { nextStream, closeStream },
      streams,
      'malformed',
    )).resolves.toEqual({ type: 'error', message: publicFailure })
    expect(nextStream).toHaveBeenCalledTimes(1)
  })

  it('contains stream-open rejection and closes an asynchronously orphaned stream', async () => {
    const malformed = rendererFixture()
    const malformedOpen = vi.fn(async () => streamId)
    await expect(handleRendererStreamOpen(
      malformed.event as never,
      malformed.window as never,
      { openStream: malformedOpen, closeStream: vi.fn() },
      new Set(),
      'app://dsh-gui/api/unknown',
    )).resolves.toEqual({ ok: false, message: publicFailure })
    expect(malformedOpen).not.toHaveBeenCalled()

    const late = rendererFixture()
    const opened = Promise.withResolvers<string>()
    const closeStream = vi.fn()
    const operation = handleRendererStreamOpen(
      late.event as never,
      late.window as never,
      { openStream: () => opened.promise, closeStream },
      new Set(),
      'app://dsh-gui/api/events.mux',
    )
    late.event.senderFrame.url = 'app://dsh-gui/other.html'
    opened.resolve(streamId)
    await expect(operation).resolves.toEqual({ ok: false, message: publicFailure })
    expect(closeStream).toHaveBeenCalledWith(streamId)
  })

  it('tags product facts and update failures without exposing thrown details', async () => {
    const { event, window } = rendererFixture()
    expect(handleRendererProductInfo(event as never, window as never, () => productInfo))
      .toEqual({ ok: true, value: productInfo })
    expect(handleRendererProductInfo(event as never, window as never, () => {
      throw new Error('token=secret /local/path')
    })).toEqual({ ok: false })

    await expect(handleRendererUpdateCheck(event as never, window as never, async () => {
      throw new Error('token=secret /local/path')
    })).resolves.toMatchObject({
      status: 'error',
      message: 'The update check could not be completed.',
      checkedAt: expect.any(Number),
    })
  })
})
