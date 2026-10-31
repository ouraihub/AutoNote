import { expect, test } from 'vitest'
import type { Logger } from '@app/log/logger'
import type { Timers } from '../platform/timers'
import { HttpTransport } from './transport'
import { createMemoryTabBusChannel, MemoryTabBus } from './tab-bus'

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

class TestTimers implements Timers {
  #next = 1
  readonly callbacks = new Map<number, () => void>()
  setTimeout(listener: () => void): number {
    const id = this.#next++
    this.callbacks.set(id, listener)
    return id
  }
  clearTimeout(id: number): void {
    this.callbacks.delete(id)
  }
  setInterval(): number {
    return 0
  }
  clearInterval(): void {}
}

function makeTransport(
  fetch: (request: Request) => Promise<Response>,
  timers = new TestTimers(),
): HttpTransport {
  return new HttpTransport({
    fetch,
    clientId: 'client-a',
    getLocale: () => 'zh-CN',
    bus: new MemoryTabBus('user-a'),
    timers,
    logger,
  })
}

test('构造 JSON 请求、查询参数和成功写广播', async () => {
  const channel = createMemoryTabBusChannel()
  const receiver = new MemoryTabBus('user-a', channel)
  const messages: unknown[] = []
  receiver.subscribe((message) => messages.push(message))
  const transport = new HttpTransport({
    fetch: async (request) => {
      expect(request.method).toBe('POST')
      expect(request.url).toBe(
        'http://autonote.invalid/api/notes?enabled=1&empty=0',
      )
      expect(request.headers.get('X-AutoNote-Client')).toBe('1')
      expect(request.headers.get('X-AutoNote-Origin')).toBe('client-a')
      expect(request.headers.get('Accept-Language')).toBe('zh-CN')
      expect(request.headers.get('Content-Type')).toBe('application/json')
      await expect(request.json()).resolves.toEqual({ title: 'hello' })
      return Response.json({ ok: true })
    },
    clientId: 'client-a',
    getLocale: () => 'zh-CN',
    bus: new MemoryTabBus('user-a', channel),
    timers: new TestTimers(),
    logger,
  })
  await expect(
    transport.json({
      method: 'POST',
      path: '/api/notes',
      query: { enabled: true, empty: false, skipped: undefined },
      body: { title: 'hello' },
    }),
  ).resolves.toEqual({ ok: true })
  expect(messages).toEqual([
    { type: 'local-write', clientId: 'client-a', userId: 'user-a' },
  ])
  receiver.close()
})

test('FormData 请求不手动设置 Content-Type', async () => {
  const form = new FormData()
  form.set('file', new File(['content'], 'note.txt', { type: 'text/plain' }))
  const transport = makeTransport(async (request) => {
    expect(request.headers.get('Content-Type')).toMatch(
      /^multipart\/form-data; boundary=/,
    )
    expect(await request.formData()).toBeInstanceOf(FormData)
    return Response.json({ uploaded: true })
  })
  await expect(
    transport.json({ method: 'POST', path: '/api/files', form }),
  ).resolves.toEqual({ uploaded: true })
})

test('401/409 只保留安全 details', async () => {
  const transport = makeTransport(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'conflict',
            message: 'conflict',
            details: {
              server: { bad: true },
              cause: '/secret/db',
              retryAfter: 4,
            },
          },
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
  )
  await expect(transport.json({ path: '/api/notes/x' })).rejects.toMatchObject({
    code: 'conflict',
    status: 409,
    details: { retryAfter: 4 },
  })

  const unauthorized = makeTransport(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'unauthenticated',
            message: 'expired',
            details: { cause: 'token' },
          },
        }),
        {
          status: 401,
          headers: { 'content-type': 'application/json' },
        },
      ),
  )
  await expect(
    unauthorized.json({ path: '/api/auth/session' }),
  ).rejects.toMatchObject({
    code: 'unauthenticated',
    status: 401,
  })
})

test('调用方取消和超时转换为不同错误并清理 timer', async () => {
  const timers = new TestTimers()
  const transport = makeTransport(
    (request) =>
      new Promise<Response>((_, reject) => {
        request.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          {
            once: true,
          },
        )
      }),
    timers,
  )
  const controller = new AbortController()
  const cancelled = transport.json({
    path: '/api/notes/x',
    timeoutMs: 50,
    signal: controller.signal,
  })
  controller.abort()
  await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' })
  expect(timers.callbacks.size).toBe(0)

  const timedOut = transport.json({ path: '/api/notes/x', timeoutMs: 50 })
  const timeoutCallback = timers.callbacks.values().next().value
  timeoutCallback?.()
  await expect(timedOut).rejects.toMatchObject({ code: 'request_timeout' })
})

test('204 和下载 raw 成功返回原始响应', async () => {
  const transport = makeTransport(
    async () => new Response(null, { status: 204 }),
  )
  await expect(
    transport.json({ method: 'DELETE', path: '/api/notes/x' }),
  ).resolves.toBeUndefined()
  const raw = makeTransport(async () => new Response('bytes', { status: 200 }))
  await expect(
    raw.raw({ path: '/api/export?format=zip' }),
  ).resolves.toBeInstanceOf(Response)
})

test('网络失败抛 offline 而不是伪造服务端错误', async () => {
  const transport = makeTransport(async () => {
    throw new TypeError('Failed to fetch')
  })
  await expect(transport.json({ path: '/api/notes' })).rejects.toMatchObject({
    code: 'offline',
    status: 0,
  })
  expect(transport).toBeInstanceOf(HttpTransport)
})

test('rejects an old account response whose body finishes after epoch changes without broadcasting', async () => {
  let epoch = 1
  const { promise, resolve } = Promise.withResolvers<string>()
  const messages: unknown[] = []
  const response = Response.json({ ok: true })
  response.text = () => promise
  const transport = new HttpTransport({
    fetch: async () => response,
    clientId: 'tab',
    getLocale: () => 'en-US',
    timers: new TestTimers(),
    logger,
    bus: {
      post: (message) => messages.push(message),
      subscribe: () => () => undefined,
      close() {},
    },
    captureCurrent: () => {
      const started = epoch
      return () => started === epoch
    },
  })
  const result = transport.json({ method: 'POST', path: '/api/notes' })
  epoch++
  resolve('{"ok":true}')
  await expect(result).rejects.toMatchObject({ code: 'cancelled' })
  expect(messages).toEqual([])
})
