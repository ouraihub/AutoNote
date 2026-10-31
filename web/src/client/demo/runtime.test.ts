import { expect, test, vi } from 'vitest'
import { createDemoRuntime } from './index'
import type {
  Attachment,
  ExportBundle,
  Note,
  PublicNote,
  ShareInfo,
} from '@shared/types'

test('demo performs account, edits, attachments, sharing, settings and ZIP roundtrip without private fetch', async () => {
  const nativeFetch = globalThis.fetch
  const network = vi.fn(() => Promise.reject(new Error('Unexpected network')))
  vi.stubGlobal('fetch', network)
  const demo = createDemoRuntime()
  const restored = createDemoRuntime()
  async function request(path: string, method = 'GET', body?: unknown) {
    const response = await demo.fetch(
      new Request(`https://demo.invalid${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { 'Content-Type': 'application/json' },
            }),
      }),
    )
    return response
  }
  try {
    expect((await request('/api/notes')).status).toBe(401)
    expect(
      (
        await request('/api/auth/login', 'POST', {
          username: 'admin',
          password: 'wrong',
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await request('/api/auth/login', 'POST', {
          username: 'admin',
          password: 'password',
        })
      ).status,
    ).toBe(200)
    const seededShares = (await (await request('/api/share')).json()) as {
      shares: ShareInfo[]
    }
    expect(seededShares.shares[0]?.slug).toMatch(/^[0-9a-hjkmnp-tv-z]{20}$/)
    expect(demo.userId).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/)
    const created = (await (
      await request('/api/notes', 'POST', {
        content: '# Demo\nHello',
        title: 'Demo',
      })
    ).json()) as Note
    const changed = (await (
      await request(`/api/notes/${created.id}`, 'PATCH', {
        rev: created.rev,
        content: '# Demo\nChanged',
      })
    ).json()) as Note
    expect(changed.rev).toBe(created.rev + 1)
    expect(
      (
        await request(`/api/notes/${created.id}`, 'PATCH', {
          rev: created.rev,
          content: 'Stale',
        })
      ).status,
    ).toBe(409)
    const form = new FormData()
    form.set(
      'file',
      new File(['real attachment bytes'], 'test.txt', { type: 'text/plain' }),
    )
    form.set('noteId', created.id)
    const attachment = (await (
      await demo.fetch(
        new Request('https://demo.invalid/api/files', {
          method: 'POST',
          body: form,
        }),
      )
    ).json()) as Attachment
    expect(demo.resolveFileUrl(`/api/files/${attachment.id}`)).toBe(
      attachment.url,
    )
    expect(
      await nativeFetch(attachment.url).then((response) => response.text()),
    ).toBe('real attachment bytes')
    await request(`/api/notes/${created.id}`, 'PATCH', {
      rev: changed.rev,
      content: `# Demo\n[attachment](${attachment.url})`,
    })
    const shareResult = (await (
      await request(`/api/share/${created.id}`, 'POST', { password: 'test' })
    ).json()) as {
      share: ShareInfo
    }
    expect(shareResult.share.slug).toMatch(/^[0-9a-hjkmnp-tv-z]{20}$/)
    const sharedFilePath = `/api/files/${attachment.id}?share=${shareResult.share.slug}`
    expect(demo.resolveFileUrl(sharedFilePath)).toBe('data:,')
    expect((await request(sharedFilePath)).status).toBe(404)
    expect(
      demo.resolveFileUrl(`/api/files/${attachment.id}?share=invalid`),
    ).toBe('data:,')
    const locked = await request(
      `/api/public/${shareResult.share.slug}`,
      'POST',
      {},
    )
    expect(
      ((await locked.json()) as { error: { code: string } }).error.code,
    ).toBe('password_required')
    const publicNote = (await (
      await request(`/api/public/${shareResult.share.slug}`, 'POST', {
        password: 'test',
      })
    ).json()) as PublicNote
    expect(publicNote.content).toContain(
      `/api/files/${attachment.id}?share=${shareResult.share.slug}`,
    )
    expect(demo.resolveFileUrl(sharedFilePath)).toBe(attachment.url)
    expect(await (await request(sharedFilePath)).text()).toBe(
      'real attachment bytes',
    )
    const unrelated = new FormData()
    unrelated.set(
      'file',
      new File(['private bytes'], 'private.txt', { type: 'text/plain' }),
    )
    const privateFile = (await (
      await demo.fetch(
        new Request('https://demo.invalid/api/files', {
          method: 'POST',
          body: unrelated,
        }),
      )
    ).json()) as Attachment
    const deniedPath = `/api/files/${privateFile.id}?share=${shareResult.share.slug}`
    expect(demo.resolveFileUrl(deniedPath)).toBe('data:,')
    expect((await request(deniedPath)).status).toBe(404)
    await request(`/api/files/${privateFile.id}`, 'DELETE')
    await request('/api/settings', 'PUT', { appearance: { theme: 'dark' } })
    expect(await (await request('/api/settings')).json()).toMatchObject({
      appearance: { theme: 'dark' },
    })
    const keyResult = (await (
      await request('/api/mcp/keys', 'POST', { name: 'Demo key' })
    ).json()) as { token: string }
    expect(keyResult.token).toMatch(/^demo-only-/)
    await request('/api/mcp', 'PUT', { trashEnabled: true })
    expect(await (await request('/api/mcp')).json()).toMatchObject({
      preferences: { trashEnabled: true },
      aiSearch: { available: false },
    })
    const jsonExport = (await (
      await request('/api/export?format=json')
    ).json()) as ExportBundle
    expect(
      jsonExport.notes.find((note) => note.id === created.id)?.content,
    ).toContain(`/api/files/${attachment.id}`)
    const zip = await (await request('/api/export?format=zip')).blob()
    await restored.fetch(
      new Request('https://demo.invalid/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: 'admin', password: 'password' }),
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const importForm = new FormData()
    importForm.set('file', new File([zip], 'backup.zip'))
    importForm.set('conflict', 'duplicate')
    const imported = (await (
      await restored.fetch(
        new Request('https://demo.invalid/api/import', {
          method: 'POST',
          body: importForm,
        }),
      )
    ).json()) as {
      createdNotes: number
      createdAttachments: number
      warnings: string[]
    }
    expect(imported.createdNotes).toBeGreaterThan(0)
    expect(imported.createdAttachments).toBe(1)
    expect(imported.warnings).toEqual([])
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    demo.dispose()
    expect(revoke).toHaveBeenCalledWith(attachment.url)
    expect(demo.resolveFileUrl(attachment.url)).toBe('data:,')
    expect((await request('/api/notes')).status).toBe(503)
    expect(network).not.toHaveBeenCalled()
    revoke.mockRestore()
  } finally {
    demo.dispose()
    restored.dispose()
    vi.unstubAllGlobals()
  }
})
