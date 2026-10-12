import { expect, test } from 'vitest'
import type { RunEvent, RunRequest } from '@ouraihub/aether-ui/ports'
import { MemoryTabBus } from '../tab-bus'
import { HttpTransport } from '../transport'
import { createHttpKitPorts } from './kit'

const request: RunRequest = { purpose: 'chat', skills: [], input: '你好', regenerate: false, language: 'zh-CN' }
const accepted = 'data: {"kind":"accepted","runId":"r1","conversationId":"c1"}\n\n'

function ports(handler: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = []
  const transport = new HttpTransport({
    fetch: async (input) => {
      requests.push(input)
      return handler(input)
    },
    clientId: 'client',
    getLocale: () => 'zh-CN',
    bus: new MemoryTabBus('user'),
    timers: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  })
  const kit = createHttpKitPorts(transport)
  if (!kit.providers || !kit.chat?.history) throw new Error('missing ports')
  return { providers: kit.providers, chat: kit.chat, history: kit.chat.history, requests }
}

function stream(chunks: readonly (string | Uint8Array)[], close = true): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
        if (close) controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

function collect() {
  const events: RunEvent[] = []
  const started = Promise.withResolvers<void>()
  const ended = Promise.withResolvers<void>()
  const onEvent = (event: RunEvent): void => {
    events.push(event)
    started.resolve()
    if (event.kind === 'end') ended.resolve()
  }
  return { events, onEvent, started: started.promise, ended: ended.promise }
}

test('maps Kit error bodies with details', async () => {
  const { providers } = ports(() =>
    Response.json(
      { error: { code: 'conflict', message: 'dup', details: { field: 'name', reason: 'duplicate' } } },
      { status: 409 },
    ),
  )
  await expect(providers.save({ id: null, name: 'x', endpoints: [] } as never)).rejects.toMatchObject({
    name: 'KitClientError',
    code: 'conflict',
    message: 'dup',
    details: { field: 'name', reason: 'duplicate' },
  })
})

test('maps AutoNote and transport failures to Kit codes', async () => {
  const unauthorized = ports(() =>
    Response.json({ error: { code: 'unauthenticated', message: 'no' } }, { status: 401 }),
  )
  await expect(unauthorized.providers.list()).rejects.toMatchObject({ code: 'unauthorized' })
  const tooLarge = ports(() => Response.json({ error: { code: 'payload_too_large', message: 'big' } }, { status: 413 }))
  await expect(tooLarge.providers.list()).rejects.toMatchObject({
    code: 'bad_request',
    details: { reason: 'too_large' },
  })
  const other = ports(() => Response.json({ error: { code: 'storage_unavailable', message: 'down' } }, { status: 503 }))
  await expect(other.providers.list()).rejects.toMatchObject({ code: 'internal' })
  const offline = ports(() => {
    throw new TypeError('Failed to fetch')
  })
  await expect(offline.providers.list()).rejects.toMatchObject({ code: 'network' })
})

test('run resolves on accepted, then delivers events in order with one end', async () => {
  const end = 'data: {"kind":"end","status":"completed"}\n\n'
  const bytes = new TextEncoder().encode(`${accepted}data: {"kind":"text_delta","text":"汉字"}\r\n\r\n${end}`)
  const split = bytes.indexOf(0xe6) + 1
  const { chat, requests } = ports(() =>
    stream([bytes.slice(0, split), bytes.slice(split), 'data: {"kind":"text_delta","text":"late"}\n\n', end]),
  )
  const { events, onEvent, ended } = collect()
  await expect(chat.run(request, onEvent)).resolves.toEqual({ runId: 'r1', conversationId: 'c1' })
  await ended
  expect(events).toEqual([
    { kind: 'text_delta', text: '汉字' },
    { kind: 'end', status: 'completed' },
  ])
  expect(requests[0]?.method).toBe('POST')
  expect(new URL(requests[0]?.url ?? '').pathname).toBe('/api/ai/kit/runs')
  await expect(requests[0]?.json()).resolves.toEqual(request)
})

test('abort after acceptance emits one cancelled end and nothing later', async () => {
  const { chat } = ports(() => stream([accepted, 'data: {"kind":"round_start","round":1}\n\n'], false))
  const controller = new AbortController()
  const { events, onEvent, started, ended } = collect()
  await chat.run(request, onEvent, { signal: controller.signal })
  await started
  controller.abort()
  await ended
  expect(events).toEqual([
    { kind: 'round_start', round: 1 },
    { kind: 'end', status: 'cancelled' },
  ])
})

test('truncated stream after acceptance emits one failed network end', async () => {
  const { chat } = ports(() => stream([accepted, 'data: {"kind":"text_delta","text":"a"}\n\n']))
  const { events, onEvent, ended } = collect()
  await chat.run(request, onEvent)
  await ended
  expect(events).toEqual([
    { kind: 'text_delta', text: 'a' },
    { kind: 'end', status: 'failed', error: { code: 'network', message: 'Run stream ended without end' } },
  ])
})

test('failures before acceptance reject and emit nothing', async () => {
  const { events, onEvent } = collect()
  const refused = ports(() => Response.json({ error: { code: 'needs_config', message: 'no model' } }, { status: 400 }))
  await expect(refused.chat.run(request, onEvent)).rejects.toMatchObject({ code: 'needs_config' })
  const empty = ports(() => stream([]))
  await expect(empty.chat.run(request, onEvent)).rejects.toMatchObject({ code: 'network' })
  expect(events).toEqual([])
})

test('history and model options send query strings; approve and aborted probe reject', async () => {
  const { providers, chat, history, requests } = ports((input) =>
    input.method === 'DELETE' ? Response.json({ ok: true }) : Response.json([]),
  )
  await history.list('note:1')
  await providers.modelOptions({ modelType: 'chat', supportsTools: false })
  await expect(history.remove('c 1')).resolves.toBeUndefined()
  expect(requests.map((item) => item.url.replace(/^https?:\/\/[^/]+/, ''))).toEqual([
    '/api/ai/kit/conversations?scope=note%3A1',
    '/api/ai/kit/model-options?modelType=chat&supportsTools=false',
    '/api/ai/kit/conversations/c%201',
  ])
  await expect(chat.approve('r1', 'call', true)).rejects.toMatchObject({ code: 'unsupported' })
  const controller = new AbortController()
  controller.abort()
  await expect(
    providers.probe({ kind: 'saved', endpointId: 'e' }, { signal: controller.signal }),
  ).rejects.toMatchObject({ code: 'cancelled' })
})
