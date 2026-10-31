import { expect, it } from 'vitest'
import {
  backupCompleteBody,
  MARKDOWN_BACKUP_FORMAT,
  type MarkdownBackupManifest,
} from '@shared/backup-format'
import { selectBackup } from './transfer'

it('selects the latest complete backup, verifies hashes, and orders attachments before notes', async () => {
  const digest = async (text: string) =>
    [
      ...new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  const attachment = 'image',
    body = 'note'
  const attachmentHash = await digest(attachment)
  const manifest: MarkdownBackupManifest = {
    format: MARKDOWN_BACKUP_FORMAT,
    version: 3,
    appVersion: '1',
    createdAt: '2026-01-01T00:00:00Z',
    snapshot: '20260101-000000-000',
    attachments: [
      {
        path: `attachments/${attachmentHash}--image.png`,
        filename: 'image.png',
        mime: 'image/png',
        size: attachment.length,
        sha256: attachmentHash,
        createdAt: 1,
      },
    ],
    notes: [
      {
        id: '01arz3ndektsv4rrffq69g5fav',
        path: 'notes/note.md',
        title: 'Note',
        folder: [],
        attachmentHashes: [attachmentHash],
        state: 'notes',
        archived: false,
        bytes: body.length,
        sha256: await digest(body),
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      },
    ],
  }
  const text = JSON.stringify(manifest)
  const files = [
    { path: 'older/manifest.json', file: new File([text], 'manifest.json') },
    {
      path: 'older/COMPLETE',
      file: new File([backupCompleteBody(await digest(text))], 'COMPLETE'),
    },
    { path: 'older/notes/note.md', file: new File([body], 'note.md') },
    {
      path: `older/${manifest.attachments[0]!.path}`,
      file: new File([attachment], 'image.png'),
    },
    {
      path: 'newer/manifest.json',
      file: new File(
        [JSON.stringify({ ...manifest, snapshot: '20260102-000000-000' })],
        'manifest.json',
      ),
    },
  ]
  const selected = await selectBackup(files)
  expect(selected?.manifest.snapshot).toBe(manifest.snapshot)
  expect(selected?.files.map(({ path }) => path)).toEqual([
    manifest.attachments[0]!.path,
    'notes/note.md',
  ])
  expect(selected?.warning).toBeTruthy()
  files[2] = {
    path: 'older/notes/note.md',
    file: new File(['fake'], 'note.md'),
  }
  await expect(selectBackup(files)).rejects.toMatchObject({
    code: 'bad_request',
  })
})
