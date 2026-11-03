import { describe, expect, it } from 'vitest'

import { inferModel } from '@ouraihub/aether-core/providers'

import { fixture } from './support/ai-kit-harness'

describe('model inference', () => {
  it('matches every fixture entry', () => {
    const cases = JSON.parse(fixture('model-classify.json').toString()) as ({
      id: string
    } & Record<string, unknown>)[]
    expect(cases.length).toBeGreaterThanOrEqual(30)
    for (const { id, ...rest } of cases)
      expect(inferModel(id), id).toEqual(rest)
  })
})
