import { expect, test, vi } from 'vitest'
import type { Conversation } from '@ouraihub/aether-ui/ports'
import { MemoryTabBus } from '../tab-bus'
import { HttpTransport } from '../transport'
import { createHttpKitPorts } from './kit'

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

test(
  'history and model options send query strings; approve ' +
    'and aborted probe reject',
  async () => {
    const { providers, chat, history, requests } = ports((input) =>
      input.method === 'DELETE'
        ? Response.json({ ok: true })
        : Response.json([]),
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
  },
)

test(
  'history actions forward exact IDs, methods and edit ' + 'CAS body',
  async () => {
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
    await expect(history.removeTurn('c 1', 't/1')).resolves.toEqual(
      conversation,
    )
    await expect(history.fork('c 1', 't/1')).resolves.toEqual(conversation)
    await expect(history.selectTurn('c 1', 't/1')).resolves.toEqual(
      conversation,
    )
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
  },
)
