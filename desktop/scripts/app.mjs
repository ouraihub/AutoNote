import { prepareNativeIcon } from './native-icon.mjs'
import { run } from './release-build.mjs'

const command = process.argv[2]
if (!['build', 'dev', 'clean'].includes(command)) throw new Error('Usage: app.mjs build | dev | clean')
if (command !== 'clean') prepareNativeIcon()

if (command === 'clean') {
  run('cargo', ['clean', '--manifest-path', 'src-tauri/Cargo.toml'])
} else if (command === 'dev') {
  if (process.platform === 'win32') run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'scripts\\dev.bat'])
  else run('pnpm', ['exec', 'tauri', 'dev'])
} else if (process.platform === 'win32') {
  run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'scripts\\build-app.bat'])
} else {
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : null
  if (!platform || (platform === 'macos' ? process.arch !== 'arm64' : process.arch !== 'x64'))
    throw new Error('Native release requires Apple Silicon macOS or Linux x64')
  run(process.execPath, ['scripts/release-build.mjs', 'build', '--platform', platform])
}
