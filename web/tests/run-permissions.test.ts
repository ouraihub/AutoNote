import { describe, expect, it } from 'vitest'

import { RunRequestSchema } from '../src/worker/ai/runs'

import { createHarness } from './support/ai-kit-harness'
import {
  fetchMock,
  saveProvider,
  run,
  textStream,
} from './support/ai-kit-test-setup'

describe('run permission modes', () => {
  it(
    'defaults an omitted mode and accepts an explicit' + ' Default run',
    async () => {
      const base = {
        purpose: 'chat',
        skills: [],
        input: 'Hello',
        regenerate: false,
        language: 'en-US',
      }
      expect(RunRequestSchema.parse(base).permissionMode).toBe('default')
      const h = await createHarness()
      const { endpointId } = await saveProvider(h)
      fetchMock.mockImplementation(async () => textStream('Default reply'))
      const { events } = await run(h, {
        model: { endpointId, modelId: 'm1' },
        permissionMode: 'default',
      })
      expect(events[0]).toMatchObject({ kind: 'accepted' })
      expect(events.at(-1)).toMatchObject({ kind: 'end', status: 'completed' })
    },
  )

  it(
    'rejects unsupported modes for chat and writing b' +
      'efore accepting a run',
    async () => {
      const h = await createHarness()
      for (const purpose of ['chat', 'writing']) {
        for (const permissionMode of [
          'plan',
          'accept_edits',
          'auto',
          'full_access',
        ]) {
          const result = await run(h, { purpose, permissionMode })
          expect(result.response.status).toBe(400)
          expect(result.events).toEqual([])
          expect(JSON.parse(result.text)).toMatchObject({
            error: {
              code: 'bad_request',
              details: { field: 'permission_mode', reason: 'not_allowed' },
            },
          })
        }
      }
      expect(fetchMock).not.toHaveBeenCalled()
      expect(
        await h.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_chat_turns').first(
          'n',
        ),
      ).toBe(0)
    },
  )
})
