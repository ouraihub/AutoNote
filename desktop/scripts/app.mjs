import { rmSync } from 'node:fs'
import path from 'node:path'
import { prepareNativeIcon } from './build/native-icon.mjs'
import { root } from './build/release-artifacts.mjs'
import { run } from './build/release-build.mjs'

const command = process.argv[2]
if (!['build', 'dev', 'clean'].includes(command)) throw new Error('Usage: app.mjs build | dev | clean')
if (command !== 'clean') prepareNativeIcon()
const cmd = (script) => run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', [script, ...process.argv.slice(3)].join(' ')])

if (command === 'clean') {
  // Windows keeps the library in data\ next to the exe, i.e. inside target\: cargo clean would delete it.
  if (process.platform === 'win32') cmd('scripts\\tools\\clean.bat')
  else {
    run('cargo', ['clean', '--manifest-path', 'src-tauri/Cargo.toml'])
    const generated = ['build', '.svelte-kit', 'dist/installer', '../web/dist', '../web/.svelte-kit']
    const modules = process.argv.includes('--deep') ? ['node_modules', '../node_modules', '../web/node_modules', '../packages/app/node_modules', '../packages/shared/node_modules'] : []
    for (const dir of [...generated, ...modules]) rmSync(path.join(root, dir), { recursive: true, force: true })
  }
} else if (command === 'dev') {
  if (process.platform === 'win32') cmd('scripts\\dev.bat')
  else run('pnpm', ['exec', 'tauri', 'dev'])
} else if (process.platform === 'win32') {
  cmd('scripts\\build-app.bat')
} else {
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : null
  if (!platform || (platform === 'macos' ? process.arch !== 'arm64' : process.arch !== 'x64'))
    throw new Error('Native release requires Apple Silicon macOS or Linux x64')
  run(process.execPath, ['scripts/build/release-build.mjs', 'build', '--platform', platform])
}
