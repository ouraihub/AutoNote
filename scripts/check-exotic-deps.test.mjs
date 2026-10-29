import assert from 'node:assert/strict'
import test from 'node:test'
import { exoticViolations } from './check-exotic-deps.mjs'

const sha = '53b80630bdd58f22ca94d119e93586f84fbceec7'
const entry = (resolution) => `packages:\n  'pkg@x':\n    resolution: {${resolution}}\n    version: 0.1.0\n`

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

test('block-style and multiline resolutions cannot bypass the source policy', () => {
  for (const resolution of [
    `      type: directory\n      directory: ../outside`,
    `      tarball: https://evil.example/pkg.tgz\n      integrity: sha512-a==`,
    `      type: git\n      repo: https://github.com/someone/pkg`,
  ]) assert.equal(exoticViolations(`packages:\n  pkg:\n    resolution:\n${resolution}\n`).length, 1)
  assert.equal(exoticViolations(`${entry('integrity: sha512-abc==')}---\npackages:\n  pkg:\n    resolution: {directory: ../outside, type: directory}\n`).length, 1)
})

test('invalid documents and unknown resolution forms fail closed', () => {
  for (const value of ['', 'packages: [', 'other: {}', 'packages:\n  pkg: {}'])
    assert.ok(exoticViolations(value).length > 0)
})

test('runtime variants require the pinned version, approved host and integrity', () => {
  const lock = (url, integrity = 'sha256-abc=') => `packages:\n  node@runtime:26.13.0:\n    resolution:\n      type: variations\n      variants:\n        - resolution:\n            type: binary\n            url: ${url}\n            integrity: ${integrity}\n`
  const url = 'https://nodejs.org/download/release/v26.13.0/node-v26.13.0-win-x64.zip'
  assert.deepEqual(exoticViolations(lock(url)), [])
  for (const bad of [url.replace('nodejs.org', 'evil.example'), url.replaceAll('26.13.0', '24.0.0')])
    assert.equal(exoticViolations(lock(bad)).length, 1)
  assert.equal(exoticViolations(lock(url, 'none')).length, 1)
})
