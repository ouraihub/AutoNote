import type { OutboundHttp } from '@ouraihub/aether-core/ports'
import type { Env } from '../env'
import { addressAllowed, badRequest, cancelled, KitFailure, parseTarget, readUpTo, upstreamFailure } from './kit'
import { withKeys, type Connection } from './providers'
import { authHeaders } from '@ouraihub/aether-core/protocol/request'

/** Host address policy stays at the network boundary, including redirected fetch targets. */
export function outbound(env: Env): OutboundHttp {
  return {
    async fetch(raw, init) {
      const url = parseTarget(raw)
      if (!(await addressAllowed(env.DB, url))) throw badRequest('url', 'blocked_address')
      const request: RequestInit & { credentials: 'omit' } = { ...init, redirect: 'manual', credentials: 'omit' }
      return fetch(url, request)
    },
  }
}

export function modelOutbound(env: Env, connection: Connection): OutboundHttp {
  const http = outbound(env)
  return {
    async fetch(url, init) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              if (!reader) {
                const first = await withKeys(connection, async (key) => {
                  const headers = new Headers(init.headers)
                  headers.delete('authorization')
                  headers.delete('x-api-key')
                  for (const [name, value] of Object.entries(authHeaders(connection.protocol, key)))
                    headers.set(name, value)
                  let response: Response
                  try {
                    response = await http.fetch(url, { ...init, headers: Object.fromEntries(headers) })
                  } catch (error) {
                    if (init.signal?.aborted) throw cancelled()
                    if (error instanceof KitFailure) throw error
                    throw new KitFailure('network', 'upstream unreachable')
                  }
                  if (!response.ok) {
                    const body = await readUpTo(response.body, 8192).catch(() => ({ bytes: new Uint8Array(0) }))
                    const text = new TextDecoder().decode(body.bytes)
                    const failure = upstreamFailure(
                      response.status,
                      text,
                      [...connection.apiKeys, ...Object.values(connection.headers)],
                      response.headers.get('retry-after'),
                    )
                    if (
                      response.status === 400 &&
                      /(?:tools?|function.calling).{0,80}(?:not supported|unsupported|not available)|(?:not supported|unsupported).{0,80}(?:tools?|function.calling)/is.test(
                        text,
                      )
                    )
                      failure.details.reason = 'tools_unsupported'
                    throw failure
                  }
                  if (!response.body) throw new KitFailure('network', 'upstream unreachable')
                  const candidate = response.body.getReader()
                  try {
                    return { reader: candidate, chunk: await candidate.read() }
                  } catch {
                    void candidate.cancel().catch(() => {})
                    if (init.signal?.aborted) throw cancelled()
                    throw new KitFailure('network', 'upstream unreachable')
                  }
                })
                reader = first.reader
                if (init.signal?.aborted) {
                  await reader.cancel()
                  throw cancelled()
                }
                if (first.chunk.done) {
                  controller.close()
                  reader.releaseLock()
                } else controller.enqueue(first.chunk.value)
                return
              }
              const chunk = await reader.read()
              if (chunk.done) {
                controller.close()
                reader.releaseLock()
              } else controller.enqueue(chunk.value)
            } catch (error) {
              controller.error(error)
              void reader?.cancel().catch(() => {})
            }
          },
          cancel: () => reader?.cancel(),
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  }
}
