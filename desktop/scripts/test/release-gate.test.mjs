import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { powershellExe, root } from '../build/release-artifacts.mjs'

// Exercises the msvc-kit copy this repo actually builds with (pinned in package.json).
if (process.platform === 'win32') {
  const missingPortable = path.join(root, 'no-portable')
  const result = spawnSync('cmd', ['/d', '/c', 'call ..\\node_modules\\@ouraihub\\msvc-kit\\msvc-env.bat'], { cwd: root, encoding: 'utf8', env: { ...process.env, CI: 'true', GITHUB_ACTIONS: 'false', PORTABLE_MSVC_ROOT: missingPortable } })
  assert.notEqual(result.status, 0, 'Local CI=true must not fall back to installed VS')
  assert.match(result.stderr, /portable MSVC not found/)
  const safety = spawnSync(powershellExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/test/release-safety.test.ps1')], { stdio: 'inherit' })
  assert.equal(safety.status, 0, 'Cleanup must preserve every protected byte and remove generated files')
}
console.log('PASS: missing local portable toolchain fails closed; cleanup safety fixture passes')
