import { describe, expect, it, vi } from 'vitest'

import { sha256Hex, toBase64Url, utf8 } from '../src/worker/lib/encoding'

import { fetchMock, provider, setup } from './support/relay-test-setup'

describe('GitHub OIDC exchange', () => {
  async function signer() {
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    const sign = async (claims: Record<string, unknown>, kid = 'k1') => {
      const encode = (value: unknown) =>
        toBase64Url(utf8(JSON.stringify(value)))
      const input =
        '' + `${encode({ alg: 'RS256', kid })}` + '.' + `${encode(claims)}` + ''
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        utf8(input),
      )
      return `${input}.${toBase64Url(signature)}`
    }
    return { jwks: { keys: [{ ...jwk, kid: 'k1' }] }, sign }
  }

  it(
    'issues a 6-hour key only to the registered workf' +
      'low of a registered repository while the relay i' +
      's enabled',
    async () => {
      const { h, relay } = await setup()
      await provider(
        h,
        'Acme',
        'https://acme.example.com',
        'sk-acme-0123456789',
      )
      const { jwks, sign } = await signer()
      const now = Math.floor(Date.now() / 1000)
      // A plain workflow run of acme/app on main, pushed (no
      // job_workflow_ref).
      const claims = {
        iss: 'https://token.actions.githubusercontent.com',
        aud: 'http://localhost',
        exp: now + 300,
        repository: 'acme/app',
        ref: 'refs/heads/main',
        event_name: 'push',
        workflow_ref:
          'acme/app/.github/workflows/agent.yml@refs/heads/' + 'main',
        run_id: '42',
        run_attempt: '1',
        repository_id: '12345',
      }
      fetchMock.mockImplementation(async (url) =>
        String(url).endsWith('/.well-known/jwks')
          ? Response.json(jwks)
          : Response.json({ ok: true }),
      )
      const exchange = async (token: string) =>
        relay.request('POST', '/relay/github/token', { token })
      expect((await exchange(await sign(claims))).status).toBe(403)
      await relay.request('POST', '/api/relay/repos', {
        repo: 'acme/app',
        workflow: 'acme/app/.github/workflows/agent.yml',
      })
      expect((await exchange(await sign(claims))).status).toBe(503)
      await relay.request('PUT', '/api/relay', { enabled: true })
      for (const [bad, reason] of [
        [
          { ...claims, ref: 'refs/pull/7/merge', event_name: 'pull_request' },
          'ref',
        ],
        [{ ...claims, event_name: 'pull_request_target' }, 'event'],
        [{ ...claims, event_name: 'workflow_run' }, 'event'],
        [{ ...claims, event_name: 'issue_comment' }, 'event'],
        [{ ...claims, event_name: 'release' }, 'event'],
        [
          {
            ...claims,
            ref: 'refs/heads/feature',
            workflow_ref:
              'acme/app/.github/workflows/agent.yml@refs/heads/' + 'feature',
          },
          'ref',
        ],
        [
          {
            ...claims,
            workflow_ref:
              'acme/app/.github/workflows/steal.yml@refs/heads/' + 'main',
          },
          'workflow',
        ],
        [
          {
            ...claims,
            job_workflow_ref:
              'tools/ci/.github/workflows/agent.yml@refs/heads/' + 'main',
          },
          'workflow',
        ],
        [{ ...claims, aud: 'https://evil.example.com' }, 'audience'],
        [{ ...claims, exp: now - 10 }, 'expired'],
        [{ ...claims, repository_id: '' }, 'malformed'],
        [{ ...claims, run_attempt: '' }, 'malformed'],
      ] as const) {
        const denied = await exchange(await sign(bad))
        expect(denied.status).toBe(401)
        expect(JSON.stringify(await denied.json())).toContain(reason)
      }
      const forged = (await sign(claims)).replace(
        /\.[^.]+$/,
        `.${toBase64Url(new Uint8Array(256))}`,
      )
      expect((await exchange(forged)).status).toBe(401)
      const malformedSignature = (await sign(claims)).replace(
        /\.[^.]+$/,
        '.%%%',
      )
      expect((await exchange(malformedSignature)).status).toBe(401)
      // A reusable workflow is checked by job_workflow_ref; the caller
      // is still the registered repo on main.
      await relay.request('POST', '/api/relay/repos', {
        repo: 'acme/app',
        workflow: 'tools/ci/.github/workflows/agent.yml',
      })
      const reusable = {
        ...claims,
        event_name: 'workflow_dispatch',
        job_workflow_ref: 'tools/ci/.github/workflows/agent.yml@v1',
      }
      expect((await exchange(await sign(reusable))).status).toBe(200)
      await relay.request('POST', '/api/relay/repos', {
        repo: 'acme/app',
        workflow: 'acme/app/.github/workflows/agent.yml',
      })
      const issued = await exchange(await sign(claims))
      const body = (await issued.json()) as {
        key: string
        expiresAt: number
        models: unknown[]
      }
      expect(body.key).toMatch(/^anr_/)
      expect(body.expiresAt - Date.now()).toBeGreaterThan(6 * 3600000 - 10000)
      expect(body.expiresAt - Date.now()).toBeLessThanOrEqual(6 * 3600000)
      expect(body.models).toEqual([
        {
          id: 'm1',
          object: 'model',
          owned_by: 'Acme',
          protocol: 'openai-chat',
          model_type: 'chat',
        },
      ])
      const settings = await relay.json<{
        keys: {
          name: string
          expiresAt: number | null
        }[]
      }>('GET', '/api/relay')
      expect(settings.keys.map((key) => key.name)).toContain(
        'GitHub acme/app 42',
      )
      const used = await relay.request(
        'POST',
        '/relay/v1/chat/completions',
        { model: 'm1' },
        { authorization: `Bearer ${body.key}` },
      )
      expect(used.status).toBe(200)
    },
  )

  it(
    'normalizes repository names but preserves workfl' +
      'ow path case and pins immutable identity',
    async () => {
      const { h, relay } = await setup()
      const { jwks, sign } = await signer()
      fetchMock.mockImplementation(async () => Response.json(jwks))
      const claims = {
        iss: 'https://token.actions.githubusercontent.com',
        aud: 'http://localhost',
        exp: Math.floor(Date.now() / 1000) + 300,
        repository: 'ACME/App',
        repository_id: '100',
        ref: 'refs/heads/Main',
        event_name: 'schedule',
        workflow_ref: 'TOOLS/CI/.github/workflows/Agent.yml@v1',
        run_id: '1',
        run_attempt: '1',
      }
      await relay.request('POST', '/api/relay/repos', {
        repo: 'Acme/APP',
        workflow: 'Tools/Ci/.github/workflows/Agent.yml',
        ref: claims.ref,
      })
      const repos = await relay.json<{
        repos: unknown[]
      }>('GET', '/api/relay')
      expect(repos.repos).toEqual([
        {
          repo: 'acme/app',
          workflow: 'tools/ci/.github/workflows/Agent.yml',
          ref: claims.ref,
        },
      ])
      await relay.request('PUT', '/api/relay', { enabled: true })
      expect(
        (
          await relay.request('POST', '/relay/github/token', {
            token: await sign({
              ...claims,
              workflow_ref: claims.workflow_ref.replace('Agent', 'agent'),
            }),
          })
        ).status,
      ).toBe(401)
      expect(
        await h.env.DB.prepare(
          'SELECT repository_id FROM relay_github_repos',
        ).first(),
      ).toEqual({ repository_id: null })
      expect(
        (
          await relay.request('POST', '/relay/github/token', {
            token: await sign(claims),
          })
        ).status,
      ).toBe(200)
      expect(
        await h.env.DB.prepare(
          'SELECT repository_id FROM relay_github_repos',
        ).first(),
      ).toEqual({ repository_id: '100' })
      const replaced = await relay.request('POST', '/relay/github/token', {
        token: await sign({ ...claims, repository_id: '101' }),
      })
      expect(replaced.status).toBe(401)
      expect(await replaced.json()).toMatchObject({
        error: { message: expect.stringContaining('repository_id') },
      })
      await relay.request('POST', '/api/relay/repos', {
        repo: 'ACME/APP',
        workflow: 'tools/ci/.github/workflows/Agent.yml',
        ref: claims.ref,
      })
      expect(
        (
          await relay.request('POST', '/relay/github/token', {
            token: await sign({ ...claims, repository_id: '101' }),
          })
        ).status,
      ).toBe(401)
      await relay.request('DELETE', '/api/relay/repos/ACME/APP')
      await relay.request('POST', '/api/relay/repos', {
        repo: 'acme/app',
        workflow: 'tools/ci/.github/workflows/Agent.yml',
        ref: claims.ref,
      })
      expect(
        (
          await relay.request('POST', '/relay/github/token', {
            token: await sign({ ...claims, repository_id: '101' }),
          })
        ).status,
      ).toBe(200)
    },
  )

  it(
    'rotates each run attempt atomically, purges expi' +
      'red keys and caps each repository separately fro' +
      'm manual keys',
    async () => {
      const { h, relay, token: manual } = await setup()
      const { jwks, sign } = await signer()
      fetchMock.mockImplementation(async () => Response.json(jwks))
      await relay.request('PUT', '/api/relay', { enabled: true })
      for (const repo of ['acme/app', 'acme/other'])
        await relay.request('POST', '/api/relay/repos', {
          repo,
          workflow: 'acme/app/.github/workflows/agent.yml',
        })
      const claims = {
        iss: 'https://token.actions.githubusercontent.com',
        aud: 'http://localhost',
        exp: Math.floor(Date.now() / 1000) + 300,
        repository: 'acme/app',
        repository_id: '100',
        ref: 'refs/heads/main',
        event_name: 'push',
        workflow_ref:
          'acme/app/.github/workflows/agent.yml@refs/heads/' + 'main',
        run_id: '1',
        run_attempt: '1',
      }
      const exchange = async (extra: Record<string, string> = {}) => {
        const response = await relay.request('POST', '/relay/github/token', {
          token: await sign({ ...claims, ...extra }),
        })
        expect(response.status).toBe(200)
        return (await response.json()) as {
          key: string
        }
      }
      const first = await exchange()
      const replacement = await exchange()
      expect(replacement.key).not.toBe(first.key)
      const keyStatus = async (key: string) =>
        (
          await relay.request('GET', '/relay/v1/models', undefined, {
            authorization: `Bearer ${key}`,
          })
        ).status
      expect(await keyStatus(first.key)).toBe(401)
      expect(await keyStatus(replacement.key)).toBe(200)
      await h.env.DB.prepare(
        'UPDATE relay_access_keys SET created_at = 1 WHER' +
          'E github_run IS NOT NULL',
      ).run()
      await exchange({ run_attempt: '2' })
      expect(await keyStatus(replacement.key)).toBe(200)
      await h.env.DB.prepare(
        'INSERT INTO relay_access_keys (id, user_id, name' +
          ', key_hash, created_at, expires_at, github_run)\n' +
          "      VALUES ('expired', 'user-a', 'expired', 'e" +
          "xpired-hash', 0, 1, 'acme/app#expired#1')",
      ).run()
      await Promise.all(
        Array.from({ length: 22 }, (_, i) =>
          exchange({ run_id: String(i + 2) }),
        ),
      )
      expect(await keyStatus(replacement.key)).toBe(401)
      expect(
        await h.env.DB.prepare(
          "SELECT id FROM relay_access_keys WHERE id = 'exp" + "ired'",
        ).first(),
      ).toBeNull()
      expect(
        (
          await h.env.DB.prepare(
            'SELECT COUNT(*) AS count FROM relay_access_keys ' +
              "WHERE github_run LIKE 'acme/app#%' AND revoked_a" +
              't IS NULL',
          ).first<{
            count: number
          }>()
        )?.count,
      ).toBe(20)
      await exchange({ repository: 'acme/other', repository_id: '200' })
      expect(
        (
          await h.env.DB.prepare(
            'SELECT COUNT(*) AS count FROM relay_access_keys ' +
              'WHERE revoked_at IS NULL',
          ).first<{
            count: number
          }>()
        )?.count,
      ).toBe(22)
      expect(await keyStatus(manual)).toBe(200)
      const stored = await h.env.DB.prepare(
        'SELECT key_hash FROM relay_access_keys WHERE key' + '_hash = ?1',
      )
        .bind(await sha256Hex(replacement.key))
        .first()
      expect(stored).toEqual({ key_hash: await sha256Hex(replacement.key) })
    },
  )

  it(
    'does not pin identity or partially revoke keys w' +
      'hen issuance rolls back',
    async () => {
      const { h, relay } = await setup()
      const { jwks, sign } = await signer()
      fetchMock.mockImplementation(async () => Response.json(jwks))
      await relay.request('PUT', '/api/relay', { enabled: true })
      await relay.request('POST', '/api/relay/repos', {
        repo: 'acme/app',
        workflow: 'acme/app/.github/workflows/agent.yml',
      })
      const claims = {
        iss: 'https://token.actions.githubusercontent.com',
        aud: 'http://localhost',
        exp: Math.floor(Date.now() / 1000) + 300,
        repository: 'acme/app',
        repository_id: '100',
        ref: 'refs/heads/main',
        event_name: 'push',
        workflow_ref:
          'acme/app/.github/workflows/agent.yml@refs/heads/' + 'main',
        run_id: '1',
        run_attempt: '1',
      }
      await h.env.DB.prepare(
        'INSERT INTO relay_access_keys (id, user_id, name' +
          ', key_hash, created_at, expires_at, github_run)\n' +
          "      VALUES ('prior', 'user-a', 'prior', 'prior" +
          "-hash', 0, ?1, 'acme/app#1#1')",
      )
        .bind(Date.now() + 100000)
        .run()
      await h.env.DB.exec(
        'CREATE TRIGGER reject_github BEFORE INSERT ON re' +
          'lay_access_keys WHEN NEW.github_run IS NOT NULL ' +
          "BEGIN SELECT RAISE(ABORT, 'unavailable'); END",
      )
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const response = await relay.request('POST', '/relay/github/token', {
          token: await sign(claims),
        })
        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({
          type: 'error',
          error: { type: 'api_error', message: 'Internal server error' },
        })
        expect(
          await h.env.DB.prepare(
            'SELECT repository_id FROM relay_github_repos',
          ).first(),
        ).toEqual({ repository_id: null })
        expect(
          await h.env.DB.prepare(
            'SELECT revoked_at FROM relay_access_keys WHERE i' + "d = 'prior'",
          ).first(),
        ).toEqual({ revoked_at: null })
      } finally {
        log.mockRestore()
      }
    },
  )
})
