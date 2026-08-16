/** Bounded response-body reads for the utility-to-main IPC boundary. */

/**
 * Read one response body without buffering beyond the IPC byte limit.
 * @param response - response produced by the local Harness fetch surface.
 * @param limit - maximum accepted body bytes.
 * @returns exact response bytes in a detached ArrayBuffer.
 */
export async function readBoundedResponseBody(response: Response, limit: number): Promise<ArrayBuffer> {
  if (response.body === null) return new ArrayBuffer(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      total += item.value.byteLength
      if (total > limit) {
        try {
          await reader.cancel()
        } catch (_transportCancellationFailure) {
          // The size violation remains authoritative after the stream has already failed closed.
        }
        throw new Error('desktop Host response is too large')
      }
      chunks.push(item.value)
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output.buffer
}
