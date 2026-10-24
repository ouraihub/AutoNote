import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { prepareNativeIcon } from './native-icon.mjs'
import { collect, root } from './release-artifacts.mjs'
import { collectCandidate } from './release-candidates.mjs'

const targets = {
  windows: 'x86_64-pc-windows-msvc',
  macos: 'aarch64-apple-darwin',
  linux: 'x86_64-unknown-linux-gnu',
}

export function run(command, args = [], options = {}) {
  console.log(`[release] run ${[command, ...args].join(' ')}`)
  const result =
    process.platform === 'win32' && command === 'pnpm'
      ? spawnSync(
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/s', '/c', `pnpm ${args.map((arg) => `"${arg}"`).join(' ')}`],
          { cwd: root, stdio: 'inherit', ...options, windowsVerbatimArguments: true },
        )
      : spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options })
  if (result.error) throw new Error(`Command could not start: ${command}`, { cause: result.error })
  if (result.status !== 0) throw new Error(`Command failed (${result.status}): ${command}`)
  return result
}

function buildRelease() {
  if (process.argv[2] !== 'build')
    throw new Error(
      'Usage: release-build.mjs build [--platform <windows|macos|linux>] [--target <triple>] [--skip-verify]',
    )
  const platform = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform]
  if (!platform) throw new Error(`Unsupported release host: ${process.platform}`)
  const options = { platform, target: targets[platform], skipVerify: process.env.AUTONOTE_SKIP_VERIFY === '1' }
  const args = process.argv.slice(3)
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--platform' && args[index + 1]) options.platform = args[++index]
    else if (arg === '--target' && args[index + 1]) options.target = args[++index]
    else if (arg === '--skip-verify') options.skipVerify = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!Object.hasOwn(targets, options.platform)) throw new Error(`Unsupported release platform: ${options.platform}`)
  if (options.platform !== platform)
    throw new Error(`Release platform ${options.platform} does not match host ${platform}`)
  if (options.target !== targets[platform]) throw new Error(`Unsupported release target: ${options.target}`)
  console.log(`[release] ${platform} release`)
  run(process.execPath, ['scripts/version-check.mjs'])
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
  prepareNativeIcon()
  if (!options.skipVerify) run('pnpm', ['run', 'verify'])
  const started = Date.now()
  run('pnpm', ['exec', 'tauri', 'build', '--target', options.target])
  if (platform === 'windows') collect(version, started)
  collectCandidate(platform, version, started)
  console.log(`[release] completed ${platform} ${version}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    buildRelease()
  } catch (error) {
    console.error(`[release] ERROR: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
