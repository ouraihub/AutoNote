import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { root } from './release-artifacts.mjs'

if (process.platform === 'win32') {
  const missingPortable = path.join(root, 'no-portable')
  const result = spawnSync('cmd', ['/d','/c', 'call scripts\\msvc-env.bat'], { cwd: root, encoding:'utf8', env:{...process.env,CI:'true',GITHUB_ACTIONS:'false',PORTABLE_MSVC_ROOT:missingPortable} })
  assert.notEqual(result.status, 0, 'Local CI=true must not fall back to installed VS')
  assert.match(result.stderr, /portable MSVC not found/)
}
console.log('PASS: missing local portable toolchain fails closed')
