import type { Protocol } from '@ouraihub/aether-ui/ports'
import type { Env } from '../../env'
import { KitFailure, addressAllowed, apiBase, isLoopback, parseTarget, readUpTo, upstreamFailure } from '../kit'
import { PROTOCOL_PATH, authHeaders } from '@ouraihub/aether-core/protocol/request'
import { requestKeys, withKeys } from '../providers'
import { modelLines } from './auth'
import { acquire, release } from './stream'
import { KEY_STATUS, KEEP_HEADERS, MAX_BODY, relayError, type LineRow } from './shared'

export async function forwardImage(env: Env, userId: string, keyId: string, maxConcurrent: number, request: Request, edit: boolean): Promise<Response> {
  const busy = acquire(keyId, maxConcurrent)
  if (busy) return busy
  try {
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (declared > MAX_BODY) return relayError(413, 'invalid_request_error', 'request body exceeds 10 MB')
    const { bytes: body, overflow } = await readUpTo(request.body, MAX_BODY)
    if (overflow) return relayError(413, 'invalid_request_error', 'request body exceeds 10 MB')
    let model: unknown
    let payload: Record<string, unknown> | null = null
    let form: FormData | null = null
    if (edit) {
      try {
        form = await new Request('https://relay.invalid', { method: 'POST', headers: { 'content-type': request.headers.get('content-type') ?? '' }, body }).formData()
        model = form.get('model')
      } catch {
        return relayError(400, 'invalid_request_error', 'request body is not valid multipart form data')
      }
    } else {
      try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(body))
        payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
        model = payload?.model
      } catch {
        return relayError(400, 'invalid_request_error', 'request body is not JSON')
      }
    }
    if (typeof model !== 'string' || !model) return relayError(400, 'invalid_request_error', 'model is required')
    const configured = await modelLines(env.DB, userId, 'image')
    const select = (candidate: string): LineRow[] => {
      const direct = configured.filter((line) => line.modelId === candidate)
      if (direct.length) return direct
      const selected = configured.find((line) => candidate === `${line.providerName}/${line.modelId}`)
      return selected ? configured.filter((line) => line.providerId === selected.providerId && line.modelId === selected.modelId) : []
    }
    const lines = select(model)
    if (!lines.length) return relayError(404, 'not_found_error', `model ${model} is not configured for image generation`)
    let upstreamBody: Uint8Array | string = body
    let contentType = request.headers.get('content-type')
    if (model !== lines[0]!.modelId) {
      if (form) {
        form.set('model', lines[0]!.modelId)
        const rewritten = new Request('https://relay.invalid', { method: 'POST', body: form })
        upstreamBody = new Uint8Array(await rewritten.arrayBuffer())
        contentType = rewritten.headers.get('content-type')
      } else upstreamBody = JSON.stringify({ ...payload, model: lines[0]!.modelId })
    }
    let last: KitFailure | null = null
    let rejected: { status: number; text: string; contentType: string } | null = null
    let resumeAt: number | null = null
    let pausedLines = 0
    let configurationFailure: KitFailure | null = null
    for (const line of lines) {
      const base = edit ? line.imageEditBaseUrl ?? line.baseUrl : line.imageBaseUrl ?? line.baseUrl
      const url = parseTarget(`${apiBase(base)}/images/${edit ? 'edits' : 'generations'}`)
      if (!(await addressAllowed(env.DB, url))) {
        last = new KitFailure('bad_request', 'upstream address blocked', { reason: 'blocked_address' })
        configurationFailure = last
        continue
      }
      let pool
      try {
        pool = await requestKeys(env, userId, line.endpointId, line.keyStrategy, `${line.providerName} · ${line.slug}`)
      } catch (error) {
        if (!(error instanceof KitFailure)) throw error
        last = error
        if (error.resumeAt !== null) {
          resumeAt = Math.min(resumeAt ?? error.resumeAt, error.resumeAt)
          pausedLines++
        } else configurationFailure = error
        continue
      }
      if (!pool.apiKeys.length && !isLoopback(url)) {
        last = new KitFailure('needs_config', 'missing key', { reason: 'missing_key' })
        configurationFailure = last
        continue
      }
      const known = [...pool.apiKeys]
      try {
        const response = await withKeys(pool, async (key) => {
          let upstream: Response
          try {
            upstream = await fetch(url, {
              method: 'POST',
              headers: { ...Object.fromEntries(Object.entries(JSON.parse(line.headers) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value])), ...authHeaders('openai-chat', key), ...(contentType ? { 'content-type': contentType } : {}) },
              body: upstreamBody,
              redirect: 'manual',
              signal: request.signal,
            })
          } catch {
            if (request.signal.aborted) throw new KitFailure('cancelled', 'cancelled')
            throw new KitFailure('network', 'upstream unreachable')
          }
          const read = await readUpTo(upstream.body, MAX_BODY).catch(() => {
            if (request.signal.aborted) throw new KitFailure('cancelled', 'cancelled')
            throw new KitFailure('network', 'upstream unreachable')
          })
          const text = new TextDecoder().decode(read.bytes)
          if (!upstream.ok) {
            const masked = known.reduce((value, secret) => (secret.trim() ? value.replaceAll(secret.trim(), '***') : value), text)
            rejected = { status: upstream.status, text: masked, contentType: upstream.headers.get('content-type') ?? 'application/json' }
            throw upstreamFailure(upstream.status, text, known, upstream.headers.get('retry-after'))
          }
          if (read.overflow) throw new KitFailure('bad_request', 'image response exceeds 10 MB', { field: 'images', reason: 'size' })
          return new Response(read.bytes, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' } })
        })
        return response
      } catch (error) {
        if (!(error instanceof KitFailure)) throw error
        last = error
        if (!error.upstream) break
        if (!(error.upstream.usedUp || KEY_STATUS.includes(Number(error.details.status)))) break
      }
    }
    if (rejected !== null) {
      const failed = rejected as { status: number; text: string; contentType: string }
      return new Response(failed.text, { status: failed.status, headers: { 'content-type': failed.contentType } })
    }
    if (last?.code === 'cancelled') return relayError(499, 'cancelled', 'cancelled')
    if (resumeAt !== null && pausedLines === lines.length) return relayError(429, 'rate_limit_error', `every key of the matching lines is set aside; earliest recovery ${new Date(resumeAt).toISOString()}`)
    return relayError(502, 'api_error', configurationFailure?.message ?? last?.message ?? 'no usable line')
  } finally {
    release(keyId)
  }
}


/** Forwards one agent request to the first matching line with a usable key (docs/43 §4). */
export async function forward(env: Env, userId: string, keyId: string, maxConcurrent: number, protocol: Protocol, request: Request): Promise<Response> {
  const busy = acquire(keyId, maxConcurrent)
  if (busy) return busy
  let held = true
  try {
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (declared > MAX_BODY) return relayError(413, 'invalid_request_error', 'request body exceeds 10 MB')
    const { bytes: body, overflow } = await readUpTo(request.body, MAX_BODY)
    if (overflow) return relayError(413, 'invalid_request_error', 'request body exceeds 10 MB')
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(body))
    } catch {
      return relayError(400, 'invalid_request_error', 'request body is not JSON')
    }
    const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    const model = 'model' in payload ? payload.model : undefined
    if (typeof model !== 'string' || !model) return relayError(400, 'invalid_request_error', 'model is required')

    const configured = await modelLines(env.DB, userId, 'chat')
    const all = configured.filter((line) => line.protocol === protocol)
    let lines = all.filter((line) => line.modelId === model)
    let upstreamBody: Uint8Array | string = body
    if (!lines.length) {
      const selected = all.find((line) => model === `${line.providerName}/${line.modelId}` && configured.find((candidate) => candidate.providerName === line.providerName)?.providerId === line.providerId)
      if (selected) {
        const modelId = model.slice(selected.providerName.length + 1)
        lines = all.filter((line) => line.providerId === selected.providerId && line.modelId === modelId)
        if (lines.length) upstreamBody = JSON.stringify({ ...payload, model: modelId })
      }
    }
    if (!lines.length) {
      const available = [...new Set(all.map((line) => line.modelId))]
      return relayError(404, 'not_found_error', `model ${model} is not configured for ${protocol}; available: ${available.join(', ') || 'none'}`)
    }

    const inbound = Object.fromEntries(KEEP_HEADERS.flatMap((name) => (request.headers.get(name) ? [[name, request.headers.get(name)!]] : [])))
    let last: KitFailure | null = null
    let resumeAt: number | null = null
    let pausedLines = 0
    let configurationFailure: KitFailure | null = null
    // Assigned inside the key callback; the cast keeps TypeScript from narrowing it to null here.
    let rejected = null as { status: number; text: string; contentType: string } | null
    for (const line of lines) {
      const url = parseTarget(`${apiBase(line.baseUrl)}/${PROTOCOL_PATH[protocol]}`)
      if (!(await addressAllowed(env.DB, url))) {
        last = new KitFailure('bad_request', 'upstream address blocked', { reason: 'blocked_address' })
        configurationFailure = last
        continue
      }
      let pool
      try {
        pool = await requestKeys(env, userId, line.endpointId, line.keyStrategy, `${line.providerName} · ${line.slug}`)
      } catch (error) {
        if (!(error instanceof KitFailure)) throw error
        last = error
        if (error.resumeAt !== null) {
          resumeAt = Math.min(resumeAt ?? error.resumeAt, error.resumeAt)
          pausedLines++
        } else configurationFailure = error
        continue
      }
      if (!pool.apiKeys.length && !isLoopback(url)) {
        last = new KitFailure('needs_config', 'missing key', { reason: 'missing_key' })
        configurationFailure = last
        continue
      }
      const known = [...pool.apiKeys]
      try {
        const response = await withKeys(pool, async (key) => {
          let upstream: Response
          try {
            upstream = await fetch(url, {
              method: 'POST',
              headers: { ...Object.fromEntries(Object.entries(JSON.parse(line.headers) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value])), ...authHeaders(protocol, key), ...inbound },
              body: upstreamBody,
              redirect: 'manual',
              signal: request.signal,
            })
          } catch {
            if (request.signal.aborted) throw new KitFailure('cancelled', 'cancelled')
            throw new KitFailure('network', 'upstream unreachable')
          }
          if (upstream.ok) return upstream
          const text = await upstream.text().catch(() => '')
          // A failure that does not switch keys or lines goes back to the agent unchanged.
          const masked = known.reduce((value, secret) => (secret.trim() ? value.replaceAll(secret.trim(), '***') : value), text)
          rejected = { status: upstream.status, text: masked, contentType: upstream.headers.get('content-type') ?? 'application/json' }
          throw upstreamFailure(upstream.status, text, known, upstream.headers.get('retry-after'))
        })
        if (!response.body) return new Response(null, { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' } })
        const reader = response.body.getReader()
        let finished = false
        const done = (): void => {
          if (finished) return
          finished = true
          release(keyId)
        }
        const readable = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { done: ended, value } = await reader.read()
              if (ended) { done(); controller.close() }
              else controller.enqueue(value)
            } catch (error) { done(); controller.error(error) }
          },
          cancel(reason) { done(); return reader.cancel(reason) },
        })
        held = false
        return new Response(readable, { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' } })
      } catch (error) {
        if (!(error instanceof KitFailure)) throw error
        last = error
        if (!error.upstream) {
          rejected = null
          break
        }
        // A line whose keys were all rejected or used up hands over to the next matching line.
        if (!(error.upstream.usedUp || KEY_STATUS.includes(Number(error.details.status)))) break
      }
    }
    if (rejected) return new Response(rejected.text, { status: rejected.status, headers: { 'content-type': rejected.contentType } })
    if (last?.code === 'cancelled') return relayError(499, 'cancelled', 'cancelled')
    if (resumeAt !== null && pausedLines === lines.length) {
      return relayError(429, 'rate_limit_error', `every key of the matching lines is set aside; earliest recovery ${new Date(resumeAt).toISOString()}`)
    }
    return relayError(502, 'api_error', configurationFailure?.message ?? last?.message ?? 'no usable line')
  } finally {
    if (held) release(keyId)
  }
}