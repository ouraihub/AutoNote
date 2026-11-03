import { describe, expect, it, vi } from 'vitest'
import { addKey, chatModel } from './support/ai-kit-harness'
import {
  KEY,
  PNG,
  fetchMock,
  setup,
  upstream,
  run,
  calls,
  bodyOf,
  CHAT_PATH,
} from './support/painting-test-setup'

describe('generate_image tool loop', () => {
  for (const protocol of [
    'openai-chat',
    'openai-responses',
    'anthropic-messages',
  ] as const) {
    it(
      'paints, feeds the result back, stores and replay' +
        's it (' +
        `${protocol}` +
        ')',
      async () => {
        const { h, model } = await setup(protocol)
        upstream(protocol, 1)
        const first = await run(h, { model, generateImage: true })
        expect(first.events.find((e) => e.kind === 'tool_call')).toMatchObject({
          callId: 'call_1',
          name: 'generate_image',
          source: 'host',
        })
        expect(first.events.find((e) => e.kind === 'tool_result')).toEqual({
          kind: 'tool_result',
          callId: 'call_1',
          outcome: 'ok',
          summary: 'Generated 1 image; it is already shown to the us' + 'er.',
          payload: {
            images: [
              { mime: 'image/png', url: `data:image/png;base64,${PNG}` },
            ],
          },
        })
        expect(first.events.at(-1)).toEqual({
          kind: 'end',
          status: 'completed',
        })
        const paint = calls('/images/generations')
        expect(paint).toHaveLength(1)
        expect(bodyOf(paint[0]!)).toEqual({
          model: 'img1',
          prompt: 'a cat',
          size: '1024x1024',
          n: 1,
        })
        expect(new Headers(paint[0]![1]?.headers).get('authorization')).toBe(
          `Bearer ${KEY}`,
        )
        const [round1, round2] = calls(CHAT_PATH[protocol]).map(bodyOf)
        const tool = (round1!.tools as Record<string, unknown>[])[0]!
        expect(
          protocol === 'openai-chat'
            ? (
                tool.function as {
                  name: string
                }
              ).name
            : tool.name,
        ).toBe('generate_image')
        const echo = JSON.stringify(round2)
        if (protocol === 'openai-chat')
          expect(echo).toContain('"role":"tool","tool_call_id":"call_1"')
        if (protocol === 'openai-responses')
          expect(echo).toContain(
            '"type":"function_call_output","call_id":"call_1"',
          )
        if (protocol === 'anthropic-messages')
          expect(echo).toContain('"type":"tool_result","tool_use_id":"call_1"')
        const conversationId = String(first.events[0]!.conversationId)
        const saved = (
          await h.json<{
            turns: {
              text: string
              images: unknown[]
              generated: {
                mime: string
                url: string | null
              }[]
            }[]
          }>('user-a', 'GET', `/conversations/${conversationId}`)
        ).body
        expect(saved.turns[0]!.images).toEqual([])
        expect(saved.turns[0]!.generated).toHaveLength(1)
        expect(saved.turns[0]!.text).toBe(
          first.events
            .filter((e) => e.kind === 'text_delta')
            .map((e) => e.text)
            .join(''),
        )
        const image = await h.call(
          'user-a',
          'GET',
          saved.turns[0]!.generated[0]!.url!.replace('/api/ai/kit', ''),
        )
        expect(image.headers.get('content-type')).toBe('image/png')
        // A follow-up without the switch offers no tool, replays the
        // earlier call and result, and never re-uploads the image.
        upstream(protocol, 0)
        await run(h, { model, conversationId, input: 'Thanks' })
        const followUp = bodyOf(calls(CHAT_PATH[protocol]).at(-1)!)
        expect(followUp.tools).toBeUndefined()
        expect(JSON.stringify(followUp)).toContain('call_1')
        expect(JSON.stringify(followUp)).not.toContain(PNG)
      },
    )
  }

  it(
    'refuses without a painting model, for tool-less ' +
      'models and outside chat, before any request',
    async () => {
      const unbound = await setup('openai-chat', { bind: false })
      expect(
        (await run(unbound.h, { model: unbound.model, generateImage: true }))
          .text,
      ).toContain('painting_model')
      const toolless = await setup('openai-chat', { supportsTools: false })
      expect(
        (await run(toolless.h, { model: toolless.model, generateImage: true }))
          .text,
      ).toContain('tools_unsupported')
      const writing = await run(toolless.h, {
        model: toolless.model,
        purpose: 'writing',
        generateImage: true,
      })
      expect(writing.text).toContain('chat_only')
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it(
    'reports painting errors without the key and caps' + ' calls per reply',
    async () => {
      const failing = await setup('openai-chat')
      upstream('openai-chat', 1, () =>
        Response.json(
          { error: { message: `bad key ${KEY}` } },
          { status: 500 },
        ),
      )
      const failed = await run(failing.h, {
        model: failing.model,
        generateImage: true,
      })
      const result = failed.events.find((e) => e.kind === 'tool_result')!
      expect(result.outcome).toBe('error')
      expect(JSON.stringify(failed.events)).not.toContain(KEY)
      expect(failed.events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
      fetchMock.mockReset()
      const looping = await setup('openai-chat')
      upstream('openai-chat', 99)
      const capped = await run(looping.h, {
        model: looping.model,
        generateImage: true,
      })
      expect(calls('/images/generations')).toHaveLength(2)
      expect(
        capped.events.filter((e) => e.kind === 'round_start'),
      ).toHaveLength(4)
      expect(
        capped.events
          .filter((e) => e.kind === 'tool_result')
          .map((e) => e.outcome),
      ).toEqual(['ok', 'ok', 'error', 'error'])
      expect(capped.events.at(-1)).toEqual({
        kind: 'end',
        status: 'completed',
        exhausted: true,
      })
    },
  )

  it(
    'fill-first paints with the next key when the fir' +
      'st one breaks while reading the response',
    async () => {
      const { h, model } = await setup('openai-chat')
      const { body } = await h.json<
        {
          id: string
          endpoints: {
            id: string
          }[]
        }[]
      >('user-a', 'GET', '/providers')
      await addKey(h, 'user-a', model.endpointId, 'sk-second-0123456789')
      await h.json('user-a', 'PUT', '/providers', {
        id: body[0]!.id,
        name: 'P',
        endpoints: [
          {
            id: model.endpointId,
            slug: 'main',
            baseUrl: 'https://api.example.com',
            protocol: 'openai-chat',
            keyStrategy: 'fill_first',
            models: [
              chatModel('m1'),
              { ...chatModel('img1'), modelType: 'image' },
            ],
          },
        ],
      })
      const broken = () =>
        new Response(
          new ReadableStream({
            pull: (controller) =>
              controller.error(new TypeError('socket hang up')),
          }),
        )
      let paints = 0
      upstream('openai-chat', 1, () =>
        paints++ === 0
          ? broken()
          : Response.json({ data: [{ b64_json: PNG }] }),
      )
      const result = await run(h, { model, generateImage: true })
      expect(
        result.events.find((e) => e.kind === 'tool_result'),
        JSON.stringify(result.events),
      ).toMatchObject({ outcome: 'ok' })
      expect(
        calls('/images/generations').map(
          ([, init]) => (init!.headers as Record<string, string>).authorization,
        ),
      ).toEqual([`Bearer ${KEY}`, 'Bearer sk-second-0123456789'])
    },
  )

  it(
    'a fully paused fill-first painting line fails th' +
      'e tool call, not the chat',
    async () => {
      const { h, model } = await setup('openai-chat', { bind: false })
      const { body } = await h.json<
        {
          name: string
          endpoints: {
            id: string
          }[]
        }[]
      >('user-a', 'PUT', '/providers', {
        name: 'Img',
        endpoints: [
          {
            slug: 'img',
            baseUrl: 'https://img.example.com',
            protocol: 'openai-chat',
            keyStrategy: 'fill_first',
            models: [{ ...chatModel('img2'), modelType: 'image' }],
          },
        ],
      })
      const imgEndpoint = body.find((provider) => provider.name === 'Img')!
        .endpoints[0]!.id
      await addKey(h, 'user-a', imgEndpoint, 'sk-img-0123456789')
      await h.env.DB.prepare(
        'INSERT INTO ai_roles (user_id, role, endpoint_id' +
          ", model_id) VALUES ('user-a', 'painting', ?1, 'i" +
          "mg2')",
      )
        .bind(imgEndpoint)
        .run()
      const resumeAt = Date.now() + 60000
      await h.env.DB.prepare(
        'UPDATE ai_endpoint_keys SET exhausted_until = ?1' +
          ' WHERE endpoint_id = ?2',
      )
        .bind(resumeAt, imgEndpoint)
        .run()
      upstream('openai-chat', 1)
      const result = await run(h, { model, generateImage: true })
      expect(result.status, result.text).toBe(200)
      expect(result.events.find((e) => e.kind === 'tool_result')).toMatchObject(
        { outcome: 'error', summary: expect.stringContaining('rate_limited') },
      )
      expect(result.events.find((e) => e.kind === 'tool_result')).toMatchObject(
        { summary: expect.stringContaining('Img · img') },
      )
      expect(result.events.find((e) => e.kind === 'tool_result')).toMatchObject(
        { summary: expect.stringContaining(new Date(resumeAt).toISOString()) },
      )
      expect(result.events.at(-1)).toMatchObject({
        kind: 'end',
        status: 'completed',
      })
      expect(calls('/images/generations')).toEqual([])
    },
  )

  it(
    'paints at the image base URL with custom headers' +
      ' and falls back to the API address when cleared',
    async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 120000)
      const { h, model } = await setup('openai-chat')
      const providerId = (
        await h.json<
          {
            id: string
          }[]
        >('user-a', 'GET', '/providers')
      ).body[0]!.id
      const save = (imageBaseUrl: string) =>
        h.json('user-a', 'PUT', '/providers', {
          id: providerId,
          name: 'P',
          endpoints: [
            {
              id: model.endpointId,
              slug: 'main',
              baseUrl: 'https://api.example.com',
              protocol: 'openai-chat',
              imageBaseUrl,
              headers: { 'X-Team': 'blue' },
              models: [
                chatModel('m1'),
                { ...chatModel('img1'), modelType: 'image' },
              ],
            },
          ],
        })
      await save('https://img.example.com/')
      upstream('openai-chat', 1)
      await run(h, { model, generateImage: true })
      const [paint] = calls('/images/generations')
      expect(String(paint![0])).toBe(
        'https://img.example.com/v1/images/generations',
      )
      const headers = new Headers(paint![1]?.headers)
      expect([headers.get('x-team'), headers.get('authorization')]).toEqual([
        'blue',
        `Bearer ${KEY}`,
      ])
      fetchMock.mockReset()
      await save('')
      upstream('openai-chat', 1)
      await run(h, { model, generateImage: true })
      expect(calls('/images/generations').map(([url]) => String(url))).toEqual([
        'https://api.example.com/v1/images/generations',
      ])
    },
  )
})
