import { describe, expect, it } from 'vitest'

import { toBase64Url, utf8 } from '../src/worker/lib/encoding'

import { fetchMock, setup } from './support/relay-test-setup'

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
    'rejects a repository identity changed between lo' +
      'okup and the atomic issuance batch',
    async () => {
      const { h, relay } = await setup()
      const { jwks, sign } = await signer()
      fetchMock.mockImplementation(async () => Response.json(jwks))
      await relay.request('PUT', '/api/relay', { enabled: true })
      await relay.request('POST', '/api/relay/repos', {
        repo: 'acme/app',
        workflow: 'acme/app/.github/workflows/agent.yml',
      })
      const batch = h.env.DB.batch.bind(h.env.DB)
      h.env.DB.batch = async (statements) => {
        await h.env.DB.prepare(
          "UPDATE relay_github_repos SET repository_id = 'o" + "ther-id'",
        ).run()
        return batch(statements)
      }
      const token = await sign({
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
      })
      const response = await relay.request('POST', '/relay/github/token', {
        token,
      })
      expect(response.status).toBe(401)
      expect(
        (
          await h.env.DB.prepare(
            'SELECT COUNT(*) AS count FROM relay_access_keys ' +
              'WHERE github_run IS NOT NULL',
          ).first<{
            count: number
          }>()
        )?.count,
      ).toBe(0)
    },
  )

  it(
    'lets only one user register a repository and upd' +
      'ates the workflow for its owner',
    async () => {
      const { h, relay } = await setup()
      const add = (workflow: string) =>
        relay.request('POST', '/api/relay/repos', {
          repo: 'acme/app',
          workflow,
        })
      expect((await add('tools/ci/.github/workflows/a.yml')).status).toBe(200)
      expect(
        await (await add('tools/ci/.github/workflows/b.yml')).json(),
      ).toEqual({
        repos: [
          {
            repo: 'acme/app',
            workflow: 'tools/ci/.github/workflows/b.yml',
            ref: 'refs/heads/main',
          },
        ],
      })
      expect(
        (
          await relay.request('POST', '/api/relay/repos', {
            repo: 'acme/app',
            workflow: 'tools/ci/.github/workflows/b.yml',
            ref: 'main',
          })
        ).status,
      ).toBe(400)
      await h.env.DB.prepare(
        "UPDATE relay_github_repos SET user_id = 'user-b'",
      ).run()
      expect((await add('evil/x/.github/workflows/c.yml')).status).toBe(409)
      expect(
        (
          await relay.request('POST', '/api/relay/repos', {
            repo: 'acme/app',
            workflow: 'not-a-workflow',
          })
        ).status,
      ).toBe(400)
    },
  )
})
