import { describe, expect, it, vi } from 'vitest'
import { openOwnedRendererStream } from '../src/renderer-stream.ts'

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

describe('renderer-owned stream opening', () => {
  it('retains a stream only after revalidating the requesting document', async () => {
    const { event, window } = rendererFixture()
    const streams = new Set<string>()
    const closeStream = vi.fn()
    const broker = { openStream: async () => '01234567-89ab-cdef', closeStream }

    await expect(openOwnedRendererStream(
      event as never,
      window as never,
      broker,
      'app://dsh-gui/api/events.host',
      streams,
    )).resolves.toBe('01234567-89ab-cdef')
    expect(streams).toEqual(new Set(['01234567-89ab-cdef']))
    expect(closeStream).not.toHaveBeenCalled()
  })

  it('closes a late stream when navigation changed the renderer owner while it opened', async () => {
    const { event, window } = rendererFixture()
    const opened = Promise.withResolvers<string>()
    const closeStream = vi.fn()
    const streams = new Set<string>()
    const operation = openOwnedRendererStream(
      event as never,
      window as never,
      { openStream: () => opened.promise, closeStream },
      'app://dsh-gui/api/events.host',
      streams,
    )

    event.senderFrame.url = 'app://dsh-gui/other.html'
    opened.resolve('01234567-89ab-cdef')

    await expect(operation).rejects.toThrow(/rejected sender document/)
    expect(closeStream).toHaveBeenCalledWith('01234567-89ab-cdef')
    expect(streams.size).toBe(0)
  })
})
