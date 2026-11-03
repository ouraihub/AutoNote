import { describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@ouraihub/aether-ui/ports'
import { initializeDatabase } from '../src/worker/db/schema'
import { loadConversation } from '../src/worker/ai/history'

import { addKey, createHarness } from './support/ai-kit-harness'
import {
  KEY,
  fetchMock,
  testClock,
  saveProvider,
  run,
  textStream,
} from './support/ai-kit-test-setup'

describe('run and history routes', () => {
  it(
    'deletes any idle reply, reparents later turns, d' +
      'rops translations and moves the context to the n' +
      'ewest leaf',
    async () => {
      const h = await createHarness(),
        { endpointId } = await saveProvider(h),
        model = { endpointId, modelId: 'm1' }
      fetchMock.mockImplementation(async () => textStream('Original'))
      const first = await run(h, { model, input: 'Q1' })
      const conversationId = String(first.events[0]!.conversationId),
        aId = String(first.events[0]!.turnId),
        base = `/conversations/${conversationId}`
      const bId = String(
        (await run(h, { model, conversationId, input: 'Q2' })).events[0]!
          .turnId,
      )
      const cId = String(
        (await run(h, { model, conversationId, input: 'Q3' })).events[0]!
          .turnId,
      )
      const reparented = (
        await h.json<Conversation>('user-a', 'DELETE', `${base}/turns/${bId}`)
      ).body
      expect(reparented.turns.map((turn) => [turn.id, turn.parentId])).toEqual([
        [aId, null],
        [cId, aId],
      ])
      expect(reparented.summary.selectedTurnId).toBe(cId)
      const retryId = String(
        (await run(h, { model, conversationId, retryTurnId: cId, input: '' }))
          .events[0]!.turnId,
      )
      const candidate = (
        await h.json<Conversation>('user-a', 'DELETE', `${base}/turns/${cId}`)
      ).body
      expect(candidate.summary.selectedTurnId).toBe(retryId)
      expect(candidate.turns.at(-1)).toMatchObject({
        id: retryId,
        parentId: aId,
        supersedesId: null,
      })
      const only = (
        await h.json<Conversation>(
          'user-a',
          'DELETE',
          `${base}/turns/${retryId}`,
        )
      ).body
      expect(only.turns.map((turn) => turn.id)).toEqual([aId])
      expect(only.summary.selectedTurnId).toBe(aId)
      await run(h, {
        model,
        conversationId,
        translateTurnId: aId,
        targetLanguage: 'French',
        input: '',
      })
      expect(
        (await loadConversation(h.env.DB, 'user-a', conversationId)).turns,
      ).toHaveLength(2)
      const empty = (
        await h.json<Conversation>('user-a', 'DELETE', `${base}/turns/${aId}`)
      ).body
      expect(empty.turns).toEqual([])
      expect(empty.summary.selectedTurnId).toBeNull()
    },
  )

  it(
    'rejects failed or cancelled normal parents witho' +
      'ut writes but still retries terminal failed sour' +
      'ces',
    async () => {
      const h = await createHarness(),
        { endpointId } = await saveProvider(h),
        model = { endpointId, modelId: 'm1' }
      fetchMock.mockImplementation(async () => textStream('Original'))
      const first = await run(h, { model }),
        conversationId = String(first.events[0]!.conversationId),
        turnId = String(first.events[0]!.turnId)
      for (const status of ['failed', 'cancelled']) {
        await h.env.DB.prepare(
          'UPDATE ai_chat_turns SET status = ?1 WHERE id = ' + '?2',
        )
          .bind(status, turnId)
          .run()
        const before = await loadConversation(
          h.env.DB,
          'user-a',
          conversationId,
        )
        for (const fields of [{ replyToId: turnId }, {}]) {
          expect(
            JSON.parse(
              (
                await run(h, {
                  model,
                  conversationId,
                  input: 'Next',
                  ...fields,
                })
              ).text,
            ),
          ).toMatchObject({
            error: {
              code: 'conflict',
              details: { reason: 'turn_not_completed' },
            },
          })
          expect(
            await loadConversation(h.env.DB, 'user-a', conversationId),
          ).toEqual(before)
        }
      }
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const retried = await run(h, {
        conversationId,
        retryTurnId: turnId,
        input: '',
      })
      expect(retried.events.at(-1)).toMatchObject({
        kind: 'end',
        status: 'completed',
      })
      expect(
        (await loadConversation(h.env.DB, 'user-a', conversationId)).turns,
      ).toHaveLength(2)
      for (const status of ['failed', 'cancelled']) {
        await h.env.DB.prepare(
          'UPDATE ai_chat_turns SET status = ?1 WHERE id = ' + '?2',
        )
          .bind(status, turnId)
          .run()
        const translated = await run(h, {
          conversationId,
          translateTurnId: turnId,
          targetLanguage: 'French',
          input: '',
        })
        expect(translated.events.at(-1)).toMatchObject({
          kind: 'end',
          status: 'completed',
        })
        const prompt = JSON.parse(
          String(fetchMock.mock.calls.at(-1)![1]?.body),
        ).messages.at(-1).content
        expect(prompt).toBe(
          'Translate the following reply into French. Retur' +
            'n only the translation, preserving Markdown form' +
            'atting.\n\nOriginal',
        )
      }
      await h.env.DB.prepare(
        "UPDATE ai_chat_turns SET messages = '[]' WHERE i" + 'd = ?1',
      )
        .bind(turnId)
        .run()
      const beforeEmpty = await loadConversation(
        h.env.DB,
        'user-a',
        conversationId,
      )
      expect(
        JSON.parse(
          (
            await run(h, {
              conversationId,
              translateTurnId: turnId,
              targetLanguage: 'French',
              input: '',
            })
          ).text,
        ),
      ).toMatchObject({
        error: {
          code: 'bad_request',
          details: { field: 'translateTurnId', reason: 'empty_reply' },
        },
      })
      expect(
        await loadConversation(h.env.DB, 'user-a', conversationId),
      ).toEqual(beforeEmpty)
    },
  )

  it(
    'rejects invalid combinations, missing/cyclic/for' +
      'eign ancestry and graph fields on writing',
    async () => {
      const h = await createHarness(),
        { endpointId } = await saveProvider(h),
        model = { endpointId, modelId: 'm1' }
      fetchMock.mockImplementation(async () => textStream('ok'))
      const first = await run(h, { model }),
        foreign = await run(h, { model })
      const conversationId = String(first.events[0]!.conversationId),
        turnId = String(first.events[0]!.turnId),
        base = { model, conversationId, input: '' }
      for (const fields of [
        {
          retryTurnId: turnId,
          translateTurnId: turnId,
          targetLanguage: 'French',
        },
        { retryTurnId: turnId, regenerate: true },
        { translateTurnId: turnId, targetLanguage: 'French', regenerate: true },
        { translateTurnId: turnId },
        { translateTurnId: turnId, targetLanguage: ' ' },
        { translateTurnId: turnId, targetLanguage: 'x'.repeat(81) },
        { retryTurnId: turnId, webSearch: true },
        { retryTurnId: turnId, replyToId: turnId },
        { retryTurnId: 'x'.repeat(129) },
      ])
        expect((await run(h, { ...base, ...fields })).response.status).toBe(400)
      for (const id of ['missing', String(foreign.events[0]!.turnId)]) {
        expect(
          (await run(h, { ...base, retryTurnId: id })).response.status,
        ).toBe(404)
        expect(
          (await run(h, { ...base, replyToId: id, input: 'Next' })).response
            .status,
        ).toBe(404)
        expect(
          await h.json(
            'user-a',
            'PUT',
            `/conversations/${conversationId}/selection`,
            { turnId: id },
          ),
        ).toMatchObject({ status: 404 })
      }
      await h.env.DB.prepare(
        'UPDATE ai_chat_turns SET parent_id = id WHERE id' + ' = ?1',
      )
        .bind(turnId)
        .run()
      expect(
        (await run(h, { ...base, retryTurnId: turnId })).response.status,
      ).toBe(409)
      await h.env.DB.prepare(
        'UPDATE ai_chat_turns SET parent_id = ?1 WHERE id' + ' = ?2',
      )
        .bind(String(foreign.events[0]!.turnId), turnId)
        .run()
      expect(
        (await run(h, { ...base, retryTurnId: turnId })).response.status,
      ).toBe(404)
      vi.setSystemTime((testClock.now += 120000))
      for (const field of [
        'replyToId',
        'retryTurnId',
        'translateTurnId',
        'targetLanguage',
      ])
        expect(
          JSON.parse(
            (
              await run(h, {
                model,
                purpose: 'writing',
                input: '{}',
                [field]: null,
              })
            ).text,
          ),
        ).toMatchObject({
          error: {
            code: 'bad_request',
            details: { reason: 'writing_actions' },
          },
        })
      await h.env.DB.prepare(
        'UPDATE ai_chat_turns SET parent_id = NULL, messa' +
          'ges = ?1 WHERE id = ?2',
      )
        .bind(
          JSON.stringify([
            { assistant: { text: 'x'.repeat(100000), tool_calls: [] } },
          ]),
          turnId,
        )
        .run()
      expect(
        JSON.parse(
          (
            await run(h, {
              ...base,
              translateTurnId: turnId,
              targetLanguage: 'French',
            })
          ).text,
        ),
      ).toMatchObject({
        error: {
          code: 'bad_request',
          details: { field: 'input', reason: 'too_long', limit: 100000 },
        },
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    },
  )

  it(
    'preserves old linear data through migration and ' +
      'reloads selected ancestry after restart',
    async () => {
      const h = await createHarness(),
        { endpointId } = await saveProvider(h),
        model = { endpointId, modelId: 'm1' }
      fetchMock.mockImplementation(async () => textStream('Preserved'))
      const first = await run(h, { model, input: 'First', scope: 'global' }),
        conversationId = String(first.events[0]!.conversationId)
      await run(h, { model, conversationId, scope: 'global', input: 'Second' })
      const before = (
        await h.json<Conversation>(
          'user-a',
          'GET',
          `/conversations/${conversationId}`,
        )
      ).body
      await h.env.DB.exec(
        'DELETE FROM schema_migrations WHERE version = 17' +
          "; DELETE FROM app_meta WHERE key = 'database-sta" +
          "te-v1'",
      )
      for (const column of [
        'parent_id',
        'question_id',
        'supersedes_id',
        'kind',
      ])
        await h.env.DB.exec(`ALTER TABLE ai_chat_turns DROP COLUMN ${column}`)
      for (const column of ['selected_turn_id', 'revision'])
        await h.env.DB.exec(
          'ALTER TABLE ai_chat_conversations DROP COLUMN ' + `${column}` + '',
        )
      const old = h.env.DB
      h.env.DB = {
        prepare: old.prepare.bind(old),
        batch: old.batch.bind(old),
        exec: old.exec.bind(old),
      } as D1Database
      await initializeDatabase(h.env)
      const restored = (
        await h.json<Conversation>(
          'user-a',
          'GET',
          `/conversations/${conversationId}`,
        )
      ).body
      expect(restored).toEqual(before)
      expect(restored.turns.map((turn) => turn.parentId)).toEqual([
        null,
        restored.turns[0]!.id,
      ])
      await h.json(
        'user-a',
        'PUT',
        `/conversations/${conversationId}/selection`,
        { turnId: restored.turns[0]!.id },
      )
      const restarted = h.env.DB
      h.env.DB = {
        prepare: restarted.prepare.bind(restarted),
        batch: restarted.batch.bind(restarted),
        exec: restarted.exec.bind(restarted),
      } as D1Database
      await initializeDatabase(h.env)
      await run(h, {
        model,
        conversationId,
        scope: 'global',
        input: 'After restart',
      })
      expect(
        JSON.parse(String(fetchMock.mock.calls[2]![1]?.body)).messages.slice(1),
      ).toEqual([
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Preserved' },
        { role: 'user', content: 'After restart' },
      ])
      expect(
        (
          await h.json<Conversation>(
            'user-a',
            'GET',
            `/conversations/${conversationId}`,
          )
        ).body.turns,
      ).toHaveLength(3)
    },
  )

  it(
    'migrates a v22 single-key endpoint table to v23 ' +
      'keeping endpoints and dropping the old key',
    async () => {
      const h = await createHarness()
      const { endpointId } = await saveProvider(h)
      await h.env.DB.exec(
        'DROP TABLE ai_endpoint_keys; ALTER TABLE ai_endp' +
          'oints ADD COLUMN key_ciphertext TEXT; UPDATE ai_' +
          "endpoints SET key_ciphertext = 'legacy'; DELETE " +
          'FROM schema_migrations WHERE version IN (23, 24,' +
          " 25, 29); DELETE FROM app_meta WHERE key = 'data" +
          "base-state-v1'",
      )
      const old = h.env.DB
      h.env.DB = {
        prepare: old.prepare.bind(old),
        batch: old.batch.bind(old),
        exec: old.exec.bind(old),
      } as D1Database
      await initializeDatabase(h.env)
      const columns = (
        await h.env.DB.prepare('PRAGMA table_info(ai_endpoints)').all<{
          name: string
        }>()
      ).results.map((row) => row.name)
      expect(columns).not.toContain('key_ciphertext')
      expect(await h.json('user-a', 'GET', '/providers')).toMatchObject({
        status: 200,
        body: [
          { endpoints: [{ id: endpointId, keys: [], models: [{ id: 'm1' }] }] },
        ],
      })
      await addKey(h, 'user-a', endpointId, KEY)
    },
  )
})
