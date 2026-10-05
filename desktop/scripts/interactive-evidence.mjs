import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { stdin, stdout } from 'node:process'
import path from 'node:path'
import { currentArtifacts, sha256 } from './release-artifacts.mjs'
import os from 'node:os'

export function requireDesktop() {
  if (process.platform !== 'win32' || !stdin.isTTY || !stdout.isTTY || process.env.GITHUB_ACTIONS === 'true') throw new Error('Requires an interactive Windows standard-user desktop; headless checks cannot satisfy window acceptance')
  const result = spawnSync('powershell', ['-NoProfile', '-Command', '$p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){exit 1}; if(![Environment]::UserInteractive){exit 2}'])
  if (result.status !== 0) throw new Error('Run as a non-elevated standard user in an interactive desktop session')
}
export function powershell(script, variables = {}) {
  const result = spawnSync('powershell', ['-NoProfile', '-Command', '$ErrorActionPreference="Stop"; ' + script], { stdio: 'inherit', env: { ...process.env, ...variables } })
  if (result.status !== 0) throw new Error(`Windows operation failed (${result.status})`)
}
export function recorder(directory, suite, release = currentArtifacts()) {
  requireDesktop()
  mkdirSync(directory, { recursive: true })
  const rl = createInterface({ input: stdin, output: stdout })
  const report = { suite, version: release.version, buildId: release.buildId, artifacts: release.artifacts.map(({kind, sha256}) => ({kind, sha256})), windows: `${os.type()} ${os.release()} ${os.version()} ${os.arch()}`, evidencePath: directory, recordedAt: new Date().toISOString(), cases: [] }
  function save() { writeFileSync(path.join(directory, `${suite}.json`), JSON.stringify(report, null, 2) + '\n') }
  return {
    directory, report,
    async ask(message) { const answer = (await rl.question(message + '\n> ')).trim(); if (!answer) throw new Error('Concrete observed value is required'); return answer },
    async capture(id, instructions, expected) {
      console.log(`\n[${id}] ${instructions}\nExpected: ${expected}`)
      const actual = (await rl.question('Enter the actual observed value (not pass/ok); screenshot is captured next:\n> ')).trim()
      if (!actual || /^(pass|ok|yes|done|通过|是)$/i.test(actual)) throw new Error('Provide actual UI/operation readback, not a success label')
      const screenshot = `${suite}-${id}.png`
      powershell('Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $r=[Windows.Forms.SystemInformation]::VirtualScreen; $b=New-Object Drawing.Bitmap($r.Width,$r.Height); $g=[Drawing.Graphics]::FromImage($b); try {$g.CopyFromScreen($r.Left,$r.Top,0,0,$b.Size); $b.Save($env:AUTONOTE_SCREEN,[Drawing.Imaging.ImageFormat]::Png)} finally {$g.Dispose();$b.Dispose()}', { AUTONOTE_SCREEN: path.join(directory, screenshot) })
      const confirmation = (await rl.question('If actual behavior matches expected exactly, type MATCH; otherwise type FAIL:\n> ')).trim()
      report.cases.push({ id, expected, actual, status: confirmation === 'MATCH' ? 'passed' : 'failed', screenshot, screenshotSha256: sha256(path.join(directory, screenshot)) })
      save()
      if (confirmation !== 'MATCH') throw new Error(`Acceptance failed: ${id}`)
    },
    close() { save(); rl.close() }
  }
}
