import { describe, expect, it, vi } from 'vitest'
import {
  addKey,
  chatModel,
  createHarness,
  fixture,
  streamOf,
  type Harness,
} from './support/ai-kit-harness'
import {
  KEY,
  PNG,
  fetchMock,
  sse,
  run,
  calls,
  bodyOf,
} from './support/painting-test-setup'

describe('generate_image edits (docs/37)', () => {
  const GIF = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='

  async function editSetup({
    edit = true,
    imageEditBaseUrl = null as string | null,
  } = {}) {
    // The run limiter (20/min per user) is module-global; start each
    // setup in a fresh window.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 120000)
    const h = await createHarness()
    const save = async (
      url: string | null,
      id?: {
        providerId: string
        endpointId: string
      },
    ) =>
      (
        await h.json<
          {
            id: string
            endpoints: {
              id: string
            }[]
          }[]
        >('user-a', 'PUT', '/providers', {
          ...(id ? { id: id.providerId } : {}),
          name: 'P',
          endpoints: [
            {
              ...(id ? { id: id.endpointId } : {}),
              slug: 'main',
              baseUrl: 'https://api.example.com',
              protocol: 'openai-chat',
              imageEditBaseUrl: url,
              headers: { 'X-Team': 'blue' },
              models: [
                { ...chatModel('m1'), canVision: true },
                { ...chatModel('img1'), modelType: 'image', canVision: edit },
              ],
            },
          ],
        })
      ).body[0]!
    const saved = await save(imageEditBaseUrl)
    const ids = { providerId: saved.id, endpointId: saved.endpoints[0]!.id }
    await addKey(h, 'user-a', ids.endpointId, KEY)
    await h.env.DB.prepare(
      'INSERT INTO ai_roles (user_id, role, endpoint_id' +
        ", model_id) VALUES ('user-a', 'painting', ?1, 'i" +
        "mg1')",
    )
      .bind(ids.endpointId)
      .run()
    return {
      h,
      model: { endpointId: ids.endpointId, modelId: 'm1' },
      resave: (url: string | null) => save(url, ids),
    }
  }

  function editUpstream(args: Record<string, unknown>) {
    let chats = 0
    fetchMock.mockImplementation(async (input) => {
      if (String(input).includes('/images/'))
        return Response.json({ data: [{ b64_json: GIF }] })
      if (chats++ >= 1)
        return new Response(
          streamOf(new Uint8Array(fixture('sse/openai-chat/text.sse'))),
        )
      return new Response(
        streamOf(
          sse([
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_1',
                        type: 'function',
                        function: {
                          name: 'generate_image',
                          arguments: JSON.stringify(args),
                        },
                      },
                    ],
                  },
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            '[DONE]',
          ]),
        ),
      )
    })
  }

  const imageIds = (call: Parameters<typeof fetch>) => {
    const tool = (
      bodyOf(call).tools as {
        function: {
          description: string
          parameters: {
            properties: Record<string, unknown>
          }
        }
      }[]
    )[0]!.function
    return {
      description: tool.description,
      schema: tool.parameters.properties.image_ids,
    }
  }

  const attached = [{ mime: 'image/png', data: PNG }]

  const toolSummary = (events: Record<string, unknown>[]) =>
    events.find((e) => e.kind === 'tool_result')!.summary

  it(
    'edits an attached image via multipart /images/ed' +
      'its, then edits the generated one next turn',
    async () => {
      const { h, model } = await editSetup()
      editUpstream({
        prompt: 'make the background blue',
        image_ids: ['image-1'],
      })
      const first = await run(h, {
        model,
        generateImage: true,
        images: attached,
      })
      expect(toolSummary(first.events)).toBe(
        'Generated 1 image; it is already shown to the us' + 'er.',
      )
      const offered = imageIds(calls('/chat/completions')[0]!)
      expect(offered.schema).toEqual({
        type: 'array',
        items: { type: 'string', enum: ['image-1'] },
        minItems: 1,
        maxItems: 4,
      })
      expect(offered.description).toContain(
        'Images you can pass in image_ids (newest first):' +
          '\nimage-1: attached by the user in this message',
      )
      const [edit] = calls('/images/edits')
      expect(String(edit![0])).toBe('https://api.example.com/v1/images/edits')
      const headers = new Headers(edit![1]?.headers)
      expect([
        headers.get('x-team'),
        headers.get('authorization'),
        headers.get('content-type'),
      ]).toEqual(['blue', `Bearer ${KEY}`, null])
      const form = edit![1]!.body as FormData
      expect([
        form.get('model'),
        form.get('prompt'),
        form.get('size'),
        form.get('n'),
      ]).toEqual(['img1', 'make the background blue', '1024x1024', '1'])
      const files = form.getAll('image') as File[]
      expect(files.map((file) => [file.name, file.type])).toEqual([
        ['image-1.png', 'image/png'],
      ])
      expect(form.getAll('image[]')).toEqual([])
      expect(calls('/images/generations')).toEqual([])
      fetchMock.mockReset()
      editUpstream({ prompt: 'now red', image_ids: ['image-1', 'image-2'] })
      const second = await run(h, {
        model,
        generateImage: true,
        conversationId: String(first.events[0]!.conversationId),
        input: 'Now red',
      })
      expect(toolSummary(second.events)).toBe(
        'Generated 1 image; it is already shown to the us' + 'er.',
      )
      expect(imageIds(calls('/chat/completions')[0]!).description).toContain(
        'image-1: generated in an earlier reply\nimage-2: ' +
          'attached in an earlier message',
      )
      const many = calls('/images/edits')[0]![1]!.body as FormData
      expect(many.getAll('image')).toEqual([])
      const parts = many.getAll('image[]') as File[]
      expect(parts.map((file) => file.name)).toEqual([
        'image-1.gif',
        'image-2.png',
      ])
      expect(
        await Promise.all(
          parts.map(async (file) =>
            btoa(
              String.fromCharCode(...new Uint8Array(await file.arrayBuffer())),
            ),
          ),
        ),
      ).toEqual([GIF, PNG])
    },
  )

  it(
    'offers no image_ids when the painting model cann' +
      'ot edit or no image is available',
    async () => {
      const plain = await editSetup({ edit: false })
      editUpstream({ prompt: 'a cat' })
      await run(plain.h, {
        model: plain.model,
        generateImage: true,
        images: attached,
      })
      expect(imageIds(calls('/chat/completions')[0]!).schema).toBeUndefined()
      fetchMock.mockReset()
      const empty = await editSetup()
      editUpstream({ prompt: 'a cat' })
      await run(empty.h, { model: empty.model, generateImage: true })
      expect(imageIds(calls('/chat/completions')[0]!)).toMatchObject({
        schema: undefined,
        description: expect.not.stringContaining('image-1'),
      })
      expect(calls('/images/generations')).toHaveLength(1)
    },
  )

  // Aether core rejects ids outside the per-run schema (unknown,
  // too many, no edit support) before the host runs;
  // only an id that is offered but whose stored image has expired
  // reaches the host's own check.
  it(
    'feeds schema-invalid and expired image_ids back ' +
      'to the model without painting',
    async () => {
      const reason = async (
        {
          h,
          model,
        }: {
          h: Harness
          model: Record<string, string>
        },
        ids: unknown,
        body: Record<string, unknown> = { images: attached },
      ) => {
        fetchMock.mockReset()
        editUpstream({ prompt: 'x', image_ids: ids })
        const result = await run(h, { model, generateImage: true, ...body })
        expect(calls('/images/')).toEqual([])
        expect(result.events.at(-1)).toMatchObject({
          kind: 'end',
          status: 'completed',
        })
        return {
          summary: toolSummary(result.events),
          conversationId: String(result.events[0]!.conversationId),
        }
      }
      const schema =
        'error invalid_arguments: arguments do not match ' + 'the tool schema'
      const ok = await editSetup()
      const unknown = await reason(ok, ['image-2'])
      expect(unknown.summary).toBe(schema)
      expect(
        (
          await reason(ok, [
            'image-1',
            'image-1',
            'image-1',
            'image-1',
            'image-1',
          ])
        ).summary,
      ).toBe(schema)
      ok.h.objects.clear()
      expect(
        (
          await reason(ok, ['image-1'], {
            conversationId: unknown.conversationId,
            input: 'again',
          })
        ).summary,
      ).toBe('error bad_request: invalid image_ids: expired')
      expect(
        (await reason(await editSetup({ edit: false }), ['image-1'])).summary,
      ).toBe(schema)
    },
  )

  it('numbers the last attached image as image-1', async () => {
    const { h, model } = await editSetup()
    editUpstream({ prompt: 'x', image_ids: ['image-1'] })
    await run(h, {
      model,
      generateImage: true,
      images: [...attached, { mime: 'image/gif', data: GIF }],
    })
    const file = (calls('/images/edits')[0]![1]!.body as FormData).get(
      'image',
    ) as File
    expect([file.name, file.type]).toEqual(['image-1.gif', 'image/gif'])
  })

  it(
    'edits at the image edit base URL and falls back ' +
      'to the API address when cleared',
    async () => {
      const { h, model, resave } = await editSetup({
        imageEditBaseUrl: 'https://edit.example.com/',
      })
      editUpstream({ prompt: 'x', image_ids: ['image-1'] })
      await run(h, { model, generateImage: true, images: attached })
      expect(calls('/images/edits').map(([url]) => String(url))).toEqual([
        'https://edit.example.com/v1/images/edits',
      ])
      await resave('')
      fetchMock.mockReset()
      editUpstream({ prompt: 'x', image_ids: ['image-1'] })
      await run(h, { model, generateImage: true, images: attached })
      expect(calls('/images/edits').map(([url]) => String(url))).toEqual([
        'https://api.example.com/v1/images/edits',
      ])
    },
  )
})
