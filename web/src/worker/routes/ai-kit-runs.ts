import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { acquireSlot, parseBody } from '../ai/kit'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import {
  RunRequestSchema,
  executeRun,
  prepareRun,
  getRunSnapshot,
  saveRunSnapshot,
  requestRunCancel,
} from '../ai/runs'

export const aiRunRoutes = new Hono<AppBindings>()
const activeRuns = new Map<
  string,
  { signal: AbortSignal; completion: Promise<void> }
>()
const CANCEL_POLL_MS = 250
const CANCEL_WAIT_MS = 10_000
aiRunRoutes.get('/runs/:id', async (c) => {
  const userId = c.get('userId'),
    runId = c.req.param('id')
  const active = activeRuns.get(JSON.stringify([userId, runId]))
  if (active?.signal.aborted) await active.completion
  return c.json(await getRunSnapshot(c.env, userId, runId))
})

aiRunRoutes.post('/runs/:id/cancel', async (c) => {
  const userId = c.get('userId'),
    runId = c.req.param('id')
  await getRunSnapshot(c.env, userId, runId)
  await requestRunCancel(c.env, userId, runId)
  for (let waited = 0; ; waited += CANCEL_POLL_MS) {
    const snapshot = await getRunSnapshot(c.env, userId, runId)
    if (snapshot.status !== 'running' || waited >= CANCEL_WAIT_MS)
      return c.json(snapshot)
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, CANCEL_POLL_MS)
    await promise
  }
})

aiRunRoutes.post('/runs', async (c) => {
  const req = parseBody(
    RunRequestSchema,
    await readJson(c, JSON_BODY_LIMITS.run),
  )
  const userId = c.get('userId')
  const release = acquireSlot(userId)
  const prepared = await prepareRun(c.env, userId, req)
    .then(async (run) => {
      await saveRunSnapshot(c.env, userId, run)
      return run
    })
    .catch((error: unknown) => {
      release()
      throw error
    })
  const cancel = new AbortController()
  const abort = (): void => cancel.abort()
  c.req.raw.signal.addEventListener('abort', abort, { once: true })
  if (c.req.raw.signal.aborted) abort()
  const encoder = new TextEncoder()
  let open = true
  let controller: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
    cancel() {
      open = false
      cancel.abort()
    },
  })
  const send = (frame: unknown): void => {
    if (!open) return
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
    } catch {
      open = false
      cancel.abort()
    }
  }
  send({
    kind: 'accepted',
    runId: prepared.runId,
    conversationId: prepared.turn?.conversationId ?? null,
    turnId: prepared.turn?.turnId ?? null,
  })
  const poll = setInterval(() => {
    void getRunSnapshot(c.env, userId, prepared.runId).then(
      (snapshot) => {
        if (snapshot.cancelRequested) abort()
      },
      () => {},
    )
  }, CANCEL_POLL_MS)
  const task = executeRun(c.env, userId, prepared, cancel.signal, (event) => {
    send(event)
    if (event.kind === 'end' && open) {
      open = false
      controller.close()
    }
  }).finally(() => {
    clearInterval(poll)
    activeRuns.delete(JSON.stringify([userId, prepared.runId]))
    c.req.raw.signal.removeEventListener('abort', abort)
    release()
  })
  activeRuns.set(JSON.stringify([userId, prepared.runId]), {
    signal: cancel.signal,
    completion: task,
  })
  try {
    c.executionCtx.waitUntil(task)
  } catch {
    task.catch(() => {})
  }
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    },
  })
})
