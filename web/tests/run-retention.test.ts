import { describe, expect, it, vi } from 'vitest'

import {
  getRunSnapshot,
  prepareRun,
  RunRequestSchema,
  saveRunSnapshot,
} from '../src/worker/ai/runs'

import { createHarness } from './support/ai-kit-harness'
import { testClock, saveProvider } from './support/ai-kit-test-setup'

describe('run snapshot retention', () => {
  it('prunes only finished runs, never an older active' + ' one', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    const prepared = await prepareRun(
      h.env,
      'user-a',
      RunRequestSchema.parse({
        purpose: 'chat',
        model: { endpointId, modelId: 'm1' },
        input: 'Hi',
        skills: [],
        regenerate: false,
        language: 'en-US',
      }),
    )
    const run = (runId: string) => ({ ...prepared, runId })
    await saveRunSnapshot(h.env, 'user-a', run('0000000000-active'))
    for (let i = 0; i < 205; i++) {
      vi.setSystemTime(testClock.now + i)
      await saveRunSnapshot(
        h.env,
        'user-a',
        run(`finished-${String(204 - i).padStart(3, '0')}`),
        { kind: 'end', status: 'completed' },
      )
    }
    await expect(
      getRunSnapshot(h.env, 'user-a', '0000000000-active'),
    ).resolves.toMatchObject({ status: 'running' })
    const latest = await getRunSnapshot(h.env, 'user-a', 'finished-000')
    expect(latest.status).toBe('completed')
    expect(latest).not.toHaveProperty('completedAt')
    await expect(
      getRunSnapshot(h.env, 'user-a', 'finished-200'),
    ).rejects.toMatchObject({ code: 'not_found' })
    const { count } = (await h.env.DB.prepare(
      'SELECT COUNT(*) AS count FROM app_meta WHERE key' +
        " LIKE 'ai-run:user-a:%'",
    ).first<{
      count: number
    }>())!
    expect(count).toBe(201)
  })
})
