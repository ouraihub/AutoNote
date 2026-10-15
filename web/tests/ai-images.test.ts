import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { purgeExpiredChatImages } from '../src/worker/ai/images'
import { chatModel, createHarness, fixture, frames, streamOf, type Harness } from './support/ai-kit-harness'

const KEY = 'sk-test-abcdefghijklmnop'
const PNG = { mime: 'image/png', data: 'iVBORw0KGgo=' }
const URL_PNG = `data:image/png;base64,${PNG.data}`
const fetchMock = vi.fn<typeof fetch>()

let clock = Date.now()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers({ toFake: ['Date'] })
  clock += 120_000
  vi.setSystemTime(clock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function provider(h: Harness, protocol: string, canVision = true) {
  const { body } = await h.json<{ endpoints: { id: string }[] }[]>('user-a', 'PUT', '/providers', {
    name: `P-${protocol}-${canVision}`,
    endpoints: [{ slug: 'main', baseUrl: 'https://api.example.com', protocol, apiKey: KEY, models: [{ ...chatModel('m1'), canVision }] }],
  })
  return { endpointId: body.at(-1)!.endpoints[0]!.id, modelId: 'm1' }
}

async function run(h: Harness, body: Record<string, unknown>) {
  fetchMock.mockImplementation(async () => {
    const protocol = String(fetchMock.mock.calls.at(-1)![0]).includes('/messages') ? 'anthropic-messages' : String(fetchMock.mock.calls.at(-1)![0]).includes('/responses') ? 'openai-responses' : 'openai-chat'
    return new Response(streamOf(new Uint8Array(fixture(`sse/${protocol}/text.sse`))))
  })
  const response = await h.call('user-a', 'POST', '/runs', { purpose: 'chat', skills: [], input: 'What is this?', regenerate: false, language: 'en-US', ...body })
  const text = await response.text()
  await h.settle()
  return { status: response.status, events: frames(text), text }
}

const sent = (index = -1) => JSON.parse(String(fetchMock.mock.calls.at(index)![1]?.body)) as Record<string, unknown[]>

describe('chat images', () => {
  it('encodes current and history images per protocol and reuses them on retry', async () => {
    const want = {
      'openai-chat': (text: string) => [{ type: 'text', text }, { type: 'image_url', image_url: { url: URL_PNG } }],
      'openai-responses': (text: string) => [{ type: 'input_text', text }, { type: 'input_image', image_url: URL_PNG }],
      'anthropic-messages': (text: string) => [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.data } }, { type: 'text', text }],
    }
    for (const protocol of Object.keys(want) as (keyof typeof want)[]) {
      const h = await createHarness()
      const model = await provider(h, protocol)
      const first = await run(h, { model, images: [PNG] })
      expect(first.events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
      const list = (body: Record<string, unknown[]>) => (protocol === 'openai-responses' ? body.input! : body.messages!) as { role?: string; content: unknown }[]
      expect(list(sent()).filter((m) => m.role === 'user').at(-1)!.content).toEqual(want[protocol]('What is this?'))
      const conversationId = String(first.events[0]!.conversationId)
      await run(h, { model, conversationId, input: 'And now?' })
      const users = list(sent()).filter((m) => m.role === 'user')
      expect(users[0]!.content).toEqual(want[protocol]('What is this?'))
      expect(users[1]!.content).toBe('And now?')
      const turnId = String(first.events[0]!.turnId)
      await run(h, { model, conversationId, retryTurnId: turnId, input: '' })
      expect(list(sent()).filter((m) => m.role === 'user').at(-1)!.content).toEqual(want[protocol]('What is this?'))
    }
  })

  it('rejects images for a non-vision model before any turn or request and strips history images', async () => {
    const h = await createHarness()
    const text = await provider(h, 'openai-chat', false)
    const rejected = await run(h, { model: text, images: [PNG] })
    expect(rejected.status).toBe(400)
    expect(rejected.text).toContain('vision_unsupported')
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await h.json<unknown[]>('user-a', 'GET', '/conversations')).body).toHaveLength(0)
    const vision = await provider(h, 'openai-chat', true)
    const first = await run(h, { model: vision, images: [PNG] })
    await run(h, { model: text, conversationId: String(first.events[0]!.conversationId), input: 'text only' })
    expect((sent().messages as { role: string; content: unknown }[]).filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['What is this?', 'text only'])
  })

  it('validates limits and action conflicts', async () => {
    const h = await createHarness()
    const model = await provider(h, 'openai-chat')
    for (const [images, reason] of [
      [[PNG, PNG, PNG, PNG, PNG], 'count'],
      [[{ mime: 'image/bmp', data: PNG.data }], 'mime'],
      [[{ mime: 'image/png', data: 'not base64!' }], 'encoding'],
      [[{ mime: 'image/png', data: 'A'.repeat((Math.ceil((4 * 1024 * 1024) / 3) + 1) * 4) }], 'size'],
    ] as const) {
      const result = await run(h, { model, images })
      expect(result.status, reason).toBe(400)
      expect(result.text).toContain(reason)
    }
    const first = await run(h, { model })
    const conflict = await run(h, { model, conversationId: String(first.events[0]!.conversationId), retryTurnId: String(first.events[0]!.turnId), input: '', images: [PNG] })
    expect(conflict.text).toContain('action_conflict')
  })

  it('serves images to the owner only, then expires and deletes unreferenced objects', async () => {
    const h = await createHarness()
    const model = await provider(h, 'openai-chat')
    const first = await run(h, { model, images: [PNG] })
    const conversationId = String(first.events[0]!.conversationId)
    const turnId = String(first.events[0]!.turnId)
    await run(h, { model, conversationId, retryTurnId: turnId, input: '' })
    const conversation = await h.json<{ turns: { images: { url: string | null }[] }[] }>('user-a', 'GET', `/conversations/${conversationId}`)
    const url = conversation.body.turns[0]!.images[0]!.url!
    expect(conversation.body.turns.map((t) => t.images.length)).toEqual([1, 1])
    const image = await h.call('user-a', 'GET', url.replace('/api/ai/kit', ''))
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(Uint8Array.from(atob(PNG.data), (c) => c.charCodeAt(0)))
    expect((await h.call('user-b', 'GET', url.replace('/api/ai/kit', ''))).status).toBe(404)
    expect(h.objects.size).toBe(1)

    expect(await purgeExpiredChatImages(h.env, Date.now() + 8 * 24 * 60 * 60 * 1000)).toBe(1)
    expect(h.objects.size).toBe(0)
    const expired = await h.json<{ turns: { images: { url: string | null }[] }[] }>('user-a', 'GET', `/conversations/${conversationId}`)
    expect(expired.body.turns.flatMap((t) => t.images.map((i) => i.url))).toEqual([null, null])
    await run(h, { model, conversationId, retryTurnId: turnId, input: '' })
    expect((sent().messages as { role: string; content: unknown }[]).at(-1)!.content).toBe('What is this?')

    const second = await run(h, { model, images: [PNG] })
    expect(h.objects.size).toBe(1)
    expect((await h.call('user-a', 'DELETE', `/conversations/${String(second.events[0]!.conversationId)}`)).status).toBe(200)
    expect(h.objects.size).toBe(0)
  })
})
