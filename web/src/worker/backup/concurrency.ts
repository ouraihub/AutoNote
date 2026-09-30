
export async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!items.length) return

  let next = 0
  let stopped = false
  const worker = async () => {
    while (!stopped) {
      const index = next++
      if (index >= items.length) return
      try {
        await run(items[index]!, index)
      } catch (err) {
        stopped = true
        throw err
      }
    }
  }

  const count = Math.min(items.length, Math.max(1, Math.floor(concurrency)))


  const outcomes = await Promise.allSettled(Array.from({ length: count }, worker))
  const failed = outcomes.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  )
  if (failed) throw failed.reason
}
