import { describe, expect, it } from 'vitest'
import { generateApiKey, parseApiKey } from '../src/worker/mcp/api-keys'
import { sha256Hex } from '../src/worker/lib/encoding'

describe('API key generation', () => {
  it('generates unique prefixed keys', () => {
    const a = generateApiKey()
    const b = generateApiKey()
    expect(a.startsWith('ink_')).toBe(true)
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(40)
  })

  it('parses valid keys and rejects malformed ones', () => {
    const key = generateApiKey()
    expect(parseApiKey(key)).toBe(key)
    expect(parseApiKey('not-a-key')).toBeNull()
    expect(parseApiKey(`ink_${'a'.repeat(20)}`)).toBeNull()
    expect(parseApiKey(`x${key}`)).toBeNull()
    expect(parseApiKey(`${key}extra`)).toBeNull()
    expect(parseApiKey(`ink_${'a'.repeat(200)}`)).toBeNull()
  })

  it('hashing is stable and irreversible', async () => {
    const key = generateApiKey()
    const first = await sha256Hex(key)
    const second = await sha256Hex(key)
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(first).not.toContain(key)
  })
})
