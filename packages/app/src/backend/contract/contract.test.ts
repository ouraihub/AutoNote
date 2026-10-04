import { describe, expect, test } from 'vitest'
import { backendContractCases, runBackendContractCases } from './index'
import { referenceFixture, type ReferenceFault } from '../testing/reference-backend'

const faultyCases: readonly { name: string; fault: ReferenceFault; mode: 'reject' | 'rebase'; message: string }[] = [
  {
    name: 'create-read-source',
    fault: 'mutate-source-on-read',
    mode: 'reject',
    message: 'reading a created note must preserve its source',
  },
  {
    name: 'write-revision-conflict',
    fault: 'accept-stale-revision',
    mode: 'reject',
    message: 'a write with a stale revision must be rejected',
  },
  {
    name: 'write-revision-conflict',
    fault: 'drop-version-history',
    mode: 'rebase',
    message: 'the remote text replaced by a rebase must remain in history',
  },
  {
    name: 'trash-restore-purge',
    fault: 'restore-keeps-deletion',
    mode: 'reject',
    message: 'restore must clear the deletion marker',
  },
  {
    name: 'trash-restore-purge',
    fault: 'purge-leaves-note',
    mode: 'reject',
    message: 'a purged note must not be readable',
  },
  {
    name: 'trash-restore-purge',
    fault: 'drop-tombstone',
    mode: 'reject',
    message: 'a purged note must return a deletion cursor',
  },
  {
    name: 'folder-tag-filtering',
    fault: 'ignore-folder-filter',
    mode: 'reject',
    message: 'the folder view must exclude notes outside the folder',
  },
  {
    name: 'attachment-hash',
    fault: 'corrupt-attachment-bytes',
    mode: 'reject',
    message: 'reading an uploaded attachment must return identical bytes',
  },
  {
    name: 'settings-persist',
    fault: 'forget-settings-on-reopen',
    mode: 'reject',
    message: 'patched settings must survive a reopen',
  },
]

describe('contract assertions against deliberately incorrect test substitutes (not real backends)', () => {
  for (const { name, fault, mode, message } of faultyCases) {
    test(`${name} detects ${fault}`, async () => {
      const contractCase = backendContractCases.find((item) => item.name === name)
      if (!contractCase) throw new Error(`Missing backend contract case: ${name}`)
      await expect(contractCase.run(referenceFixture({ mode, faults: [fault] }))).rejects.toThrow(message)
    })
  }

  test('runner reports failures without turning a failed behavior into a pass', async () => {
    const cases = backendContractCases.filter((item) => item.name === 'create-read-source')
    const results = await runBackendContractCases(
      referenceFixture({ mode: 'reject', faults: ['mutate-source-on-read'] }),
      cases,
    )
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ name: 'create-read-source', ok: false })
  })
})
