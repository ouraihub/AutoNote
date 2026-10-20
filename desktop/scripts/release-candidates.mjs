import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentArtifacts, noLinks, root, sha256, target } from './release-artifacts.mjs'

export const packages = {
  windows: { nsis: 'AutoNote-windows-setup.exe', portable: 'AutoNote-windows-portable.zip' },
  macos: { dmg: 'AutoNote-macos-arm64.dmg' },
  linux: { appimage: 'AutoNote-linux-x64.AppImage', deb: 'AutoNote-linux-x64.deb' },
}
export function verifyBuildRun(run, jobs, sourceSha) {
  if (
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    !['push', 'workflow_dispatch'].includes(run.event) ||
    run.path !== '.github/workflows/desktop.yml' ||
    run.head_branch !== 'main' ||
    run.head_sha !== sourceSha
  )
    throw new Error('Candidate run is not the successful Desktop main/source workflow')
  for (const platform of Object.keys(packages)) {
    const matches = jobs.filter((job) => job.name === `Build (${platform})`)
    if (matches.length !== 1 || matches[0].conclusion !== 'success')
      throw new Error(`Missing successful native ${platform} job`)
  }
}
const architectures = { windows: 'x64', macos: 'arm64', linux: 'x64' }
function regular(file) {
  noLinks(file)
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.size === 0) throw new Error(`Expected nonempty regular package: ${file}`)
  return stat
}
export function verifyCandidate(manifestPath, expected = {}) {
  manifestPath = path.resolve(manifestPath)
  regular(manifestPath)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const names = packages[manifest.platform]
  if (
    !Object.hasOwn(packages, manifest.platform) ||
    !names ||
    manifest.arch !== architectures[manifest.platform] ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version) ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceSha) ||
    !/^(?:\d+|local)$/.test(manifest.buildRunId)
  )
    throw new Error('Invalid candidate identity')
  for (const [key, value] of Object.entries(expected))
    if (manifest[key] !== value) throw new Error(`Candidate ${key} mismatch`)
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== Object.keys(names).length)
    throw new Error('Incorrect platform package set')
  const kinds = new Set()
  for (const artifact of manifest.artifacts) {
    if (
      !Object.hasOwn(names, artifact.kind) ||
      kinds.has(artifact.kind) ||
      artifact.path !== names[artifact.kind] ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0
    )
      throw new Error('Invalid candidate package')
    kinds.add(artifact.kind)
    const file = path.resolve(path.dirname(manifestPath), artifact.path)
    if (path.dirname(file) !== path.dirname(manifestPath)) throw new Error('Package escaped candidate directory')
    if (regular(file).size !== artifact.size || sha256(file) !== artifact.sha256)
      throw new Error('Candidate package hash/size mismatch')
  }
  const entries = readdirSync(path.dirname(manifestPath)).sort()
  if (JSON.stringify(entries) !== JSON.stringify(['candidate.json', ...Object.values(names)].sort()))
    throw new Error('Unexpected candidate files')
  return manifest
}
export function collectCandidate(platform, version, started = 0, targetDir = target) {
  const names = packages[platform]
  if (!Object.hasOwn(packages, platform) || !names) throw new Error('Unsupported release platform')
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  if (revision.status !== 0) throw new Error('Cannot determine candidate source commit')
  const sourceSha = revision.stdout.trim()
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceSha)
    throw new Error('Checkout differs from workflow source commit')
  const dir = path.join(root, 'dist', `candidate-${platform}`)
  noLinks(dir)
  mkdirSync(dir, { recursive: true })
  let sources
  if (platform === 'windows') {
    const windows = currentArtifacts()
    if (windows.version !== version) throw new Error('Windows release version mismatch')
    sources = Object.fromEntries(windows.artifacts.map((item) => [item.kind, item.file]))
  } else {
    const triple = platform === 'macos' ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-gnu'
    const bundle = path.join(targetDir, triple, 'release', 'bundle')
    sources = Object.fromEntries(
      Object.keys(names).map((kind) => {
        const directory = path.join(bundle, kind)
        noLinks(directory)
        const extension = { dmg: '.dmg', appimage: '.AppImage', deb: '.deb' }[kind]
        const matches = readdirSync(directory).filter(
          (name) =>
            name.endsWith(extension) &&
            name.includes(`_${version}_`) &&
            statSync(path.join(directory, name)).mtimeMs >= started - 2000,
        )
        if (matches.length !== 1) throw new Error(`Expected exactly one fresh ${kind} for ${version}`)
        const source = path.join(directory, matches[0])
        regular(source)
        return [kind, source]
      }),
    )
  }
  const artifacts = Object.entries(names).map(([kind, name]) => {
    const destination = path.join(dir, name)
    noLinks(destination)
    regular(sources[kind])
    copyFileSync(sources[kind], destination)
    return { kind, path: name, size: regular(destination).size, sha256: sha256(destination) }
  })
  const manifest = {
    version,
    platform,
    arch: architectures[platform],
    sourceSha,
    buildRunId: process.env.GITHUB_RUN_ID || 'local',
    artifacts,
  }
  const manifestPath = path.join(dir, 'candidate.json')
  noLinks(manifestPath)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  verifyCandidate(manifestPath)
  return manifest
}
export function aggregateCandidates(directory, expected) {
  const manifests = Object.keys(packages).map((platform) =>
    verifyCandidate(path.join(directory, `candidate-${platform}`, 'candidate.json'), { ...expected, platform }),
  )
  const artifacts = manifests.flatMap((manifest) =>
    manifest.artifacts.map((item) => ({
      ...item,
      file: path.join(directory, `candidate-${manifest.platform}`, item.path),
    })),
  )
  if (artifacts.length !== 5 || new Set(artifacts.map((item) => item.path)).size !== 5)
    throw new Error('Expected exactly five public packages')
  if (
    JSON.stringify(readdirSync(directory).sort()) !==
    JSON.stringify(
      Object.keys(packages)
        .map((platform) => `candidate-${platform}`)
        .sort(),
    )
  )
    throw new Error('Unexpected platform candidates')
  return artifacts
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory, version, sourceSha, buildRunId] = process.argv.slice(2)
  if (command === 'aggregate' && directory && version && sourceSha && buildRunId)
    console.log(JSON.stringify(aggregateCandidates(directory, { version, sourceSha, buildRunId }), null, 2))
  else if (command === 'verify' && directory) console.log(JSON.stringify(verifyCandidate(directory), null, 2))
  else
    throw new Error(
      'Usage: release-candidates.mjs verify <manifest> | aggregate <directory> <version> <source-sha> <run-id>',
    )
}
