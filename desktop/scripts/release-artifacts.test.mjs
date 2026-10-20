import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { currentArtifacts, noLinks, root, sha256 } from './release-artifacts.mjs'

const stage = realpathSync(mkdtempSync(path.join(tmpdir(), 'AutoNote-release-fixture-')))
const desktop = path.join(stage, 'desktop')
const target = path.join(desktop, 'src-tauri/target/x86_64-pc-windows-msvc/release')
mkdirSync(path.join(desktop, 'scripts'), { recursive: true })
copyFileSync(path.join(root, 'scripts/release-artifacts.mjs'), path.join(desktop, 'scripts/release-artifacts.mjs'))
mkdirSync(path.join(target, 'bundle/nsis'), { recursive: true })
mkdirSync(path.join(desktop, 'dist/AutoNote/data/files'), { recursive: true })
writeFileSync(path.join(stage, 'LICENSE'), 'Fixture license')
writeFileSync(path.join(target, 'AutoNote.exe'), 'new fixture executable')
const oldExe = path.join(desktop, 'dist/AutoNote/AutoNote.exe')
writeFileSync(oldExe, 'old usable exe')
const sentinel = path.join(desktop, 'dist/AutoNote/data/files/attachment.bin')
writeFileSync(sentinel, 'user bytes')
const exeHash = sha256(oldExe)
const sentinelHash = sha256(sentinel)
const result = spawnSync(process.execPath, [path.join(desktop, 'scripts/release-artifacts.mjs'), 'collect', '0.1.0', String(Date.now())], { encoding: 'utf8', env: { ...process.env, CARGO_TARGET_DIR: '' } })
assert.notEqual(result.status, 0, 'Missing NSIS must fail')
assert.equal(sha256(oldExe), exeHash, 'Missing NSIS must leave old runnable exe')
assert.equal(sha256(sentinel), sentinelHash, 'Collection never removes data')
assert.equal(existsSync(path.join(desktop, 'dist/release.json')), false, 'Failed collection must not publish a manifest')
if (process.platform === 'win32') {
  const external = path.join(stage, 'external')
  mkdirSync(external)
  symlinkSync(external, path.join(desktop, 'dist/linked'), 'junction')
if (process.argv.includes('--with-current-build')) {
  const real = currentArtifacts()
  const actualExe = path.join(root, 'dist/AutoNote/AutoNote.exe')
  assert.equal(sha256(actualExe), real.exeSha256)
  copyFileSync(actualExe, path.join(target, 'AutoNote.exe'))
  const installer = real.artifacts.find(item => item.kind === 'nsis').file
  copyFileSync(installer, path.join(target, 'bundle/nsis', path.basename(installer)))
  const collected = spawnSync(process.execPath, [path.join(desktop, 'scripts/release-artifacts.mjs'), 'collect', real.version, '0'], { encoding: 'utf8', env: { ...process.env, CARGO_TARGET_DIR: '' } })
  assert.equal(collected.status, 0, collected.stderr)
  assert.equal(sha256(sentinel), sentinelHash, 'Collecting a second real build must preserve user data bytes')
  assert.equal(sha256(oldExe), real.exeSha256)
  currentArtifacts(path.join(desktop, 'dist/release.json'))
}
  assert.throws(() => noLinks(path.join(desktop, 'dist/linked/future.exe')), /linked path/)
}
const packageFile = path.join(desktop, 'dist/fake.exe')
writeFileSync(packageFile, 'not a current installer')
const manifest = path.join(desktop, 'dist/invalid.json')
writeFileSync(manifest, JSON.stringify({ version: '0.1.0', buildId: 'fixture', exeSha256: 'a'.repeat(64), artifacts: [{kind:'nsis', path:'../outside.exe', sha256:'a'.repeat(64)}, {kind:'portable', path:'fake.exe', sha256:sha256(packageFile)}] }))
assert.throws(() => currentArtifacts(manifest), /escaped/)
writeFileSync(manifest, JSON.stringify({ version: '0.1.0', buildId: 'fixture', exeSha256: 'a'.repeat(64), artifacts: [{kind:'nsis', path:'fake.exe', sha256:'a'.repeat(64)}, {kind:'portable', path:'fake.exe', sha256:sha256(packageFile)}] }))
assert.throws(() => currentArtifacts(manifest), /hash mismatch/)
console.log(`PASS: missing NSIS preserves old exe/data, manifest containment/hash fail closed; isolated fixture retained: ${stage}`)
