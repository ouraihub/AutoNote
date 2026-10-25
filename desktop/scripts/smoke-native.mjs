import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CandidateStore } from '@ouraihub/desktop-kit'

if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Native smoke requires macOS or Linux')
const root = path.resolve(import.meta.dirname, '..')
const platform = process.platform === 'darwin' ? 'macos' : 'linux'
const dir = path.join(root, 'dist', `candidate-${platform}`)
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
const manifest = new CandidateStore('AutoNote', 'zip').verify(dir, { version })
const stage = mkdtempSync(path.join(tmpdir(), 'autonote-native-smoke-'))
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`)
  return result.stdout.trim()
}
async function launch(executable, cwd, label) {
  const home = path.join(stage, `home-${label}`)
  mkdirSync(home, { recursive: true })
  const data =
    platform === 'macos'
      ? path.join(home, 'Library/Application Support/com.autonote.desktop')
      : path.join(home, '.local/share/com.autonote.desktop')
  const child = spawn(executable, [], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      WEBKIT_DISABLE_DMABUF_RENDERER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let failure = null
  child.on('error', (error) => {
    failure = error
  })
  let output = ''
  const capture = (bytes) => {
    output = (output + bytes.toString()).slice(-8192)
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  const exited = new Promise((resolve) => child.once('exit', resolve))
  try {
    let window
    for (let attempt = 0; attempt < 60; attempt++) {
      if (failure) throw failure
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Packaged app exited before startup (${child.exitCode || child.signalCode})`)
      if (platform === 'linux') {
        const result = spawnSync(
          'xdotool',
          ['search', '--onlyvisible', '--pid', String(child.pid), '--name', '^AutoNote$'],
          { encoding: 'utf8' },
        )
        if (result.status === 0) window = result.stdout.trim().split('\n')[0]
      } else {
        const script = `import Foundation\nimport CoreGraphics\nlet windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []\nif windows.contains(where: { ($0[kCGWindowOwnerPID as String] as? Int) == ${child.pid} && ($0[kCGWindowLayer as String] as? Int) == 0 }) { print("visible") }\n`
        if (run('swift', ['-e', script]) === 'visible') window = 'visible'
      }
      if (window && existsSync(path.join(data, 'library.db'))) break
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    if (!window || !existsSync(path.join(data, 'library.db')))
      throw new Error('No real native window or isolated startup database')
    const db = new DatabaseSync(path.join(data, 'library.db'), { readOnly: true })
    try {
      if (
        db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' ||
        !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'").get()
      )
        throw new Error('Startup database is not initialized')
    } finally {
      db.close()
    }
    const screenshot = path.join(stage, `${label}.png`)
    if (platform === 'linux') {
      let rendered = false
      for (let attempt = 0; attempt < 30; attempt++) {
        run('import', ['-window', window, `PNG:${screenshot}`])
        const [width, height, colors] = run('identify', ['-format', '%w %h %k', screenshot]).split(' ').map(Number)
        if (width >= 960 && height >= 640 && colors > 16) {
          rendered = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      if (!rendered) throw new Error('Native window did not render a full-size application frame')
    } else run('screencapture', ['-x', screenshot])
    if (!readFileSync(screenshot).subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
      throw new Error('Native screenshot is not PNG')
    console.log(
      `PASS: ${label}: visible native window, isolated HOME database schema/quick_check and screenshot (not full UI acceptance)`,
    )
  } catch (error) {
    throw new Error(`${error.message}\nNative app output (last 8 KiB):\n${output}`, { cause: error })
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))])
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await exited
      }
    }
  }
}
try {
  if (platform === 'macos') {
    const mount = path.join(stage, 'mount')
    mkdirSync(mount)
    const dmg = path.join(dir, manifest.artifacts[0].path)
    run('hdiutil', ['verify', dmg])
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg])
    try {
      const apps = readdirSync(mount).filter((name) => name.endsWith('.app'))
      if (apps.length !== 1) throw new Error('DMG must contain exactly one app')
      const app = path.join(mount, apps[0])
      if (
        run('/usr/libexec/PlistBuddy', [
          '-c',
          'Print :CFBundleShortVersionString',
          path.join(app, 'Contents/Info.plist'),
        ]) !== version
      )
        throw new Error('DMG embedded version mismatch')
      run('codesign', ['--verify', '--deep', '--strict', app])
      const executableName = run('/usr/libexec/PlistBuddy', [
        '-c',
        'Print :CFBundleExecutable',
        path.join(app, 'Contents/Info.plist'),
      ])
      const binary = path.join(app, 'Contents/MacOS', executableName)
      if (run('lipo', ['-archs', binary]) !== 'arm64') throw new Error('DMG architecture must be arm64')
      await launch(binary, stage, 'dmg')
    } finally {
      run('hdiutil', ['detach', mount])
    }
  } else {
    const deb = path.join(dir, manifest.artifacts.find((item) => item.kind === 'deb').path)
    if (run('dpkg-deb', ['-f', deb, 'Version']) !== version || run('dpkg-deb', ['-f', deb, 'Architecture']) !== 'amd64')
      throw new Error('DEB version/architecture mismatch')
    const extracted = path.join(stage, 'deb')
    run('dpkg-deb', ['-x', deb, extracted])
    const binaries = readdirSync(path.join(extracted, 'usr/bin'))
    if (binaries.length !== 1) throw new Error('Expected one DEB application binary')
    const debBinary = path.join(extracted, 'usr/bin', binaries[0])
    const binaryType = run('file', ['-b', debBinary])
    if (!binaryType.includes('ELF 64-bit LSB') || !binaryType.includes('x86-64'))
      throw new Error('DEB must contain native Linux x64 ELF')
    await launch(path.join(extracted, 'usr/bin', binaries[0]), stage, 'deb')
    const appimage = path.join(dir, manifest.artifacts.find((item) => item.kind === 'appimage').path)
    run('chmod', ['+x', appimage])
    run(appimage, ['--appimage-extract'], { cwd: stage })
    const image = path.join(stage, 'squashfs-root')
    const desktops = readdirSync(image).filter((name) => name.endsWith('.desktop'))
    if (desktops.length !== 1 || !readFileSync(path.join(image, desktops[0]), 'utf8').includes('AutoNote'))
      throw new Error('AppImage desktop metadata missing')
    const imageBinary = path.join(image, 'usr/bin', binaries[0])
    const imageType = run('file', ['-b', imageBinary])
    const buildId = (binary) => run('readelf', ['-n', binary]).match(/Build ID: ([a-f0-9]+)/)?.[1]
    const debId = buildId(debBinary)
    if (
      !imageType.includes('ELF 64-bit LSB') ||
      !imageType.includes('x86-64') ||
      !debId ||
      buildId(imageBinary) !== debId
    )
      throw new Error('AppImage executable architecture/build identity differs from DEB')
    if (
      !readFileSync(imageBinary).includes(Buffer.from('__TAURI_BUNDLE_TYPE_VAR_APP')) ||
      !readFileSync(debBinary).includes(Buffer.from('__TAURI_BUNDLE_TYPE_VAR_DEB'))
    )
      throw new Error('Linux executable bundle marker mismatch')
    await launch(path.join(image, 'AppRun'), image, 'appimage')
  }
} finally {
  rmSync(stage, { recursive: true, force: true })
}
