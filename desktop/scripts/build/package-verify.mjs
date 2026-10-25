import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { root } from './release-artifacts.mjs'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`)
}
run(process.execPath, ['scripts/app.mjs', 'build'], { env: { ...process.env, AUTONOTE_SKIP_VERIFY: '1' } })
if (process.platform === 'linux') {
  const home = mkdtempSync(path.join(tmpdir(), 'autonote-desktop-session-'))
  const runtime = path.join(home, 'run')
  mkdirSync(runtime, { mode: 0o700 })
  try {
    run(
      'xvfb-run',
      [
        '-a',
        '-s',
        '-screen 0 1280x900x24',
        'dbus-run-session',
        '--',
        'bash',
        '-euc',
        'trap \'if mountpoint -q "$XDG_RUNTIME_DIR/doc"; then fusermount3 -u "$XDG_RUNTIME_DIR/doc"; fi\' EXIT; printf "%s" "autonote-ci-only" | gnome-keyring-daemon --unlock --components=secrets; openbox & node scripts/build/smoke-native.mjs',
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          XDG_RUNTIME_DIR: runtime,
          XDG_DATA_HOME: path.join(home, '.local/share'),
          XDG_CONFIG_HOME: path.join(home, '.config'),
          XDG_CACHE_HOME: path.join(home, '.cache'),
        },
      },
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
} else if (process.platform === 'darwin') run(process.execPath, ['scripts/build/smoke-native.mjs'])
