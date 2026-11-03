import { describe, expect, it } from 'vitest'

import { createHarness } from './support/ai-kit-harness'
import {
  fetchMock,
  saveProvider,
  run,
  textStream,
} from './support/ai-kit-test-setup'

describe('run and history routes', () => {
  it(
    'runs writing with note context through the writi' +
      'ng role fallback and stores nothing',
    async () => {
      const h = await createHarness()
      const { endpointId } = await saveProvider(h)
      await h.env.DB.prepare(
        'INSERT INTO ai_roles (user_id, role, endpoint_id' +
          ", model_id) VALUES ('user-a', 'chat', ?1, 'm1')",
      )
        .bind(endpointId)
        .run()
      await h.env.DB.prepare(
        'INSERT INTO notes (id, user_id, title, content, ' +
          "created_at, updated_at) VALUES ('n1', 'user-a', " +
          "' Plan ', 'Body', 0, 0)",
      ).run()
      fetchMock.mockImplementation(async () => textStream('Done'))
      const writing = {
        action: 'polish',
        noteId: 'n1',
        selectedText: 'x',
        beforeText: '',
        afterText: '',
        cursorOffset: 0,
        language: 'en-US',
        title: 'Plan',
      }
      const base = {
        purpose: 'writing',
        input: JSON.stringify(writing),
        context: { kind: 'autonote-note', id: 'n1' },
        scope: 'note:n1:writing',
      }
      const { events } = await run(h, base)
      expect(events[0]).toMatchObject({
        kind: 'accepted',
        conversationId: null,
      })
      expect(events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
      const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
        messages: {
          content: string
        }[]
      }
      expect(sent.messages[0]!.content).toContain(
        '<context source="AutoNote note n1">\n笔记《Plan》\n\nBo' +
          'dy\n</context>',
      )
      expect(
        await h.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_chat_turns').first(
          'n',
        ),
      ).toBe(0)
      expect(
        JSON.parse((await run(h, { ...base, scope: null })).text),
      ).toMatchObject({
        error: { details: { field: 'scope', reason: 'invalid_writing_scope' } },
      })
      expect(
        JSON.parse(
          (
            await run(h, {
              ...base,
              context: { kind: 'autonote-note', id: 'n2' },
            })
          ).text,
        ),
      ).toMatchObject({
        error: { code: 'not_found', details: { entity: 'note' } },
      })
    },
  )
})
