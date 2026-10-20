import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { aggregateCandidates, verifyBuildRun } from './release-candidates.mjs'
import { root } from './release-artifacts.mjs'

function gh(args, token = process.env.GH_TOKEN) {
  const result = spawnSync('gh', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GH_TOKEN: token } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`GitHub command failed: ${result.stderr}`)
  return result.stdout
}
const tag = process.env.RELEASE_TAG
const runId = process.env.BUILD_RUN_ID
const repository = process.env.GITHUB_REPOSITORY
if (
  !/^desktop-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag) ||
  !/^\d+$/.test(runId) ||
  !repository ||
  !process.env.RELEASE_TOKEN
)
  throw new Error('Missing/invalid release inputs or RELEASE_TOKEN')
const version = tag.slice('desktop-v'.length)
const source = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
if (source.status !== 0) throw new Error('Cannot resolve selected tag commit')
const sourceSha = source.stdout.trim()
const run = JSON.parse(gh(['api', `repos/${repository}/actions/runs/${runId}`]))
const pages = JSON.parse(
  gh(['api', '--paginate', '--slurp', `repos/${repository}/actions/runs/${runId}/jobs?per_page=100`]),
)
const jobs = pages.flatMap((page) => page.jobs)
verifyBuildRun(run, jobs, sourceSha)
const artifacts = aggregateCandidates(path.join(root, 'dist/candidates'), { version, sourceSha, buildRunId: runId })
const stage = mkdtempSync(path.join(tmpdir(), 'autonote-public-release-'))
try {
  const files = artifacts.map((artifact) => {
    const destination = path.join(stage, artifact.path)
    copyFileSync(artifact.file, destination)
    return destination
  })
  const notes = `## Downloads / 下载\n\n| Asset | Platform |\n|---|---|\n| AutoNote-windows-setup.exe | Windows x64 installer / 安装版 |\n| AutoNote-windows-portable.zip | Windows x64 portable / 便携版 |\n| AutoNote-macos-arm64.dmg | macOS 11+ Apple Silicon |\n| AutoNote-linux-x64.AppImage | Linux x64 AppImage |\n| AutoNote-linux-x64.deb | Ubuntu 22.04+ / Debian-compatible x64 DEB |\n\nWindows requires WebView2. Windows data remains beside the executable in data. macOS data: ~/Library/Application Support/com.autonote.desktop. Linux data: absolute $XDG_DATA_HOME/com.autonote.desktop, otherwise ~/.local/share/com.autonote.desktop.\n\nmacOS is ad-hoc signed, **not Developer ID signed or notarized**; Gatekeeper may require explicit approval in Privacy & Security. Linux is built on Ubuntu 22.04 and requires WebKitGTK 4.1, GTK 3, AppIndicator and an unlocked Secret Service (for example GNOME Keyring) for saved credentials. AppImage may require FUSE 2 or --appimage-extract-and-run.\n\nmacOS 为临时签名，未经 Developer ID 签名及 Apple 公证；可能需要在隐私与安全性中明确允许。Linux 基于 Ubuntu 22.04 构建，保存凭据需已解锁的 Secret Service（如 GNOME Keyring）；并非任意发行版通用。\n\nNative compilation, complete automated checks, secure-store restart/tamper checks, package hashes and macOS/Linux packaged startup/window/database/screenshot smoke are release gates. These do not replace human installation, upgrade, tray, shortcuts or complete UI lifecycle acceptance. Windows interactive acceptance remains separate.\n\n原生编译、完整自动检查、安全存储跨进程及篡改检查、包哈希和 macOS/Linux 打包应用启动冒烟为发布门禁，不代表已完成人工安装、升级、托盘、快捷键或完整界面生命周期验收。\n`
  const checksums =
    '\n## SHA256\n\n' + artifacts.map((artifact) => `- \`${artifact.path}\`: \`${artifact.sha256}\``).join('\n') + '\n'
  gh(
    [
      'release',
      'create',
      tag,
      '--repo',
      'OurAIApps/AutoNote',
      '--title',
      `AutoNote Desktop ${version}`,
      '--notes',
      notes + checksums,
      ...files,
    ],
    process.env.RELEASE_TOKEN,
  )
  console.log(`Published exactly ${files.length} verified packages to OurAIApps/AutoNote ${tag}`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}
