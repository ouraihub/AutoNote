import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { currentArtifacts, sha256, noLinks } from './release-artifacts.mjs'
import { windowCases } from './smoke-app.mjs'
import { installCases } from './install-lifecycle.mjs'

export function verifyEvidence(directory, release = currentArtifacts()) {
  noLinks(directory)
  for (const [suite, cases] of [['window', windowCases], ['installation', installCases]]) {
    const report = JSON.parse(readFileSync(path.join(directory, `${suite}.json`), 'utf8'))
    if (report.status !== 'passed' || report.suite !== suite || report.version !== release.version || report.buildId !== release.buildId || !report.recordedAt || !report.windows) throw new Error(`Missing current real-${suite} acceptance`)
    for (const item of release.artifacts) if (!report.artifacts?.some(value => value.kind === item.kind && value.sha256 === item.sha256)) throw new Error(`Evidence is for a different ${item.kind} artifact`)
    if (!Array.isArray(report.cases) || report.cases.length !== cases.length) throw new Error(`Incomplete ${suite} matrix`)
    for (const id of cases) {
      const item = report.cases.find(value => value.id === id)
      if (!item || item.status !== 'passed' || !item.actual || !item.expected || /^(pass|ok|yes|done|通过|是)$/i.test(item.actual) || !/^[a-f0-9]{64}$/.test(item.screenshotSha256)) throw new Error(`Missing actual behavior evidence: ${id}`)
      if (path.basename(item.screenshot) !== item.screenshot) throw new Error('Evidence screenshot must be a local file')
      const screenshot = path.join(directory, item.screenshot)
      noLinks(screenshot)
      if (!existsSync(screenshot) || sha256(screenshot) !== item.screenshotSha256 || !readFileSync(screenshot).subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error(`Missing/altered screenshot: ${id}`)
    }
    if (suite === 'window' && (!report.readback?.contentSha256 || !report.readback?.attachmentSha256 || !report.slowCommitReadback || !report.slowCommitUiReadback || !report.offlineUiReadback || !report.importUiReadback || !report.restoredBounds)) throw new Error('Missing durable/window readbacks')
    if (suite === 'installation' && (!report.previousInstallerSha256 || !report.readbackSha256 || !report.retainedData || ['previousInstallerExitCode','sameVersionInstallerExitCode','upgradeInstallerExitCode','uninstallerExitCode','reinstallExitCode'].some(key => report[key] !== 0))) throw new Error('Missing real installation lifecycle/data evidence')
  }
  return release
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const directory = process.argv[2]
  if (!directory) throw new Error('Usage: node scripts/release-evidence.mjs <evidence-directory> [--protected-gate]')
  if (process.argv.includes('--protected-gate')) {
    if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.GITHUB_REPOSITORY || !process.env.GH_TOKEN) throw new Error('Protected gate must run in GitHub Actions')
    const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/environments/desktop-release`, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' } })
    if (!response.ok) throw new Error(`Cannot verify protected environment: HTTP ${response.status}`)
    const environment = await response.json()
    const review = environment.protection_rules?.find(rule => rule.type === 'required_reviewers')
    if (!review?.reviewers?.length || review.prevent_self_review !== true) throw new Error('desktop-release environment must require reviewers and prevent self review; release remains blocked')
  }
  const release = verifyEvidence(path.resolve(directory))
  console.log(`Verified actual window/install evidence bound to ${release.buildId}; human review remains mandatory`)
}
