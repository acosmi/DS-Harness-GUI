import { describe, expect, it, vi } from 'vitest'
import { readBoundedResponseBody } from '../src/body.ts'

describe('bounded desktop response body', () => {
  it('returns the exact chunks within the byte limit', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.enqueue(new Uint8Array([3]))
        controller.close()
      },
    })
    const result = await readBoundedResponseBody(new Response(body), 3)
    expect([...new Uint8Array(result)]).toEqual([1, 2, 3])
  })

  it('cancels a chunked response when it crosses the byte limit', async () => {
    const cancel = vi.fn()
    let pull = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(pull === 0 ? 3 : 1))
        pull += 1
      },
      cancel,
    })
    await expect(readBoundedResponseBody(new Response(body), 3)).rejects.toThrow(/too large/)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('accepts a response without a body', async () => {
    await expect(readBoundedResponseBody(new Response(null), 1)).resolves.toEqual(new ArrayBuffer(0))
  })
})
