import assert from 'node:assert/strict'
import test from 'node:test'
import { exoticViolations } from './check-exotic-deps.mjs'

const sha = '53b80630bdd58f22ca94d119e93586f84fbceec7'
const entry = (resolution) => `  'pkg@x':\n    resolution: {${resolution}}\n    version: 0.1.0\n`

test('registry packages and pinned ouraihub tarballs pass', () => {
  assert.deepEqual(exoticViolations(entry('integrity: sha512-abc==')), [])
  assert.deepEqual(exoticViolations(entry(`gitHosted: true, integrity: sha512-a==, path: packages/ui, tarball: https://codeload.github.com/ouraihub/Aether/tar.gz/${sha}`)), [])
})

test('foreign, unpinned and non-tarball exotic sources fail closed', () => {
  for (const resolution of [
    `gitHosted: true, integrity: sha512-a==, tarball: https://codeload.github.com/someone/Aether/tar.gz/${sha}`,
    'gitHosted: true, integrity: sha512-a==, tarball: https://codeload.github.com/ouraihub/Aether/tar.gz/main',
    `integrity: sha512-a==, tarball: https://example.com/ouraihub/Aether/tar.gz/${sha}`,
    `commit: ${sha}, repo: https://github.com/ouraihub/Aether.git, type: git`,
    'directory: ../outside, type: directory',
  ]) assert.equal(exoticViolations(entry(resolution)).length, 1, resolution)
})
