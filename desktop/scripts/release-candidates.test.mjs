import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { aggregateCandidates, packages, verifyBuildRun, verifyCandidate } from './release-candidates.mjs'
import { sha256 } from './release-artifacts.mjs'

const stage = realpathSync(mkdtempSync(path.join(tmpdir(), 'autonote-candidates-')))
const expected = { version: '0.2.0', sourceSha: 'a'.repeat(40), buildRunId: '123' }
const run = {
  status: 'completed',
  conclusion: 'success',
  event: 'push',
  path: '.github/workflows/desktop.yml',
  head_branch: 'main',
  head_sha: expected.sourceSha,
}
const jobs = Object.keys(packages).map((platform) => ({ name: `Build (${platform})`, conclusion: 'success' }))
verifyBuildRun(run, jobs, expected.sourceSha)
verifyBuildRun({ ...run, event: 'workflow_dispatch' }, jobs, expected.sourceSha)
for (const patch of [
  { status: 'in_progress' },
  { conclusion: 'failure' },
  { event: 'pull_request' },
  { path: '.github/workflows/desktop-release.yml' },
  { head_branch: 'feature' },
  { head_sha: 'b'.repeat(40) },
])
  assert.throws(() => verifyBuildRun({ ...run, ...patch }, jobs, expected.sourceSha), /successful Desktop/)
for (const platform of Object.keys(packages)) {
  const name = `Build (${platform})`
  assert.throws(
    () =>
      verifyBuildRun(
        run,
        jobs.filter((job) => job.name !== name),
        expected.sourceSha,
      ),
    /Missing successful native/,
  )
  assert.throws(
    () =>
      verifyBuildRun(
        run,
        jobs.map((job) => (job.name === name ? { ...job, conclusion: 'failure' } : job)),
        expected.sourceSha,
      ),
    /Missing successful native/,
  )
}
assert.throws(() => verifyBuildRun(run, [...jobs, jobs[0]], expected.sourceSha), /Missing successful native/)
try {
  for (const [platform, names] of Object.entries(packages)) {
    const dir = path.join(stage, `candidate-${platform}`)
    mkdirSync(dir)
    const artifacts = Object.entries(names).map(([kind, name]) => {
      const bytes = Buffer.from(`package boundary fixture: ${kind}`)
      const file = path.join(dir, name)
      writeFileSync(file, bytes)
      return { kind, path: name, size: bytes.length, sha256: sha256(file) }
    })
    writeFileSync(
      path.join(dir, 'candidate.json'),
      JSON.stringify({ ...expected, platform, arch: platform === 'macos' ? 'arm64' : 'x64', artifacts }),
    )
  }
  assert.equal(aggregateCandidates(stage, expected).length, 5)
  assert.throws(() => aggregateCandidates(stage, { ...expected, sourceSha: 'b'.repeat(40) }), /sourceSha mismatch/)
  assert.throws(() => aggregateCandidates(stage, { ...expected, version: '0.1.0' }), /version mismatch/)
  assert.throws(() => aggregateCandidates(stage, { ...expected, buildRunId: '999' }), /buildRunId mismatch/)
  const file = path.join(stage, 'candidate-linux/candidate.json')
  const original = JSON.parse(readFileSync(file, 'utf8'))
  const invalid = (value) => writeFileSync(file, JSON.stringify(value))
  invalid({ ...original, artifacts: original.artifacts.slice(1) })
  assert.throws(() => verifyCandidate(file), /package set/)
  invalid({ ...original, artifacts: [original.artifacts[0], original.artifacts[0]] })
  assert.throws(() => verifyCandidate(file), /Invalid candidate package/)
  invalid({
    ...original,
    artifacts: [{ ...original.artifacts[0], path: '../outside.AppImage' }, original.artifacts[1]],
  })
  assert.throws(() => verifyCandidate(file), /Invalid candidate package/)
  invalid({ ...original, artifacts: [{ ...original.artifacts[0], sha256: '0'.repeat(64) }, original.artifacts[1]] })
  assert.throws(() => verifyCandidate(file), /hash\/size mismatch/)
  invalid(original)
  const packageFile = path.join(path.dirname(file), original.artifacts[0].path)
  writeFileSync(packageFile, '')
  assert.throws(() => verifyCandidate(file), /nonempty regular/)
  writeFileSync(packageFile, 'package boundary fixture: appimage')
  writeFileSync(path.join(path.dirname(file), 'private-state.db'), 'never upload')
  assert.throws(() => verifyCandidate(file), /Unexpected candidate files/)
  rmSync(path.join(path.dirname(file), 'private-state.db'))
  const outside = path.join(tmpdir(), `autonote-outside-${process.pid}`)
  writeFileSync(outside, 'outside')
  try {
    const link = path.join(stage, 'linked')
    symlinkSync(path.dirname(file), link, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => verifyCandidate(path.join(link, 'candidate.json')), /linked path/)
    if (process.platform !== 'win32') {
      rmSync(packageFile)
      symlinkSync(outside, packageFile)
      assert.throws(() => verifyCandidate(file), /linked path/)
    }
  } finally {
    rmSync(outside, { force: true })
  }
  console.log(
    'PASS: exact five-package aggregation, identity, containment, hashes, empty files, private extras and symlinks fail closed',
  )
} finally {
  rmSync(stage, { recursive: true, force: true })
}
