import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { root, target } from './release-artifacts.mjs'
import { collectCandidate } from './release-candidates.mjs'
import { prepareNativeIcon } from './native-icon.mjs'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`)
}
const command = process.argv[2]
if (!['build', 'dev', 'clean'].includes(command)) throw new Error('Usage: app.mjs build | dev | clean')
if (command !== 'clean') prepareNativeIcon()
if (process.platform === 'win32') {
  const script = { build: 'build-app', dev: 'dev', clean: 'clean' }[command]
  run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `scripts\\${script}.bat`])
} else if (command === 'clean') {
  run('cargo', ['clean', '--manifest-path', 'src-tauri/Cargo.toml'])
} else if (command === 'dev') {
  run('pnpm', ['exec', 'tauri', 'dev'])
} else {
  if (
    !['darwin', 'linux'].includes(process.platform) ||
    (process.platform === 'darwin' ? process.arch !== 'arm64' : process.arch !== 'x64')
  )
    throw new Error('Native release requires Apple Silicon macOS or Linux x64')
  run(process.execPath, ['scripts/version-check.mjs'])
  run('pnpm', ['run', 'verify'])
  const started = Date.now()
  const triple = process.platform === 'darwin' ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-gnu'
  run('pnpm', ['exec', 'tauri', 'build', '--target', triple])
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
  collectCandidate(process.platform === 'darwin' ? 'macos' : 'linux', version, started, target)
}
if (command === 'build' && process.platform === 'win32') {
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
  collectCandidate('windows', version)
}
