import { verifiesAttachmentHash, verifiesFolderAndTagFiltering, verifiesSettingsPersist } from './library-cases'
import {
  verifiesCreateReadSource,
  verifiesEmptyTrashTombstones,
  verifiesTrashRestoreAndPurge,
  verifiesWriteRevisionAndConflict,
} from './note-cases'
import type { BackendContractCase, BackendContractFixture, BackendContractResult } from './types'

export { BackendContractFailure } from './assertions'
export type {
  BackendContractCase,
  BackendContractFixture,
  BackendContractResult,
  ContractBackend,
  ContractLibrary,
  WriteConflictMode,
} from './types'

export const backendContractCases: readonly BackendContractCase[] = [
  { name: 'create-read-source', run: verifiesCreateReadSource },
  { name: 'write-revision-conflict', run: verifiesWriteRevisionAndConflict },
  { name: 'trash-restore-purge', run: verifiesTrashRestoreAndPurge },
  { name: 'empty-trash-tombstones', run: verifiesEmptyTrashTombstones },
  { name: 'folder-tag-filtering', run: verifiesFolderAndTagFiltering },
  { name: 'attachment-hash', run: verifiesAttachmentHash },
  { name: 'settings-persist', run: verifiesSettingsPersist },
]

export async function runBackendContractCases(
  fixture: BackendContractFixture,
  cases: readonly BackendContractCase[] = backendContractCases,
): Promise<BackendContractResult[]> {
  const results: BackendContractResult[] = []
  for (const contractCase of cases) {
    try {
      await contractCase.run(fixture)
      results.push({ name: contractCase.name, ok: true })
    } catch (error) {
      results.push({ name: contractCase.name, ok: false, error })
    }
  }
  return results
}
