import { describe, expect, it } from 'vitest'

import { sha256Hex } from '../src/worker/lib/encoding'
import { initializeDatabase } from '../src/worker/db/schema'

import { fetchMock, provider, setup } from './support/relay-test-setup'

describe('relay access keys and pause switch', () => {
  it(
    'rejects bad keys, stays paused until enabled, th' +
      'en forwards; revoked keys stop working',
    async () => {
      const { h, relay, token, auth } = await setup()
      await provider(
        h,
        'Acme',
        'https://acme.example.com',
        'sk-acme-0123456789',
      )
      expect(token).toMatch(/^anr_[A-Za-z0-9_-]{43}$/)
      const chat = (headers: Record<string, string>) =>
        relay.request(
          'POST',
          '/relay/v1/chat/completions',
          { model: 'm1', messages: [] },
          headers,
        )
      expect((await chat({ authorization: 'Bearer anr_wrong' })).status).toBe(
        401,
      )
      const paused = await chat(auth)
      expect(paused.status).toBe(503)
      expect(await paused.json()).toMatchObject({
        error: { type: 'relay_paused' },
      })
      expect(fetchMock).not.toHaveBeenCalled()
      await relay.request('PUT', '/api/relay', { enabled: true })
      fetchMock.mockResolvedValue(
        new Response('data: {}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
      )
      const ok = await chat({ 'x-api-key': token })
      expect(ok.status).toBe(200)
      expect(ok.headers.get('content-type')).toBe('text/event-stream')
      expect(await ok.text()).toBe('data: {}\n\n')
      const settings = await relay.json<{
        enabled: boolean
        endpoint: string
        keys: {
          id: string
          todayRequests: number
          lastUsedAt: number | null
        }[]
      }>('GET', '/api/relay')
      expect(settings).toMatchObject({
        enabled: true,
        endpoint: expect.stringMatching(/\/relay\/v1$/),
      })
      // The paused and the forwarded request were authenticated; the
      // bad key was not.
      expect(settings.keys[0]).toMatchObject({ todayRequests: 2 })
      expect(settings.keys[0]!.lastUsedAt).not.toBeNull()
      await relay.request('DELETE', `/api/relay/keys/${settings.keys[0]!.id}`)
      expect((await chat(auth)).status).toBe(401)
    },
  )

  it(
    'keeps a separate atomic manual-key cap and store' + 's only hashes',
    async () => {
      const { h, relay, token } = await setup()
      const stored = await h.env.DB.prepare(
        'SELECT key_hash FROM relay_access_keys',
      ).first<{
        key_hash: string
      }>()
      expect(stored?.key_hash).toBe(await sha256Hex(token))
      await h.env.DB.prepare(
        'INSERT INTO relay_access_keys (id, user_id, name' +
          ', key_hash, created_at, expires_at, github_run)\n' +
          "      VALUES ('github', 'user-a', 'GitHub', 'git" +
          "hub-hash', 0, ?1, 'acme/app#1#1')",
      )
        .bind(Date.now() + 100000)
        .run()
      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          relay.request('POST', '/api/relay/keys', { name: `manual ${i}` }),
        ),
      )
      expect(
        responses.filter((response) => response.status === 201),
      ).toHaveLength(19)
      expect(
        responses.filter((response) => response.status === 409),
      ).toHaveLength(1)
      expect(
        (
          await h.env.DB.prepare(
            'SELECT COUNT(*) AS count FROM relay_access_keys ' +
              'WHERE revoked_at IS NULL',
          ).first<{
            count: number
          }>()
        )?.count,
      ).toBe(21)
    },
  )

  it(
    'upgrades v29 to v30 without losing provider keys' + ' or notes',
    async () => {
      const { h, relay } = await setup()
      const endpointId = await provider(
        h,
        'Acme',
        'https://acme.example.com',
        'sk-acme-0123456789',
      )
      await h.env.DB.prepare(
        'INSERT INTO notes (id, user_id, title, content, ' +
          'excerpt, rev, created_at, updated_at)\n      VALU' +
          "ES ('retained', 'user-a', 'Retained', 'content'," +
          " '', 1, 1, 1)",
      ).run()
      await h.env.DB.exec(
        'DROP TABLE relay_access_keys; DROP TABLE relay_g' +
          'ithub_repos; DELETE FROM schema_migrations WHERE' +
          ' version = 30; DELETE FROM app_meta WHERE key = ' +
          "'database-state-v1'",
      )
      const old = h.env.DB
      h.env.DB = {
        prepare: old.prepare.bind(old),
        batch: old.batch.bind(old),
        exec: old.exec.bind(old),
      } as D1Database
      await initializeDatabase(h.env)
      expect(
        await h.env.DB.prepare(
          'SELECT version FROM schema_migrations WHERE vers' + 'ion = 30',
        ).first(),
      ).toEqual({ version: 30 })
      expect(
        await h.env.DB.prepare(
          "SELECT content FROM notes WHERE id = 'retained'",
        ).first(),
      ).toEqual({ content: 'content' })
      expect(await h.json('user-a', 'GET', '/providers')).toMatchObject({
        body: [{ endpoints: [{ id: endpointId, keys: [{ readable: true }] }] }],
      })
      const indexes = (
        await h.env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'ind" + "ex'",
        ).all<{
          name: string
        }>()
      ).results.map((row) => row.name)
      expect(indexes).toEqual(
        expect.arrayContaining([
          'idx_relay_access_keys_user',
          'idx_relay_access_keys_expires',
          'idx_relay_access_keys_run',
          'idx_relay_github_repos_user',
        ]),
      )
      expect(
        (
          await relay.request('POST', '/api/relay/keys', {
            name: 'after migration',
          })
        ).status,
      ).toBe(201)
      expect(
        (
          await relay.request('POST', '/api/relay/repos', {
            repo: 'acme/app',
            workflow: 'acme/app/.github/workflows/agent.yml',
          })
        ).status,
      ).toBe(200)
    },
  )
})
