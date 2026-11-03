import { describe, expect, it } from 'vitest'

import { initializeDatabase } from '../src/worker/db/schema'

import { createHarness } from './support/ai-kit-harness'
import { saveProvider } from './support/ai-kit-test-setup'

describe('run and history routes', () => {
  it(
    'upgrades a v23 endpoint table to v24 with empty ' +
      'request configuration',
    async () => {
      const h = await createHarness()
      const { endpointId } = await saveProvider(h)
      await h.env.DB.exec(
        'ALTER TABLE ai_endpoints DROP COLUMN image_base_' +
          'url; ALTER TABLE ai_endpoints DROP COLUMN header' +
          's; DELETE FROM schema_migrations WHERE version =' +
          " 24; DELETE FROM app_meta WHERE key = 'database-" +
          "state-v1'",
      )
      const old = h.env.DB
      h.env.DB = {
        prepare: old.prepare.bind(old),
        batch: old.batch.bind(old),
        exec: old.exec.bind(old),
      } as D1Database
      await initializeDatabase(h.env)
      const columns = (
        await h.env.DB.prepare('PRAGMA table_info(ai_endpoints)').all<{
          name: string
        }>()
      ).results.map((row) => row.name)
      expect(columns).toEqual(
        expect.arrayContaining(['image_base_url', 'headers']),
      )
      expect(await h.json('user-a', 'GET', '/providers')).toMatchObject({
        status: 200,
        body: [
          {
            endpoints: [
              {
                id: endpointId,
                imageBaseUrl: null,
                headers: {},
                keys: [{ masked: expect.any(String) }],
              },
            ],
          },
        ],
      })
    },
  )

  it(
    'upgrades a v24 endpoint table to v25 with no ima' + 'ge edit base URL',
    async () => {
      const h = await createHarness()
      const { endpointId } = await saveProvider(h)
      await h.env.DB.exec(
        'ALTER TABLE ai_endpoints DROP COLUMN image_edit_' +
          'base_url; DELETE FROM schema_migrations WHERE ve' +
          "rsion = 25; DELETE FROM app_meta WHERE key = 'da" +
          "tabase-state-v1'",
      )
      const old = h.env.DB
      h.env.DB = {
        prepare: old.prepare.bind(old),
        batch: old.batch.bind(old),
        exec: old.exec.bind(old),
      } as D1Database
      await initializeDatabase(h.env)
      const columns = (
        await h.env.DB.prepare('PRAGMA table_info(ai_endpoints)').all<{
          name: string
        }>()
      ).results.map((row) => row.name)
      expect(columns).toContain('image_edit_base_url')
      expect(await h.json('user-a', 'GET', '/providers')).toMatchObject({
        status: 200,
        body: [{ endpoints: [{ id: endpointId, imageEditBaseUrl: null }] }],
      })
    },
  )

  it(
    'upgrades a v28 endpoint to v29 keeping rotation ' + 'and its keys usable',
    async () => {
      const h = await createHarness()
      const { endpointId } = await saveProvider(h)
      await h.env.DB.exec(
        'ALTER TABLE ai_endpoints DROP COLUMN key_strateg' +
          'y; ALTER TABLE ai_endpoint_keys DROP COLUMN exha' +
          'usted_until; ALTER TABLE ai_endpoint_keys DROP C' +
          'OLUMN exhausted_reason; DELETE FROM schema_migra' +
          'tions WHERE version = 29; DELETE FROM app_meta W' +
          "HERE key = 'database-state-v1'",
      )
      const old = h.env.DB
      h.env.DB = {
        prepare: old.prepare.bind(old),
        batch: old.batch.bind(old),
        exec: old.exec.bind(old),
      } as D1Database
      await initializeDatabase(h.env)
      expect(await h.json('user-a', 'GET', '/providers')).toMatchObject({
        status: 200,
        body: [
          {
            endpoints: [
              {
                id: endpointId,
                keyStrategy: 'round_robin',
                keys: [
                  {
                    readable: true,
                    exhaustedUntil: null,
                    exhaustedReason: null,
                  },
                ],
              },
            ],
          },
        ],
      })
    },
  )

  it(
    'stores provider model notes, keeps them when omi' +
      'tted and rejects oversized notes',
    async () => {
      const h = await createHarness()
      const { providerId } = await saveProvider(h)
      const put = (extra: Record<string, unknown>) =>
        h.json<
          {
            notes: string
          }[]
        >('user-a', 'PUT', '/providers', {
          id: providerId,
          name: 'Acme',
          endpoints: [],
          ...extra,
        })
      expect((await put({ notes: '## 价格\n- 便宜' })).body[0]?.notes).toBe(
        '## 价格\n- 便宜',
      )
      expect((await put({})).body[0]?.notes).toBe('## 价格\n- 便宜')
      expect(await put({ notes: 'x'.repeat(10001) })).toMatchObject({
        status: 400,
      })
      expect(
        (
          await h.json<
            {
              notes: string
            }[]
          >('user-a', 'GET', '/providers')
        ).body[0]?.notes,
      ).toBe('## 价格\n- 便宜')
    },
  )

  it(
    'seeds a host preset once per user, adopts a same' +
      '-named provider and refuses to delete presets',
    async () => {
      const h = await createHarness()
      type Listed = {
        id: string
        name: string
        presetId: string | null
        enabled: boolean
      }[]
      const seed = (user: string, name: string, presetId: string) =>
        h.json<Listed>(user, 'PUT', '/providers', {
          name,
          presetId,
          enabled: false,
          endpoints: [
            {
              slug: 'ep-1',
              baseUrl: 'https://api.qnaigc.com',
              protocol: 'openai-chat',
              models: [],
            },
          ],
        })
      const first = await seed('user-a', '七牛云', 'qiniu')
      expect(first.body).toMatchObject([
        { name: '七牛云', presetId: 'qiniu', enabled: false },
      ])
      expect((await seed('user-a', '七牛云', 'qiniu')).body).toHaveLength(1)
      expect(
        await h.json('user-a', 'DELETE', `/providers/${first.body[0]!.id}`),
      ).toMatchObject({ status: 409 })
      expect(
        (await h.json<Listed>('user-a', 'GET', '/providers')).body,
      ).toHaveLength(1)
      expect((await seed('user-b', '七牛云', 'qiniu')).body).toMatchObject([
        { presetId: 'qiniu' },
      ])
      const own = (
        await h.json<Listed>('user-a', 'PUT', '/providers', {
          name: 'Fenno',
          endpoints: [],
        })
      ).body.find((p) => p.name === 'Fenno')!
      const adopted = (await seed('user-a', 'fenno', 'fenno')).body
      expect(adopted).toHaveLength(2)
      expect(adopted.find((p) => p.id === own.id)).toMatchObject({
        name: 'Fenno',
        presetId: 'fenno',
      })
    },
  )
})
