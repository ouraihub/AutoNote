import { readFileSync } from 'node:fs'
import { createServer, request as httpsRequest } from 'node:https'
import { describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@ouraihub/aether-ui/ports'

import { chatModel, createHarness } from './support/ai-kit-harness'
import {
  fetchMock,
  saveProvider,
  run,
  textStream,
  ConversationDto,
} from './support/ai-kit-test-setup'

describe('run and history routes', () => {
  it(
    'drops note payload on first and continuing chat ' +
      'in actual loopback requests without losing histo' +
      'ry',
    async () => {
      const h = await createHarness()
      const marker = 'CURRENT-NOTE-BODY-NOT-IN-DROPPED-REQUEST'
      await h.env.DB.prepare(
        'INSERT INTO notes (id, user_id, title, content, ' +
          "created_at, updated_at) VALUES ('n1', 'user-a', " +
          "'Plan', ?1, 0, 0)",
      )
        .bind(marker)
        .run()
      await h.env.DB.prepare(
        'INSERT OR REPLACE INTO app_meta (key, value) VAL' +
          "UES ('setting:ai_allow_private', '1')",
      ).run()
      const cert = readFileSync(
        new URL('./support/ai-loopback-cert.pem', import.meta.url),
      )
      const key = readFileSync(
        new URL('./support/ai-loopback-key.pem', import.meta.url),
      )
      const seen: {
        messages: {
          role: string
          content: string
        }[]
      }[] = []
      const paths: string[] = []
      const server = createServer({ cert, key }, async (req, res) => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        seen.push(JSON.parse(Buffer.concat(chunks).toString()))
        paths.push(req.url ?? '')
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(
          'data: {"choices":[{"delta":{"content":"Loopback ' +
            'reply"}}]}\n\ndata: {"choices":[{"delta":{},"finis' +
            'h_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        )
      })
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      )
      try {
        const address = server.address()
        if (!address || typeof address === 'string')
          throw new Error('missing loopback address')
        const baseUrl = `https://127.0.0.1:${address.port}`
        // Node's HTTPS client trusts only this test certificate;
        // responses come from real sockets.
        vi.stubGlobal(
          'fetch',
          (url: string | URL, init?: RequestInit) =>
            new Promise<Response>((resolve, reject) => {
              const outgoing = httpsRequest(
                String(url),
                {
                  method: init?.method,
                  headers: Object.fromEntries(new Headers(init?.headers)),
                  signal: init?.signal ?? undefined,
                  ca: cert,
                },
                (incoming) => {
                  const chunks: Buffer[] = []
                  incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
                  incoming.on('error', reject)
                  incoming.on('end', () =>
                    resolve(
                      new Response(Buffer.concat(chunks), {
                        status: incoming.statusCode ?? 500,
                      }),
                    ),
                  )
                },
              )
              outgoing.on('error', reject)
              outgoing.end(init?.body)
            }),
        )
        const provider = await h.json<
          {
            endpoints: {
              id: string
            }[]
          }[]
        >('user-a', 'PUT', '/providers', {
          name: 'Loopback',
          endpoints: [
            {
              slug: 'main',
              baseUrl,
              protocol: 'openai-chat',
              models: [chatModel('m1')],
            },
          ],
        })
        expect(provider.status).toBe(200)
        const model = {
          endpointId: provider.body[0]!.endpoints[0]!.id,
          modelId: 'm1',
        }
        const first = await run(h, {
          model,
          input: 'First without payload',
          scope: 'note:n1',
          context: null,
        })
        expect(first.events.at(-1)).toEqual({
          kind: 'end',
          status: 'completed',
        })
        const conversationId = String(first.events[0]!.conversationId)
        const included = await run(h, {
          model,
          conversationId,
          input: 'With payload',
          scope: 'note:n1',
          context: { kind: 'autonote-note', id: 'n1' },
        })
        expect(included.events.at(-1)).toEqual({
          kind: 'end',
          status: 'completed',
        })
        const dropped = await run(h, {
          model,
          conversationId,
          input: 'Continue without payload',
          scope: 'note:n1',
          context: null,
        })
        expect(dropped.events.at(-1)).toEqual({
          kind: 'end',
          status: 'completed',
        })
        expect(paths).toEqual([
          '/v1/chat/completions',
          '/v1/chat/completions',
          '/v1/chat/completions',
        ])
        expect(JSON.stringify(seen[0])).not.toContain(marker)
        expect(JSON.stringify(seen[1])).toContain(marker)
        expect(JSON.stringify(seen[2])).not.toContain(marker)
        expect(seen[2]!.messages.slice(1)).toEqual([
          { role: 'user', content: 'First without payload' },
          { role: 'assistant', content: 'Loopback reply' },
          { role: 'user', content: 'With payload' },
          { role: 'assistant', content: 'Loopback reply' },
          { role: 'user', content: 'Continue without payload' },
        ])
        const loaded = await h.json<ConversationDto>(
          'user-a',
          'GET',
          `/conversations/${conversationId}`,
        )
        expect(loaded.body.summary.scope).toBe('note:n1')
        expect(loaded.body.turns.map((turn) => turn.input)).toEqual([
          'First without payload',
          'With payload',
          'Continue without payload',
        ])
        expect(
          await h.env.DB.prepare(
            "SELECT content FROM notes WHERE id = 'n1'",
          ).first('content'),
        ).toBe(marker)
        const sourceId = String(included.events[0]!.turnId)
        const retried = await run(h, {
          conversationId,
          scope: 'note:n1',
          retryTurnId: sourceId,
          input: '',
          context: null,
        })
        const retryId = String(retried.events[0]!.turnId)
        expect(retried.events.at(-1)).toMatchObject({ status: 'completed' })
        expect(seen[3]!.messages.slice(1)).toEqual([
          { role: 'user', content: 'First without payload' },
          { role: 'assistant', content: 'Loopback reply' },
          { role: 'user', content: 'With payload' },
        ])
        expect(JSON.stringify(seen[3])).not.toContain(marker)
        await h.json(
          'user-a',
          'PUT',
          `/conversations/${conversationId}/selection`,
          { turnId: retryId },
        )
        const translated = await run(h, {
          conversationId,
          scope: 'note:n1',
          translateTurnId: retryId,
          targetLanguage: 'French',
          input: '',
          context: { kind: 'autonote-note', id: 'n1' },
        })
        expect(translated.events.at(-1)).toMatchObject({ status: 'completed' })
        expect(JSON.stringify(seen[4])).toContain(marker)
        expect(seen[4]!.messages.at(-2)).toEqual({
          role: 'assistant',
          content: 'Loopback reply',
        })
        expect(seen[4]!.messages.at(-1)?.content).toBe(
          'Translate the following reply into French. Retur' +
            'n only the translation, preserving Markdown form' +
            'atting.\n\nLoopback reply',
        )
        const final = (
          await h.json<Conversation>(
            'user-a',
            'GET',
            `/conversations/${conversationId}`,
          )
        ).body
        expect(final.turns).toHaveLength(5)
        expect(final.turns[3]).toMatchObject({
          parentId: String(first.events[0]!.turnId),
          supersedesId: sourceId,
          questionId: sourceId,
        })
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      }
    },
  )

  it(
    'keeps note ownership and scope checks with null ' +
      'payload on new and existing chats',
    async () => {
      const h = await createHarness()
      const { endpointId } = await saveProvider(h)
      const model = { endpointId, modelId: 'm1' }
      await h.env.DB.prepare(
        'INSERT INTO notes (id, user_id, title, content, ' +
          "created_at, updated_at) VALUES ('n1', 'user-a', " +
          "'Plan', 'Body', 0, 0), ('n2', 'user-a', 'Other'," +
          " 'Other body', 0, 0), ('foreign', 'user-b', 'Pri" +
          "vate', 'Private body', 0, 0)",
      ).run()
      fetchMock.mockImplementation(async () => textStream('ok'))
      const first = await run(h, { model, scope: 'note:n1', context: null })
      expect(first.events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
      const conversationId = String(first.events[0]!.conversationId)
      const base = { model, scope: 'note:n1', context: null }
      for (const conversation of [{}, { conversationId }]) {
        for (const context of [
          { kind: 'autonote-note', id: 'n2' },
          { kind: 'other', id: 'n1' },
        ]) {
          expect(
            JSON.parse(
              (await run(h, { ...base, ...conversation, context })).text,
            ),
          ).toMatchObject({
            error: {
              code: 'bad_request',
              details: { field: 'context', reason: 'conversation_mismatch' },
            },
          })
        }
      }
      for (const scope of ['global', 'note:n2', null]) {
        expect(
          JSON.parse((await run(h, { ...base, conversationId, scope })).text),
        ).toMatchObject({
          error: {
            details: { field: 'scope', reason: 'conversation_mismatch' },
          },
        })
      }
      expect(
        JSON.parse((await run(h, { ...base, conversationId }, 'user-b')).text),
      ).toMatchObject({
        error: { code: 'not_found', details: { entity: 'conversation' } },
      })
      for (const scope of ['note:missing', 'note:foreign']) {
        expect(
          JSON.parse((await run(h, { ...base, scope })).text),
        ).toMatchObject({
          error: { code: 'not_found', details: { entity: 'note' } },
        })
      }
      await h.env.DB.prepare(
        "UPDATE notes SET user_id = 'user-b' WHERE id = '" + "n1'",
      ).run()
      expect(
        JSON.parse((await run(h, { ...base, conversationId })).text),
      ).toMatchObject({
        error: { code: 'not_found', details: { entity: 'note' } },
      })
      await h.env.DB.prepare(
        "UPDATE notes SET user_id = 'user-a', deleted_at " +
          "= 1 WHERE id = 'n1'",
      ).run()
      for (const conversation of [{}, { conversationId }]) {
        expect(
          JSON.parse((await run(h, { ...base, ...conversation })).text),
        ).toMatchObject({
          error: { code: 'not_found', details: { entity: 'note' } },
        })
      }
      const writing = {
        action: 'polish',
        noteId: 'n2',
        selectedText: 'x',
        beforeText: '',
        afterText: '',
        cursorOffset: 0,
        language: 'en-US',
        title: 'Other',
      }
      expect(
        JSON.parse(
          (
            await run(h, {
              model,
              purpose: 'writing',
              input: JSON.stringify(writing),
              scope: 'note:n2:writing',
              context: null,
            })
          ).text,
        ),
      ).toMatchObject({
        error: {
          code: 'bad_request',
          details: { field: 'context', reason: 'required' },
        },
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(
        await h.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_chat_turns').first(
          'n',
        ),
      ).toBe(1)
    },
  )

  it(
    'rejects regenerate while the last turn is runnin' +
      'g and reads stale running turns as interrupted',
    async () => {
      const h = await createHarness()
      const { endpointId } = await saveProvider(h)
      fetchMock.mockImplementation(async () => textStream('ok'))
      const { events } = await run(h, { model: { endpointId, modelId: 'm1' } })
      const conversationId = String(events[0]!.conversationId)
      await h.env.DB.prepare(
        "UPDATE ai_chat_turns SET status = 'running'",
      ).run()
      const busy = await run(h, {
        model: { endpointId, modelId: 'm1' },
        conversationId,
        regenerate: true,
        input: '',
      })
      expect(JSON.parse(busy.text)).toMatchObject({
        error: { code: 'conflict', details: { reason: 'turn_running' } },
      })
      await h.env.DB.prepare('UPDATE ai_chat_turns SET created_at = 0').run()
      const loaded = await h.json<ConversationDto>(
        'user-a',
        'GET',
        `/conversations/${conversationId}`,
      )
      expect(loaded.body.turns[0]).toMatchObject({
        status: 'failed',
        errorCode: 'interrupted',
      })
    },
  )

  it(
    'finishes the turn as cancelled when the client d' + 'isconnects',
    async () => {
      const h = await createHarness()
      const { endpointId } = await saveProvider(h)
      fetchMock.mockImplementation(async (_url, init) => {
        const signal = init?.signal
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"delta":{"content":"partial"}' +
                    '}]}\n\n',
                ),
              )
              signal?.addEventListener('abort', () =>
                controller.error(new Error('aborted')),
              )
            },
          }),
        )
      })
      const response = await h.call('user-a', 'POST', '/runs', {
        purpose: 'chat',
        model: { endpointId, modelId: 'm1' },
        skills: [],
        input: 'Hi',
        regenerate: false,
        language: 'en-US',
      })
      const reader = response.body!.getReader()
      const seen: string[] = []
      for (
        let chunk = await reader.read();
        !chunk.done;
        chunk = await reader.read()
      ) {
        seen.push(new TextDecoder().decode(chunk.value))
        if (seen.join('').includes('partial')) break
      }
      expect(seen.join('')).toContain('partial')
      await reader.cancel()
      await h.settle()
      const turn = await h.env.DB.prepare(
        'SELECT status, messages FROM ai_chat_turns',
      ).first<{
        status: string
        messages: string
      }>()
      expect(turn).toEqual({
        status: 'cancelled',
        messages: JSON.stringify([
          { assistant: { text: 'partial', tool_calls: [] } },
        ]),
      })
    },
  )
})
