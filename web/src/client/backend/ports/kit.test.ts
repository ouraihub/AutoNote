import { expect, test, vi } from 'vitest'
import type {
  Conversation,
  RunEvent,
  RunRequest,
} from '@ouraihub/aether-ui/ports'
import { MemoryTabBus } from '../tab-bus'
import { HttpTransport } from '../transport'
import { createHttpKitPorts } from './kit'

const request: RunRequest = {
  purpose: 'chat',
  skills: [],
  permissionMode: 'default',
  input: '你好',
  regenerate: false,
  language: 'zh-CN',
}
const accepted =
  'data: {"kind":"accepted","runId":"r1","conversationId":"c1","turnId":"t1"}\n\n'

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
    timers: {
      setTimeout: () => 0,
      clearTimeout() {},
      setInterval: () => 0,
      clearInterval() {},
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  })
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const kit = createHttpKitPorts(transport, logger)
  if (!kit.providers || !kit.chat || !kit.conversations)
    throw new Error('missing ports')
  return {
    providers: kit.providers,
    chat: kit.chat,
    history: kit.conversations,
    requests,
    logger,
  }
}

function stream(
  chunks: readonly (string | Uint8Array)[],
  close = true,
): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(
            typeof chunk === 'string' ? encoder.encode(chunk) : chunk,
          )
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
      {
        error: {
          code: 'conflict',
          message: 'dup',
          details: { field: 'name', reason: 'duplicate' },
        },
      },
      { status: 409 },
    ),
  )
  await expect(
    providers.save({ id: null, name: 'x', endpoints: [] } as never),
  ).rejects.toMatchObject({
    name: 'KitClientError',
    code: 'conflict',
    message: 'dup',
    details: { field: 'name', reason: 'duplicate' },
  })
})

test('maps AutoNote and transport failures to Kit codes', async () => {
  const unauthorized = ports(() =>
    Response.json(
      { error: { code: 'unauthenticated', message: 'no' } },
      { status: 401 },
    ),
  )
  await expect(unauthorized.providers.list()).rejects.toMatchObject({
    code: 'unauthorized',
  })
  const tooLarge = ports(() =>
    Response.json(
      { error: { code: 'payload_too_large', message: 'big' } },
      { status: 413 },
    ),
  )
  await expect(tooLarge.providers.list()).rejects.toMatchObject({
    code: 'bad_request',
    details: { reason: 'too_large' },
  })
  const other = ports(() =>
    Response.json(
      { error: { code: 'storage_unavailable', message: 'down' } },
      { status: 503 },
    ),
  )
  await expect(other.providers.list()).rejects.toMatchObject({
    code: 'internal',
  })
  const offline = ports(() => {
    throw new TypeError('Failed to fetch')
  })
  await expect(offline.providers.list()).rejects.toMatchObject({
    code: 'network',
  })
})

test('run resolves on accepted, then delivers events in order with one end', async () => {
  const end = 'data: {"kind":"end","status":"completed"}\n\n'
  const bytes = new TextEncoder().encode(
    `${accepted}data: {"kind":"text_delta","text":"汉字"}\r\n\r\n${end}`,
  )
  const split = bytes.indexOf(0xe6) + 1
  const { chat, requests } = ports(() =>
    stream([
      bytes.slice(0, split),
      bytes.slice(split),
      'data: {"kind":"text_delta","text":"late"}\n\n',
      end,
    ]),
  )
  const { events, onEvent, ended } = collect()
  await expect(chat.start(request, onEvent)).resolves.toEqual({
    runId: 'r1',
    conversationId: 'c1',
    turnId: 't1',
  })
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
  const { chat } = ports((input) =>
    input.method === 'GET'
      ? Response.json({
          runId: 'r1',
          conversationId: 'c1',
          turnId: 't1',
          status: 'cancelled',
          cancelRequested: true,
        })
      : stream([accepted, 'data: {"kind":"round_start","round":1}\n\n'], false),
  )
  const controller = new AbortController()
  const { events, onEvent, started, ended } = collect()
  await chat.start(request, onEvent, { signal: controller.signal })
  await started
  controller.abort()
  await ended
  expect(events).toEqual([
    { kind: 'round_start', round: 1 },
    { kind: 'end', status: 'cancelled' },
  ])
})

test('truncated stream recovers only an authoritative terminal snapshot', async () => {
  const { chat } = ports((input) =>
    input.method === 'GET'
      ? Response.json({
          runId: 'r1',
          conversationId: 'c1',
          turnId: 't1',
          status: 'completed',
          cancelRequested: false,
        })
      : stream([accepted, 'data: {"kind":"text_delta","text":"a"}\n\n']),
  )
  const { events, onEvent, ended } = collect()
  await chat.start(request, onEvent)
  await ended
  expect(events).toEqual([
    { kind: 'text_delta', text: 'a' },
    { kind: 'end', status: 'completed' },
  ])
})

test('failures before acceptance reject and emit nothing', async () => {
  const { events, onEvent } = collect()
  const refused = ports(() =>
    Response.json(
      { error: { code: 'needs_config', message: 'no model' } },
      { status: 400 },
    ),
  )
  await expect(refused.chat.start(request, onEvent)).rejects.toMatchObject({
    code: 'needs_config',
  })
  const empty = ports(() => stream([]))
  await expect(empty.chat.start(request, onEvent)).rejects.toMatchObject({
    code: 'network',
  })
  expect(events).toEqual([])
})

test('history and model options send query strings; approve and aborted probe reject', async () => {
  const { providers, chat, history, requests } = ports((input) =>
    input.method === 'DELETE' ? Response.json({ ok: true }) : Response.json([]),
  )
  await history.list('note:1')
  await providers.modelOptions({ modelType: 'chat', supportsTools: false })
  await expect(history.remove('c 1')).resolves.toBeUndefined()
  expect(
    requests.map((item) => item.url.replace(/^https?:\/\/[^/]+/, '')),
  ).toEqual([
    '/api/ai/kit/conversations?scope=note%3A1',
    '/api/ai/kit/model-options?modelType=chat&supportsTools=false',
    '/api/ai/kit/conversations/c%201',
  ])
  await expect(chat.approve('r1', 'call', true)).rejects.toMatchObject({
    code: 'unsupported',
  })
  const controller = new AbortController()
  controller.abort()
  await expect(
    providers.probe(
      { kind: 'saved', endpointId: 'e' },
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({ code: 'cancelled' })
})

test('history actions forward exact IDs, methods and edit CAS body', async () => {
  const conversation: Conversation = {
    summary: {
      id: 'c 1',
      title: 'Question',
      scope: null,
      createdAt: 0,
      updatedAt: 0,
      selectedTurnId: 't/1',
    },
    turns: [],
  }
  const { history, requests } = ports(() => Response.json(conversation))
  await expect(history.editTurn('c 1', 't/1', 'new', 'old')).resolves.toEqual(
    conversation,
  )
  await expect(history.removeTurn('c 1', 't/1')).resolves.toEqual(conversation)
  await expect(history.fork('c 1', 't/1')).resolves.toEqual(conversation)
  await expect(history.selectTurn('c 1', 't/1')).resolves.toEqual(conversation)
  expect(
    requests.map((item) => [item.method, new URL(item.url).pathname]),
  ).toEqual([
    ['PATCH', '/api/ai/kit/conversations/c%201/turns/t%2F1'],
    ['DELETE', '/api/ai/kit/conversations/c%201/turns/t%2F1'],
    ['POST', '/api/ai/kit/conversations/c%201/fork'],
    ['PUT', '/api/ai/kit/conversations/c%201/selection'],
  ])
  await expect(requests[0]!.json()).resolves.toEqual({
    text: 'new',
    expectedText: 'old',
  })
  await expect(requests[2]!.json()).resolves.toEqual({ turnId: 't/1' })
  await expect(requests[3]!.json()).resolves.toEqual({ turnId: 't/1' })
})

test('run forwards retry, model, selected ancestry and translation fields unchanged', async () => {
  const { chat, requests } = ports(() =>
    stream([accepted, 'data: {"kind":"end","status":"completed"}\n\n']),
  )
  const retry = {
    ...request,
    conversationId: 'c1',
    retryTurnId: 't1',
    model: { endpointId: 'e2', modelId: 'm2' },
  }
  await chat.start(retry, () => {})
  const translation = {
    ...request,
    conversationId: 'c1',
    translateTurnId: 't1',
    targetLanguage: 'French',
  }
  await chat.start(translation, () => {})
  const continuation = { ...request, conversationId: 'c1', replyToId: 't1' }
  await chat.start(continuation, () => {})
  await expect(requests[0]!.json()).resolves.toEqual(retry)
  await expect(requests[1]!.json()).resolves.toEqual(translation)
  await expect(requests[2]!.json()).resolves.toEqual(continuation)
})

test('HTTP ports preserve permission mode and surface unsupported-mode rejection without downgrading', async () => {
  const { chat, requests } = ports(() =>
    Response.json(
      {
        error: {
          code: 'bad_request',
          message: 'Mode not allowed',
          details: { field: 'permission_mode', reason: 'not_allowed' },
        },
      },
      { status: 400 },
    ),
  )
  await expect(
    chat.start({ ...request, permissionMode: 'full_access' }, () => {}),
  ).rejects.toMatchObject({
    code: 'bad_request',
    details: { field: 'permission_mode', reason: 'not_allowed' },
  })
  await expect(requests[0]!.json()).resolves.toMatchObject({
    permissionMode: 'full_access',
  })
})

test('disconnection with a running snapshot reports unknown transport failure, never completion or cancellation', async () => {
  const { chat, logger, requests } = ports((input) =>
    input.method === 'GET'
      ? Response.json({
          runId: 'r1',
          conversationId: 'c1',
          turnId: 't1',
          status: 'running',
          cancelRequested: false,
        })
      : stream([accepted]),
  )
  const { events, onEvent, ended } = collect()
  await chat.start(request, onEvent)
  await vi.waitFor(() =>
    expect(logger.warn).toHaveBeenCalledWith('ai.run.stream.disconnected', {
      runId: 'r1',
    }),
  )
  await ended
  expect(events).toEqual([
    {
      kind: 'end',
      status: 'failed',
      error: {
        code: 'network',
        message: 'Run outcome unknown; reopen the conversation',
        details: { reason: 'outcome_unknown' },
      },
    },
  ])
  expect(requests.filter((request) => request.method === 'POST')).toHaveLength(
    1,
  )
  expect(requests.filter((request) => request.method === 'GET')).toHaveLength(1)
})

test('explicit cancel asks the server, then drops the stream with the server terminal state', async () => {
  const { chat, requests } = ports((input) =>
    input.method === 'POST' && input.url.endsWith('/cancel')
      ? Response.json({
          runId: 'r1',
          conversationId: 'c1',
          turnId: 't1',
          status: 'cancelled',
          cancelRequested: true,
        })
      : input.method === 'GET'
        ? Response.json({
            runId: 'r1',
            conversationId: 'c1',
            turnId: 't1',
            status: 'cancelled',
            cancelRequested: true,
          })
        : stream([accepted], false),
  )
  const { events, onEvent, ended } = collect()
  await chat.start(request, onEvent)
  await chat.cancel('r1')
  await ended
  expect(events).toEqual([{ kind: 'end', status: 'cancelled' }])
  expect([requests[1]!.method, new URL(requests[1]!.url).pathname]).toEqual([
    'POST',
    '/api/ai/kit/runs/r1/cancel',
  ])
})

test('cancel of a run still running on another server instance is a conflict', async () => {
  const { chat } = ports(() =>
    Response.json({
      runId: 'r1',
      conversationId: 'c1',
      turnId: 't1',
      status: 'running',
      cancelRequested: false,
    }),
  )
  await expect(chat.cancel('r1')).rejects.toMatchObject({ code: 'conflict' })
})

test('unavailable snapshot reports unknown without replaying the accepted request', async () => {
  const { chat, requests } = ports((input) =>
    input.method === 'GET'
      ? Response.json(
          { error: { code: 'not_found', message: 'Missing run' } },
          { status: 404 },
        )
      : stream([accepted]),
  )
  const { events, onEvent, ended } = collect()
  await chat.start(request, onEvent)
  await ended
  expect(events).toEqual([
    expect.objectContaining({
      kind: 'end',
      status: 'failed',
      error: expect.objectContaining({
        code: 'network',
        details: { reason: 'outcome_unknown' },
      }),
    }),
  ])
  expect(requests.map((request) => request.method)).toEqual(['POST', 'GET'])
})
