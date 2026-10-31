import type { AttemptBudgetTarget, ThrottleTarget } from './throttle'

const DEFAULT_FREE_FAILS = 5

export function normalizeTargets(
  inputs: readonly (string | ThrottleTarget)[],
): Required<ThrottleTarget>[] {
  const unique = new Map<string, number>()
  for (const input of inputs) {
    const key = (typeof input === 'string' ? input : input.key).slice(0, 256)
    if (!key) continue
    const requested = typeof input === 'string' ? DEFAULT_FREE_FAILS : input.freeFails
    const freeFails = Math.min(100, Math.max(2, Math.trunc(requested ?? DEFAULT_FREE_FAILS)))
    const previous = unique.get(key)
    unique.set(key, previous === undefined ? freeFails : Math.min(previous, freeFails))
  }
  return [...unique].map(([key, freeFails]) => ({ key, freeFails }))
}

export function normalizeAttemptBudgets(
  inputs: readonly AttemptBudgetTarget[],
): Required<AttemptBudgetTarget>[] {
  const unique = new Map<string, Required<AttemptBudgetTarget>>()
  for (const input of inputs) {
    const key = input.key.slice(0, 256)
    if (!key) continue
    const maxAttempts = Math.min(1000, Math.max(1, Math.trunc(input.maxAttempts)))
    const windowMs = Math.min(24 * 60 * 60 * 1000, Math.max(1000, Math.trunc(input.windowMs)))
    const lockMs = Math.min(24 * 60 * 60 * 1000, Math.max(1000, Math.trunc(input.lockMs ?? windowMs)))
    const candidate = { key, maxAttempts, windowMs, lockMs }
    const previous = unique.get(key)
    if (!previous || maxAttempts < previous.maxAttempts) unique.set(key, candidate)
  }
  return [...unique.values()]
}
