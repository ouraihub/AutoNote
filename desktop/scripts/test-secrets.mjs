import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { root } from './release-artifacts.mjs'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`)
}
if (process.argv.includes('--session') || process.platform === 'win32') {
  const stage = mkdtempSync(path.join(tmpdir(), 'autonote-secret-bytes-'))
  try {
    for (const command of ['seal', 'open', 'tamper', 'forget'])
      run(process.execPath, [
        'scripts/cargo.mjs',
        'run',
        '-p',
        'autonote-shell',
        '--example',
        'native-secrets',
        '--',
        command,
        path.join(stage, 'sealed.json'),
      ])
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
} else {
  const home = mkdtempSync(path.join(tmpdir(), 'autonote-keyring-'))
  const env = {
    ...process.env,
    HOME: home,
    CARGO_HOME: process.env.CARGO_HOME || path.join(homedir(), '.cargo'),
    RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(homedir(), '.rustup'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
  }
  env.XDG_RUNTIME_DIR = path.join(home, 'run')
  mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 })
  mkdirSync(env.XDG_DATA_HOME, { recursive: true })
  try {
    if (process.platform === 'linux') {
      run(
        'dbus-run-session',
        [
          '--',
          'bash',
          '-euc',
          'printf "%s" "autonote-ci-only" | gnome-keyring-daemon --unlock --components=secrets; exec node scripts/test-secrets.mjs --session',
        ],
        { env },
      )
    } else if (process.platform === 'darwin') {
      const keychain = path.join(home, 'native-smoke.keychain-db')
      const password = randomBytes(24).toString('hex')
      const previous = spawnSync('security', ['default-keychain', '-d', 'user'], { encoding: 'utf8' })
      if (previous.status !== 0) throw new Error('Cannot determine original default keychain')
      const original = previous.stdout.trim().replace(/^"|"$/g, '')
      const previousList = spawnSync('security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' })
      if (previousList.status !== 0) throw new Error('Cannot determine original keychain search list')
      const searchList = [...previousList.stdout.matchAll(/"([^"]+)"/g)].map((match) => match[1])
      let failure
      let created = false
      try {
        run('security', ['create-keychain', '-p', password, keychain])
        created = true
        run('security', ['set-keychain-settings', '-lut', '21600', keychain])
        run('security', ['unlock-keychain', '-p', password, keychain])
        run('security', ['default-keychain', '-d', 'user', '-s', keychain])
        run('security', ['list-keychains', '-d', 'user', '-s', keychain, ...searchList])
        run(process.execPath, ['scripts/test-secrets.mjs', '--session'], { env: process.env })
      } catch (error) {
        failure = error
      } finally {
        const errors = failure ? [failure] : []
        for (const args of [
          ['default-keychain', '-d', 'user', '-s', original],
          ['list-keychains', '-d', 'user', '-s', ...searchList],
          ...(created ? [['delete-keychain', keychain]] : []),
        ]) {
          try {
            run('security', args)
          } catch (error) {
            errors.push(error)
          }
        }
        if (errors.length) throw new AggregateError(errors, 'Native credential check/keychain cleanup failed')
      }
    } else throw new Error('Native credential integration requires Windows, macOS or Linux')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}
