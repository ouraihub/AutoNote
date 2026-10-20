export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader()
  const cancel = (): void => void reader.cancel().catch(() => undefined)
  signal?.addEventListener('abort', cancel, { once: true })
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (signal?.aborted) return
      buffer = (buffer + decoder.decode(chunk.value, { stream: !chunk.done })).replaceAll('\r\n', '\n')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const lines = buffer
          .slice(0, boundary)
          .split('\n')
          .filter((line) => line.startsWith('data:'))
        buffer = buffer.slice(boundary + 2)
        if (lines.length > 0) yield lines.map((line) => line.slice(5).trimStart()).join('\n')
      }
      if (chunk.done) return
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => undefined)
  }
}
