import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { currentArtifacts, noLinks, powershellExe, sha256 } from './release-artifacts.mjs'
import { recorder, requireDesktop } from './interactive-evidence.mjs'

export const installCases = ['first-install', 'same-version-reinstall', 'upgrade', 'uninstall-preserve', 'reinstall-readback', 'unwritable-install', 'webview-installed', 'webview-absent']
function snapshot(directory) {
  const result = {}
  function walk(dir) {
    noLinks(dir)
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name)
      noLinks(file)
      if (statSync(file).isDirectory()) walk(file)
      else result[path.relative(directory, file)] = sha256(file)
    }
  }
  walk(directory)
  return result
}
async function execute(file, args = []) {
  noLinks(file)
  const child = spawn(file, args, { stdio: 'inherit' })
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  if (exitCode !== 0) throw new Error(`Installer/app exit code ${exitCode}: ${file}`)
  return exitCode
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  requireDesktop()
  const release = currentArtifacts()
  const previousArg = process.argv.indexOf('--previous')
  const previous = previousArg >= 0 && process.argv[previousArg + 1] ? path.resolve(process.argv[previousArg + 1]) : null
  if (!previous || !existsSync(previous)) throw new Error('Usage: node scripts/install-lifecycle.mjs --previous <real-previous-version-NSIS.exe>; actual upgrade cannot be skipped')
  const stage = mkdtempSync(path.join(tmpdir(), 'AutoNote 安装 lifecycle '))
  const install = path.join(stage, '用户 可写安装 AutoNote')
  const data = path.join(install, 'data')
  const evidence = recorder(path.join(stage, 'evidence'), 'installation', release)
  const current = release.artifacts.find(item => item.kind === 'nsis').file
  noLinks(previous)
  const previousInfo = spawnSync(powershellExe, ['-NoProfile', '-Command', '[Diagnostics.FileVersionInfo]::GetVersionInfo($env:AUTONOTE_PREVIOUS).ProductVersion'], { encoding: 'utf8', env: { ...process.env, AUTONOTE_PREVIOUS: previous } })
  const previousVersion = previousInfo.stdout.trim()
  const oldNumbers = previousVersion.split(/[.-]/).slice(0, 3).map(Number)
  const newNumbers = release.version.split(/[.-]/).slice(0, 3).map(Number)
  const difference = oldNumbers.map((value, index) => value - newNumbers[index]).find(value => value !== 0)
  if (previousInfo.status !== 0 || oldNumbers.length !== 3 || oldNumbers.some(value => !Number.isSafeInteger(value)) || !(difference < 0)) throw new Error('Upgrade acceptance requires an actual earlier-version NSIS installer')
  const marker = `AutoNote-install-${randomUUID()}`
  evidence.report.installPath = install
  evidence.report.previousVersion = previousVersion
  evidence.report.previousInstallerSha256 = sha256(previous)
  const readback = () => {
    const db = new DatabaseSync(path.join(data, 'library.db'), { readOnly: true })
    try {
      const note = db.prepare('SELECT content FROM notes WHERE instr(content,?)>0 AND deleted_at IS NULL').get(marker)
      if (!note) throw new Error('Installed user note is missing')
      return createHash('sha256').update(note.content).digest('hex')
    } finally { db.close() }
  }
  try {
    // Fail before touching an existing production registration/library.
    const { powershell } = await import('./interactive-evidence.mjs')
    powershell('if(Test-Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AutoNote"){throw "Use a clean standard-user test profile; an AutoNote installation already exists"}; if(Get-Process AutoNote -ErrorAction SilentlyContinue){throw "Close every AutoNote instance before installer acceptance"}')
    evidence.report.previousInstallerExitCode = await execute(previous, [`/D=${install}`])
    if (!existsSync(path.join(install, 'AutoNote.exe'))) throw new Error('Installer did not use the isolated selected path')
    console.log(`Create a real note containing ${marker}, upload any fixture image, inspect the preview and normally Exit.`)
    const firstRun = execute(path.join(install, 'AutoNote.exe'))
    await evidence.capture('first-install', 'In this clean standard-user profile install the previous-version NSIS to the isolated Unicode/space path, create the marker note/image and normally Exit.', 'No elevation; actual note and image are visible, exe/data use the chosen writable directory')
    await firstRun
    const originalReadback = readback()
    writeFileSync(path.join(data, 'lifecycle-sentinel.bin'), Buffer.from(randomUUID()))
    const original = snapshot(data)
    evidence.report.sameVersionInstallerExitCode = await execute(previous, [`/D=${install}`])
    for (const [file, hash] of Object.entries(original)) if (!existsSync(path.join(data, file)) || sha256(path.join(data, file)) !== hash) throw new Error(`Same-version reinstall changed user data: ${file}`)
    await evidence.capture('same-version-reinstall', 'Inspect same-version reinstall results and installation path; the script compares every preexisting data file byte-for-byte.', 'Existing note/attachment/cache/prefs/sentinel bytes unchanged')
    evidence.report.upgradeInstallerExitCode = await execute(current, [`/D=${install}`])
    for (const [file, hash] of Object.entries(original)) if (!existsSync(path.join(data, file)) || sha256(path.join(data, file)) !== hash) throw new Error(`Upgrade installer changed user data: ${file}`)
    const upgradedRun = execute(path.join(install, 'AutoNote.exe'))
    await evidence.capture('upgrade', 'In upgraded real UI inspect About version and marker note/image, then normally Exit.', `Version ${release.version}; original marker and attachment readable after actual previous-to-current upgrade`)
    await upgradedRun
    if (readback() !== originalReadback) throw new Error('Upgrade lost or altered user note')
    const beforeUninstall = snapshot(data)
    const uninstallers = readdirSync(install).filter(name => /^uninstall.*\.exe$/i.test(name))
    if (uninstallers.length !== 1) throw new Error('Expected exactly one real uninstaller')
    evidence.report.uninstallerExitCode = await execute(path.join(install, uninstallers[0]))
    if (JSON.stringify(beforeUninstall) !== JSON.stringify(snapshot(data))) throw new Error('Uninstall changed or removed retained user data')
    await evidence.capture('uninstall-preserve', 'Inspect real uninstaller completion message and retained data directory; no delete-library option is authorized.', 'Application removed, every user data file/hash kept and remaining path communicated')
    evidence.report.reinstallExitCode = await execute(current, [`/D=${install}`])
    const reinstallRun = execute(path.join(install, 'AutoNote.exe'))
    await evidence.capture('reinstall-readback', 'Open retained marker note/image after reinstall in the actual UI, then normally Exit.', 'Retained user note and image read back from the same data folder')
    await reinstallRun
    if (readback() !== originalReadback) throw new Error('Reinstall readback differs')
    evidence.report.readbackSha256 = originalReadback
    evidence.report.retainedData = beforeUninstall
    await evidence.capture('unwritable-install', 'Run current installer interactively choosing an isolated folder denied write permission to the standard test user. Cancel after observing refusal; never choose an existing production install.', 'Write probe rejects folder explicitly; no elevated daily-data dependency or fallback library')
    await evidence.capture('webview-installed', 'With WebView2 already installed, install/start the actual current NSIS in a clean isolated standard-user snapshot and capture UI/version/data path.', 'Existing runtime is used and real application window opens with portable cache')
    await evidence.capture('webview-absent', 'In a real clean Windows VM without WebView2, run this exact current NSIS; capture runtime bootstrap/install outcome, including network-denied failure, then successful guidance and application launch. Record VM OS/runtime version and artifact SHA256.', 'Runtime bootstrap/guidance is real; failure never claims installation usable; successful runtime install opens actual current app')
    evidence.report.status = 'passed'
  } finally {
    evidence.close()
    console.log(`Installation and evidence intentionally retained: ${stage}; uninstall via its own uninstaller, then remove only this isolated directory when evidence has been archived.`)
  }
}
