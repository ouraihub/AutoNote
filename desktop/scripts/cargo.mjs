import { spawnSync } from 'node:child_process'
import { root } from './release-artifacts.mjs'
import { prepareNativeIcon } from './native-icon.mjs'

const [command, ...args] = process.argv.slice(2)
if (!command) throw new Error('Usage: cargo.mjs <cargo command> [arguments]')
prepareNativeIcon()
const windows = process.platform === 'win32'
const result = windows
  ? spawnSync(
      process.env.ComSpec || 'cmd.exe',
      [
        '/d',
        '/s',
        '/c',
        `scripts\\cargo-msvc.bat ${[command, ...args].map((arg) => `"${arg.replaceAll('"', '\\"')}"`).join(' ')}`,
      ],
      { cwd: root, stdio: 'inherit', windowsVerbatimArguments: true },
    )
  : spawnSync('cargo', [command, '--manifest-path', 'src-tauri/Cargo.toml', ...args], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
