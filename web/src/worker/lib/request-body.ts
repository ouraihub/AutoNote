import { ApiError } from './errors'

export async function readTextWithinLimit(
  req: { raw?: Request; text: () => Promise<string> },
  maxBytes: number,
): Promise<string> {
  const stream = req.raw?.body
  if (!stream) {
    const text = await req.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes)
      throw ApiError.tooLarge('The request body is too large')
    return text
  }
  return new TextDecoder().decode(await readBytesWithinLimit(stream, maxBytes))
}

export async function readBytesWithinLimit(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array()
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel('payload_too_large')
        throw ApiError.tooLarge('The request body is too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
