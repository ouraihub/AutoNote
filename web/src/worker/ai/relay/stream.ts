import { BUSY_RETRY_SECONDS, relayError } from './shared'

const inFlight = new Map<string, number>()

export function acquire(keyId: string, maxConcurrent: number): Response | null {
  const running = inFlight.get(keyId) ?? 0
  if (running >= maxConcurrent)
    return relayError(
      429,
      'rate_limit_error',
      'at most ' +
        `${maxConcurrent}` +
        ' concurrent requests per access key; retry shortly',
      { 'retry-after': BUSY_RETRY_SECONDS },
    )
  inFlight.set(keyId, running + 1)
  return null
}

export function release(keyId: string): void {
  inFlight.set(keyId, Math.max(0, (inFlight.get(keyId) ?? 1) - 1))
}
