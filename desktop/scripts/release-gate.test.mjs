import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { verifyEvidence } from './release-evidence.mjs'
import { root } from './release-artifacts.mjs'

const stage = mkdtempSync(path.join(tmpdir(), 'AutoNote-gate-fixture-'))
const release = { version:'0.1.0', buildId:'current', artifacts:[{kind:'nsis',sha256:'a'.repeat(64)},{kind:'portable',sha256:'b'.repeat(64)}] }
assert.throws(() => verifyEvidence(stage, release), /ENOENT/, 'Missing interactive evidence must block')
writeFileSync(path.join(stage, 'window.json'), JSON.stringify({suite:'window',version:'0.1.0',buildId:'old',status:'passed',cases:[]}))
assert.throws(() => verifyEvidence(stage, release), /current real-window/, 'Old-build evidence must block')
writeFileSync(path.join(stage, 'window.json'), JSON.stringify({suite:'window',version:'0.1.0',buildId:'current',status:'passed',recordedAt:new Date().toISOString(),windows:'Windows_NT',artifacts:release.artifacts,cases:[]}))
assert.throws(() => verifyEvidence(stage, release), /Incomplete/, 'Process-only/missing-window matrix must block')
if (process.platform === 'win32') {
  const missingPortable = path.join(stage, 'no-portable')
  const result = spawnSync('cmd', ['/d','/c', `call "${path.join(root,'scripts/msvc-env.bat')}"`], { encoding:'utf8', env:{...process.env,CI:'true',GITHUB_ACTIONS:'false',PORTABLE_MSVC_ROOT:missingPortable} })
  assert.notEqual(result.status, 0, 'Local CI=true must not fall back to installed VS')
  assert.match(result.stderr, /portable MSVC not found/)
  const smoke = spawnSync(process.execPath, [path.join(root,'scripts/smoke-app.mjs')], { encoding:'utf8', env:{...process.env,GITHUB_ACTIONS:'true'} })
  assert.notEqual(smoke.status, 0, 'Headless/Actions process check must not claim real windows')
  assert.match(smoke.stderr, /interactive Windows/)
}
console.log(`PASS: missing/stale/noninteractive evidence and missing local portable toolchain fail closed; fixture retained: ${stage}`)
