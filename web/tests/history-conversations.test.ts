import { describe, expect, it } from 'vitest'
import type { Conversation } from '@ouraihub/aether-ui/ports'

import { beginAction, loadConversation } from '../src/worker/ai/history'
import { executeRun, prepareRun, RunRequestSchema } from '../src/worker/ai/runs'

import { createHarness } from './support/ai-kit-harness'
import {
  fetchMock,
  saveProvider,
  run,
  textStream,
  ConversationDto,
} from './support/ai-kit-test-setup'

describe('run and history routes', () => {
  it(
    'rejects a run without a model before acceptance ' + 'and writes no turn',
    async () => {
      const h = await createHarness()
      const { response, text } = await run(h, {})
      expect(response.status).toBe(409)
      expect(JSON.parse(text)).toMatchObject({
        error: { code: 'needs_config', details: { reason: 'model' } },
      })
      expect(
        await h.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_chat_turns').first(
          'n',
        ),
      ).toBe(0)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('rejects skills and unknown purposes', async () => {
    const h = await createHarness()
    expect(
      JSON.parse((await run(h, { skills: [{ id: 's', revision: 1 }] })).text),
    ).toMatchObject({
      error: { code: 'unsupported', details: { reason: 'skills' } },
    })
    expect(
      JSON.parse((await run(h, { purpose: 'polish' })).text),
    ).toMatchObject({
      error: {
        code: 'bad_request',
        details: { field: 'purpose', reason: 'unsupported' },
      },
    })
  })

  it(
    'creates a conversation, continues it with histor' +
      'y, regenerates, renames and deletes',
    async () => {
      const h = await createHarness()
      const { endpointId } = await saveProvider(h)
      await h.env.DB.prepare(
        'INSERT INTO ai_roles (user_id, role, endpoint_id' +
          ", model_id) VALUES ('user-a', 'chat', ?1, 'm1')",
      )
        .bind(endpointId)
        .run()
      fetchMock.mockImplementation(async () => textStream('Hi!'))
      const first = await run(h, {
        input:
          'Line one\r\nline two that is long enough to be cut' +
          ' at forty chars',
        scope: 'global',
      })
      const conversationId = String(first.events[0]!.conversationId)
      const list = await h.json<
        {
          id: string
          title: string
          scope: string
        }[]
      >('user-a', 'GET', '/conversations?scope=global')
      expect(list.body).toMatchObject([
        {
          id: conversationId,
          title: 'Line oneline two that is long enough to ',
          scope: 'global',
        },
      ])
      expect(
        (await h.json<unknown[]>('user-a', 'GET', '/conversations?scope=other'))
          .body,
      ).toEqual([])
      await run(h, { input: 'Second', conversationId, scope: 'global' })
      const sent = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)) as {
        messages: unknown[]
      }
      expect(sent.messages.slice(1)).toEqual([
        {
          role: 'user',
          content:
            'Line one\r\nline two that is long enough to be cut' +
            ' at forty chars',
        },
        { role: 'assistant', content: 'Hi!' },
        { role: 'user', content: 'Second' },
      ])
      fetchMock.mockImplementation(async () => textStream('Again'))
      const again = await run(h, {
        input: '',
        conversationId,
        scope: 'global',
        regenerate: true,
      })
      expect(again.events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
      const loaded = await h.json<ConversationDto>(
        'user-a',
        'GET',
        `/conversations/${conversationId}`,
      )
      expect(loaded.body.turns).toMatchObject([
        {
          id: expect.any(String),
          status: 'completed',
          input:
            'Line one\r\nline two that is long enough to be cut' +
            ' at forty chars',
          text: 'Hi!',
          modelId: 'm1',
          errorCode: null,
        },
        {
          id: expect.any(String),
          status: 'completed',
          input: 'Second',
          text: 'Hi!',
          modelId: 'm1',
          errorCode: null,
        },
        {
          id: expect.any(String),
          status: 'completed',
          input: 'Second',
          text: 'Again',
          modelId: 'm1',
          errorCode: null,
        },
      ])
      expect(
        await h.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_chat_turns').first(
          'n',
        ),
      ).toBe(3)
      expect(
        (
          await h.json('user-a', 'PATCH', `/conversations/${conversationId}`, {
            title: '   ',
          })
        ).body,
      ).toMatchObject({
        error: { details: { field: 'title', reason: 'empty' } },
      })
      expect(
        (
          await h.json('user-a', 'PATCH', `/conversations/${conversationId}`, {
            title: ' Renamed ',
          })
        ).body,
      ).toMatchObject({ id: conversationId, title: 'Renamed' })
      expect(
        await h.json('user-b', 'GET', `/conversations/${conversationId}`),
      ).toMatchObject({
        status: 404,
        body: { error: { details: { entity: 'conversation' } } },
      })
      expect(
        await h.json('user-b', 'DELETE', `/conversations/${conversationId}`),
      ).toMatchObject({ status: 404 })
      expect(
        JSON.parse(
          (
            await run(
              h,
              { input: 'x', conversationId, scope: 'global' },
              'user-b',
            )
          ).text,
        ),
      ).toMatchObject({
        error: { code: 'not_found', details: { entity: 'conversation' } },
      })
      expect(
        (await h.json('user-a', 'DELETE', `/conversations/${conversationId}`))
          .body,
      ).toEqual({ ok: true })
      expect(
        await h.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_chat_turns').first(
          'n',
        ),
      ).toBe(0)
    },
  )

  it(
    'allows only one mutation from a shared snapshot ' +
      'and moves the context off a deleted selected can' +
      'didate',
    async () => {
      const h = await createHarness(),
        { endpointId } = await saveProvider(h),
        model = { endpointId, modelId: 'm1' }
      fetchMock.mockImplementation(async () => textStream('Original'))
      const first = await run(h, { model }),
        id = String(first.events[0]!.conversationId),
        sourceId = String(first.events[0]!.turnId)
      const retry = await run(h, {
          model,
          conversationId: id,
          retryTurnId: sourceId,
          input: '',
        }),
        retryId = String(retry.events[0]!.turnId)
      await h.json('user-a', 'PUT', `/conversations/${id}/selection`, {
        turnId: retryId,
      })
      const removed = await h.json<Conversation>(
        'user-a',
        'DELETE',
        `/conversations/${id}/turns/${retryId}`,
      )
      expect(removed.body.turns.map((turn) => turn.id)).toEqual([sourceId])
      expect(removed.body.summary.selectedTurnId).toBe(sourceId)
      const snapshot = await loadConversation(h.env.DB, 'user-a', id)
      const outcomes = await Promise.allSettled([
        beginAction(
          h.env.DB,
          'user-a',
          snapshot,
          null,
          'A',
          sourceId,
          null,
          false,
        ),
        beginAction(
          h.env.DB,
          'user-a',
          snapshot,
          null,
          'B',
          sourceId,
          null,
          false,
        ),
      ])
      expect(
        outcomes.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1)
      expect(
        outcomes.find((result) => result.status === 'rejected'),
      ).toMatchObject({ reason: { code: 'conflict' } })
      expect(
        (await h.json<Conversation>('user-a', 'GET', `/conversations/${id}`))
          .body.turns,
      ).toHaveLength(2)
      const running = await loadConversation(h.env.DB, 'user-a', id)
      await expect(
        beginAction(
          h.env.DB,
          'user-a',
          running,
          null,
          'C',
          sourceId,
          null,
          false,
        ),
      ).rejects.toMatchObject({
        code: 'conflict',
      })
      expect(
        await h.json('user-a', 'POST', `/conversations/${id}/fork`, {
          turnId: sourceId,
        }),
      ).toMatchObject({
        status: 409,
      })
      expect(
        await h.json('user-a', 'DELETE', `/conversations/${id}`),
      ).toMatchObject({ status: 409 })
    },
  )

  it(
    'does not emit End until the finished turn is rea' + 'dable by history',
    async () => {
      const h = await createHarness(),
        { endpointId } = await saveProvider(h)
      fetchMock.mockImplementation(async () => textStream('Stored before end'))
      const prepared = await prepareRun(
        h.env,
        'user-a',
        RunRequestSchema.parse({
          purpose: 'chat',
          model: { endpointId, modelId: 'm1' },
          skills: [],
          input: 'Q',
          regenerate: false,
          language: 'en-US',
        }),
      )
      const reached = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>(),
        db = h.env.DB
      h.env.DB = {
        prepare: db.prepare.bind(db),
        exec: db.exec.bind(db),
        batch: async (statements) => {
          reached.resolve()
          await release.promise
          return db.batch(statements)
        },
      } as D1Database
      const events: {
        kind: string
      }[] = []
      const execution = executeRun(
        h.env,
        'user-a',
        prepared,
        new AbortController().signal,
        (event) => events.push(event),
      )
      await reached.promise
      expect(events.some((event) => event.kind === 'end')).toBe(false)
      expect(
        (await loadConversation(db, 'user-a', prepared.turn!.conversationId))
          .turns[0]!.status,
      ).toBe('running')
      release.resolve()
      await execution
      expect(events.at(-1)).toMatchObject({ kind: 'end', status: 'completed' })
      expect(
        (await loadConversation(db, 'user-a', prepared.turn!.conversationId))
          .turns[0],
      ).toMatchObject({
        status: 'completed',
        messages: [{ assistant: { text: 'Stored before end' } }],
      })
    },
  )
})
