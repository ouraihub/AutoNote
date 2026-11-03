import type { RunEvent, RunSnapshot } from '@ouraihub/aether-contracts'
import type { Env } from '../env'
import { setMeta } from '../db/metadata'
import { checkLength, notFound } from './kit'
import type { PreparedRun } from './run-prepare'

export async function saveRunSnapshot(
  env: Env,
  userId: string,
  run: PreparedRun,
  end?: Extract<RunEvent, { kind: 'end' }>,
  cancelRequested = false,
): Promise<void> {
  const snapshot: RunSnapshot = {
    runId: run.runId,
    conversationId: run.turn?.conversationId ?? null,
    turnId: run.turn?.turnId ?? null,
    status: end?.status ?? 'running',
    cancelRequested,
    ...(end?.error ? { error: end.error } : {}),
    ...(end?.exhausted === undefined ? {} : { exhausted: end.exhausted }),
  }
  await setMeta(
    env.DB,
    `ai-run:${userId}:${run.runId}`,
    JSON.stringify({
      ...snapshot,
      ...(end ? { completedAt: Date.now() } : {}),
    }),
  )
  const prefix = `ai-run:${userId}:`
  await env.DB.prepare(
    'DELETE FROM app_meta WHERE key IN (SELECT key FR' +
      'OM app_meta WHERE substr(key, 1, length(?1)) = ?' +
      "1 AND json_extract(value, '$.status') <> 'runnin" +
      "g' ORDER BY COALESCE(json_extract(value, '$.comp" +
      "letedAt'), 0) DESC, rowid DESC LIMIT -1 OFFSET 2" +
      '00)',
  )
    .bind(prefix)
    .run()
}

export async function getRunSnapshot(
  env: Env,
  userId: string,
  runId: string,
): Promise<RunSnapshot> {
  checkLength('runId', runId, 128)
  const value = await env.DB.prepare(
    "SELECT json_remove(value, '$.completedAt') AS va" +
      'lue FROM app_meta WHERE key = ?1',
  )
    .bind(`ai-run:${userId}:${runId}`)
    .first<{ value: string }>()
  if (!value) throw notFound('run')
  return JSON.parse(value.value) as RunSnapshot
}

export async function requestRunCancel(
  env: Env,
  userId: string,
  runId: string,
): Promise<void> {
  checkLength('runId', runId, 128)
  await env.DB.prepare(
    "UPDATE app_meta SET value = json_set(value, '$.c" +
      "ancelRequested', json('true')) WHERE key = ?1 AN" +
      "D json_extract(value, '$.status') = 'running'",
  )
    .bind(`ai-run:${userId}:${runId}`)
    .run()
}
