export function extractEmbedding(result: unknown): Float32Array {
  const data = (result as { data?: unknown } | null)?.data
  if (Array.isArray(data)) {
    const first = data[0] as { embedding?: unknown } | unknown[] | undefined
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const embedding = (first as { embedding?: unknown }).embedding
      if (Array.isArray(embedding))
        return Float32Array.from(embedding as number[])
    } else if (Array.isArray(first)) return Float32Array.from(first as number[])
  }
  throw new Error('Unexpected embedding response shape')
}
