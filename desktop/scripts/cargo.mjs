import { spawnSync } from 'node:child_process'
import { root } from './build/release-artifacts.mjs'
import { prepareNativeIcon } from './build/native-icon.mjs'

const [command, ...args] = process.argv.slice(2)
if (!command) throw new Error('Usage: cargo.mjs <cargo command> [arguments]')
prepareNativeIcon()
const cargoArgs = [command, '--manifest-path', 'src-tauri/Cargo.toml', ...args]
const result =
  process.platform === 'win32'
    ? spawnSync(
        process.env.ComSpec || 'cmd.exe',
        [
          '/d',
          '/s',
          '/c',
          `..\\node_modules\\@ouraihub\\msvc-kit\\cargo-msvc.bat ${cargoArgs.map((arg) => `"${arg.replaceAll('"', '\\"')}"`).join(' ')}`,
        ],
        { cwd: root, stdio: 'inherit', windowsVerbatimArguments: true },
      )
    : spawnSync('cargo', cargoArgs, { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
