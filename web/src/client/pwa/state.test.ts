import { expect, test } from 'vitest'
import { PwaState } from './state.svelte'

const logger = { debug() {}, info() {}, warn() {}, error() {} }

test('does not flush or update without a waiting worker', async () => {
  let flushed = false
  const pwa = new PwaState({
    logger,
    flush: async () => {
      flushed = true
      return { pending: 0, failed: 0 }
    },
  })
  await pwa.applyUpdate()
  expect(flushed).toBe(false)
  pwa.dispose()
})
