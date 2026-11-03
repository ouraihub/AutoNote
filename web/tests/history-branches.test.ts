import { describe, expect, it } from 'vitest'
import type { Conversation } from '@ouraihub/aether-ui/ports'

import { chatModel, createHarness } from './support/ai-kit-harness'
import {
  fetchMock,
  saveProvider,
  run,
  textStream,
} from './support/ai-kit-test-setup'

describe('run and history routes', () => {
  it(
    'preserves candidates, chosen ancestry, source mo' +
      'del, translation chains and exact branch copies',
    async () => {
      const h = await createHarness(),
        original = await saveProvider(h),
        alternate = await saveProvider(h)
      const model = { endpointId: original.endpointId, modelId: 'm1' },
        otherModel = { endpointId: alternate.endpointId, modelId: 'm2' }
      await h.json('user-a', 'PUT', '/providers', {
        id: alternate.providerId,
        name: 'Acme',
        endpoints: [
          {
            id: alternate.endpointId,
            slug: 'main',
            baseUrl: 'https://api.example.com',
            protocol: 'openai-chat',
            models: [chatModel('m1'), chatModel('m2')],
          },
        ],
      })
      await h.env.DB.prepare(
        'INSERT INTO ai_roles (user_id, role, endpoint_id' +
          ", model_id) VALUES ('user-a', 'chat', ?1, 'm1')",
      )
        .bind(alternate.endpointId)
        .run()
      fetchMock.mockImplementation(async () => textStream('Original'))
      const first = await run(h, { model, input: 'Question', scope: 'global' })
      const conversationId = String(first.events[0]!.conversationId),
        sourceId = String(first.events[0]!.turnId)
      fetchMock.mockImplementation(async () => textStream('Alternative'))
      const retried = await run(h, {
        conversationId,
        scope: 'global',
        retryTurnId: sourceId,
        input: 'ignored',
      })
      const retryId = String(retried.events[0]!.turnId)
      let loaded = (
        await h.json<Conversation>(
          'user-a',
          'GET',
          `/conversations/${conversationId}`,
        )
      ).body
      expect(loaded.summary.selectedTurnId).toBe(sourceId)
      expect(loaded.turns).toMatchObject([
        {
          id: sourceId,
          parentId: null,
          questionId: sourceId,
          supersedesId: null,
          kind: 'reply',
          text: 'Original',
          endpointId: model.endpointId,
        },
        {
          id: retryId,
          parentId: null,
          questionId: sourceId,
          supersedesId: sourceId,
          kind: 'reply',
          input: 'Question',
          text: 'Alternative',
          endpointId: model.endpointId,
        },
      ])
      expect(
        JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)).messages.slice(1),
      ).toEqual([{ role: 'user', content: 'Question' }])
      const selected = await h.json<Conversation>(
        'user-a',
        'PUT',
        `/conversations/${conversationId}/selection`,
        {
          turnId: retryId,
        },
      )
      expect(selected.body.summary).toMatchObject({
        id: conversationId,
        selectedTurnId: retryId,
      })
      fetchMock.mockImplementation(async () => textStream('Next'))
      const next = await run(h, {
        model,
        conversationId,
        scope: 'global',
        input: 'Next question',
      })
      const nextId = String(next.events[0]!.turnId)
      expect(
        JSON.parse(String(fetchMock.mock.calls[2]![1]?.body)).messages.slice(1),
      ).toEqual([
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Alternative' },
        { role: 'user', content: 'Next question' },
      ])
      const swapped = await run(h, {
        model: otherModel,
        conversationId,
        scope: 'global',
        retryTurnId: nextId,
        input: '',
      })
      const swappedId = String(swapped.events[0]!.turnId)
      loaded = (
        await h.json<Conversation>(
          'user-a',
          'GET',
          `/conversations/${conversationId}`,
        )
      ).body
      expect(loaded.turns.at(-1)).toMatchObject({
        endpointId: alternate.endpointId,
        modelId: 'm2',
        questionId: nextId,
        supersedesId: nextId,
        parentId: retryId,
      })
      expect(loaded.summary.selectedTurnId).toBe(nextId)
      fetchMock.mockImplementation(async () => textStream('Traduit'))
      const translated = await run(h, {
        conversationId,
        scope: 'global',
        translateTurnId: swappedId,
        targetLanguage: ' French ',
        input: '',
      })
      const translatedId = String(translated.events[0]!.turnId)
      loaded = (
        await h.json<Conversation>(
          'user-a',
          'GET',
          `/conversations/${conversationId}`,
        )
      ).body
      const instruction =
        'Translate the following reply into French. Retur' +
        'n only the translation, preserving Markdown form' +
        'atting.\n\nNext'
      expect(loaded.turns.at(-1)).toMatchObject({
        id: translatedId,
        parentId: swappedId,
        questionId: translatedId,
        kind: 'translation',
        input: instruction,
        endpointId: alternate.endpointId,
      })
      const translatedPrompt = JSON.parse(
        String(fetchMock.mock.calls[4]![1]?.body),
      ).messages
      expect(translatedPrompt[0]).toMatchObject({
        role: 'system',
        content: expect.stringContaining("AutoNote's note assistant"),
      })
      expect(translatedPrompt.slice(1)).toEqual([
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Alternative' },
        { role: 'user', content: 'Next question' },
        { role: 'assistant', content: 'Next' },
        { role: 'user', content: instruction },
      ])
      const forked = await h.json<Conversation>(
        'user-a',
        'POST',
        `/conversations/${conversationId}/fork`,
        {
          turnId: translatedId,
        },
      )
      expect(forked.body.summary.id).not.toBe(conversationId)
      expect(forked.body.summary.scope).toBe('global')
      expect(forked.body.turns.map((turn) => turn.text)).toEqual([
        'Alternative',
        'Next',
        'Traduit',
      ])
      expect(
        forked.body.turns.every(
          (turn) =>
            !loaded.turns.some(
              (source) =>
                source.id === turn.id || source.questionId === turn.questionId,
            ),
        ),
      ).toBe(true)
      expect(forked.body.turns.map((turn) => turn.parentId)).toEqual([
        null,
        forked.body.turns[0]!.id,
        forked.body.turns[1]!.id,
      ])
      expect(forked.body.summary.selectedTurnId).toBe(forked.body.turns[2]!.id)
      expect(
        forked.body.turns.every((turn) => turn.supersedesId === null),
      ).toBe(true)
      const translatedRetry = await run(h, {
        conversationId,
        scope: 'global',
        retryTurnId: translatedId,
        input: '',
      })
      const afterTranslationRetry = (
        await h.json<Conversation>(
          'user-a',
          'GET',
          `/conversations/${conversationId}`,
        )
      ).body
      expect(afterTranslationRetry.turns.at(-1)).toMatchObject({
        id: String(translatedRetry.events[0]!.turnId),
        kind: 'translation',
        questionId: translatedId,
        parentId: swappedId,
        supersedesId: translatedId,
        input: instruction,
      })
      expect(afterTranslationRetry.summary.selectedTurnId).toBe(translatedId)
      await h.json('user-a', 'DELETE', `/providers/${original.providerId}`)
      expect(
        JSON.parse(
          (
            await run(h, {
              conversationId,
              scope: 'global',
              retryTurnId: sourceId,
              input: '',
            })
          ).text,
        ),
      ).toMatchObject({ error: { code: 'needs_config' } })
      expect(
        (
          await run(h, {
            model: otherModel,
            conversationId,
            scope: 'global',
            retryTurnId: sourceId,
            input: '',
          })
        ).events.at(-1),
      ).toMatchObject({ status: 'completed' })
    },
  )

  it(
    'guards edit CAS, dependents, selection, running ' +
      'sources and cross-user access without falsifying' +
      ' usage',
    async () => {
      const h = await createHarness(),
        { endpointId } = await saveProvider(h),
        model = { endpointId, modelId: 'm1' }
      fetchMock.mockImplementation(async () => textStream('Original'))
      const first = await run(h, { model, input: 'Question' })
      const conversationId = String(first.events[0]!.conversationId),
        sourceId = String(first.events[0]!.turnId)
      const retry = await run(h, {
        model,
        conversationId,
        retryTurnId: sourceId,
        input: '',
      })
      const retryId = String(retry.events[0]!.turnId),
        base = `/conversations/${conversationId}`
      for (const [method, path, body] of [
        [
          'PATCH',
          `${base}/turns/${retryId}`,
          { text: 'Edited', expectedText: 'Original' },
        ],
        ['DELETE', `${base}/turns/${retryId}`, undefined],
        ['POST', `${base}/fork`, { turnId: retryId }],
        ['PUT', `${base}/selection`, { turnId: retryId }],
      ] as const)
        expect(await h.json('user-b', method, path, body)).toMatchObject({
          status: 404,
        })
      expect(
        await h.json('user-a', 'PATCH', `${base}/turns/${sourceId}`, {
          text: 'x',
          expectedText: 'Original',
        }),
      ).toMatchObject({ status: 409 })
      expect(
        await h.json('user-a', 'PATCH', `${base}/turns/${retryId}`, {
          text: 'x',
          expectedText: 'outdated',
        }),
      ).toMatchObject({ status: 409 })
      for (const text of [' ', 'x'.repeat(24001)])
        expect(
          await h.json('user-a', 'PATCH', `${base}/turns/${retryId}`, {
            text,
            expectedText: 'Original',
          }),
        ).toMatchObject({ status: 400 })
      await h.env.DB.prepare(
        "UPDATE ai_chat_turns SET reasoning_text = 'Reaso" +
          "n', messages = ?1 WHERE id = ?2",
      )
        .bind(
          JSON.stringify([
            {
              assistant: {
                text: 'Original',
                tool_calls: [],
                reasoning: [
                  {
                    protocol: 'openai-chat',
                    endpointId,
                    modelId: 'm1',
                    value: 'Reason',
                  },
                ],
              },
            },
          ]),
          retryId,
        )
        .run()
      const edited = await h.json<Conversation>(
        'user-a',
        'PATCH',
        `${base}/turns/${retryId}`,
        {
          text: '**Edited**',
          expectedText: 'Original',
        },
      )
      expect(edited.body.turns.at(-1)).toMatchObject({
        text: '**Edited**',
        usage: { inputTokens: 3, outputTokens: 2 },
        contextUsage: null,
        reasoningText: '',
        modelId: 'm1',
        input: 'Question',
      })
      expect(
        await h.env.DB.prepare(
          'SELECT messages FROM ai_chat_turns WHERE id = ?1',
        )
          .bind(retryId)
          .first('messages'),
      ).toBe(
        JSON.stringify([{ assistant: { text: '**Edited**', tool_calls: [] } }]),
      )
      expect(
        await h.json('user-a', 'PATCH', `${base}/turns/${retryId}`, {
          text: 'x',
          expectedText: 'Original',
        }),
      ).toMatchObject({ status: 409 })
      const removed = await h.json<Conversation>(
        'user-a',
        'DELETE',
        `${base}/turns/${retryId}`,
      )
      expect(removed.body.turns.map((turn) => turn.id)).toEqual([sourceId])
      const child = await run(h, { model, conversationId, input: 'Child' })
      const childId = String(child.events[0]!.turnId)
      await h.env.DB.prepare(
        "UPDATE ai_chat_turns SET status = 'running' WHER" + 'E id = ?1',
      )
        .bind(sourceId)
        .run()
      for (const [method, path, body] of [
        [
          'PATCH',
          `${base}/turns/${childId}`,
          { text: 'x', expectedText: 'Original' },
        ],
        ['DELETE', `${base}/turns/${childId}`, undefined],
        ['POST', `${base}/fork`, { turnId: childId }],
        ['PUT', `${base}/selection`, { turnId: childId }],
      ] as const)
        expect(await h.json('user-a', method, path, body)).toMatchObject({
          status: 409,
        })
    },
  )
})
