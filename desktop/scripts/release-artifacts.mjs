import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const target = path.resolve(root, 'src-tauri', process.env.CARGO_TARGET_DIR || 'target')
export const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')
export function noLinks(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Refusing linked path: ${current}`)
    if (path.dirname(current) === current) break
  }
}
export function currentArtifacts(manifestPath = path.join(root, 'dist', 'release.json')) {
  manifestPath = path.resolve(manifestPath)
  noLinks(manifestPath)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version) || typeof manifest.buildId !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.exeSha256)) throw new Error('Invalid release identity')
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 2) throw new Error('Expected exactly NSIS and portable artifacts')
  const kinds = new Set()
  for (const artifact of manifest.artifacts) {
    if (!['nsis', 'portable'].includes(artifact.kind) || kinds.has(artifact.kind) || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('Invalid artifact manifest')
    kinds.add(artifact.kind)
    const file = path.resolve(path.dirname(manifestPath), artifact.path)
    if (!file.startsWith(path.dirname(manifestPath) + path.sep)) throw new Error('Artifact escaped release directory')
    noLinks(file)
    if (!statSync(file).isFile() || sha256(file) !== artifact.sha256) throw new Error(`Artifact hash mismatch: ${file}`)
    const inspect = artifact.kind === 'portable'
      ? '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($env:AUTONOTE_PACKAGE); try { $names=@($z.Entries | Where-Object {!$_.FullName.EndsWith("/")} | ForEach-Object {$_.FullName.Replace([char]92,[char]47)}); if($names.Count -ne 2 -or $names -notcontains "AutoNote/AutoNote.exe" -or $names -notcontains "AutoNote/LICENSE"){throw "Portable must contain only exe and license"}; $e=$z.GetEntry("AutoNote/AutoNote.exe"); if($null -eq $e){$e=$z.Entries | Where-Object {$_.FullName.Replace([char]92,[char]47) -eq "AutoNote/AutoNote.exe"}}; $s=$e.Open(); try {$h=[Security.Cryptography.SHA256]::Create(); $hex=([BitConverter]::ToString($h.ComputeHash($s))).Replace("-","").ToLower(); if($hex -ne $env:AUTONOTE_EXE_HASH){throw "Portable executable differs"}} finally {$s.Dispose();$h.Dispose()}} finally {$z.Dispose()}'
      : '$ErrorActionPreference="Stop"; $v=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:AUTONOTE_PACKAGE); if($v.ProductVersion -ne $env:AUTONOTE_VERSION){throw "NSIS embedded version differs"}'
    if (process.platform === 'win32') {
      const result = spawnSync('powershell', ['-NoProfile', '-Command', inspect], { stdio: 'inherit', env: { ...process.env, AUTONOTE_PACKAGE: file, AUTONOTE_EXE_HASH: manifest.exeSha256, AUTONOTE_VERSION: manifest.version } })
      if (result.status !== 0) throw new Error('Package structure/version verification failed')
    }
    artifact.file = file
  }
  return manifest
}

function collect(version, started) {
  const src = path.join(target, 'x86_64-pc-windows-msvc', 'release')
  const exe = path.join(src, 'AutoNote.exe')
  const nsis = path.join(src, 'bundle', 'nsis')
  noLinks(src)
  noLinks(exe); noLinks(nsis)
  const installers = readdirSync(nsis).filter(name => name.endsWith('-setup.exe') && name.includes(`_${version}_`) && statSync(path.join(nsis, name)).mtimeMs >= started - 2000)
  for (const name of installers) noLinks(path.join(nsis, name))
  if (installers.length !== 1 || !statSync(exe).isFile()) throw new Error('Expected current executable and exactly one current-version NSIS installer')
  const exeVersion = spawnSync('powershell', ['-NoProfile', '-Command', '$ErrorActionPreference="Stop"; $v=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:AUTONOTE_EXE); if($v.ProductVersion -ne $env:AUTONOTE_VERSION){throw "Built exe version differs from manifests"}'], { stdio: 'inherit', env: { ...process.env, AUTONOTE_EXE: exe, AUTONOTE_VERSION: version } })
  if (exeVersion.status !== 0) throw new Error('Built executable version verification failed')
  const dist = path.join(root, 'dist')
  const portable = path.join(dist, 'AutoNote')
  const releases = path.join(dist, 'installer')
  noLinks(portable); noLinks(releases)
  mkdirSync(releases, { recursive: true }); mkdirSync(portable, { recursive: true })
  const id = `${version}-${randomUUID()}`
  const stage = path.join(releases, `.stage-${id}`)
  const final = path.join(releases, id)
  const payload = path.join(stage, 'AutoNote')
  mkdirSync(payload, { recursive: true })
  try {
    copyFileSync(exe, path.join(payload, 'AutoNote.exe'))
    const license = path.resolve(root, '..', 'LICENSE')
    if (!existsSync(license)) throw new Error('Missing distribution license')
    copyFileSync(license, path.join(payload, 'LICENSE'))
    const installerName = installers[0]
    copyFileSync(path.join(nsis, installerName), path.join(stage, installerName))
    const zipName = `AutoNote_${version}_x64-portable.zip`
    const zip = path.join(stage, zipName)
    const result = spawnSync('powershell', ['-NoProfile', '-Command', '$ErrorActionPreference="Stop"; Compress-Archive -LiteralPath $env:AUTONOTE_PAYLOAD -DestinationPath $env:AUTONOTE_ZIP -CompressionLevel Optimal'], { stdio: 'inherit', env: { ...process.env, AUTONOTE_PAYLOAD: payload, AUTONOTE_ZIP: zip } })
    if (result.status !== 0) throw new Error('Portable packaging failed')
    const artifacts = [{ kind: 'nsis', path: installerName }, { kind: 'portable', path: zipName }].map(item => ({ ...item, sha256: sha256(path.join(stage, item.path)) }))
    rmSync(payload, { recursive: true })
    renameSync(stage, final)
    const executableTemp = path.join(portable, `.AutoNote-${id}.exe`)
    copyFileSync(exe, executableTemp)
    const manifest = { version, buildId: id, createdAt: new Date().toISOString(), exeSha256: sha256(exe), artifacts: artifacts.map(item => ({ ...item, path: path.relative(dist, path.join(final, item.path)).replaceAll('\\', '/') })) }
    const temporary = path.join(dist, `.release-${id}.json`)
    writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n')
    currentArtifacts(temporary)
    renameSync(executableTemp, path.join(portable, 'AutoNote.exe'))
    renameSync(temporary, path.join(dist, 'release.json'))
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n')
  } catch (error) {
    console.error(`Packaging failed; unpublished evidence retained at ${stage}`)
    throw error
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, version, started] = process.argv.slice(2)
  if (command === 'target') process.stdout.write(target + '\n')
  else if (command === 'collect' && version && Number.isFinite(Number(started))) collect(version, Number(started))
  else if (command === 'verify') process.stdout.write(JSON.stringify(currentArtifacts(), null, 2) + '\n')
  else throw new Error('Usage: release-artifacts.mjs target | collect <version> <build-start-ms> | verify')
}
