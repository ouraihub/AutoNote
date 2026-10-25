import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { root } from './release-artifacts.mjs'

export function prepareNativeIcon() {
  if (process.platform !== 'darwin' || existsSync(path.join(root, 'src-tauri/icons/icon.icns'))) return
  const icons = path.join(root, 'src-tauri/icons/generated.iconset')
  mkdirSync(icons, { recursive: true })
  function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${command} failed (${result.status})`)
  }
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2])
        run('sips', [
          '-z',
          String(size * scale),
          String(size * scale),
          'src-tauri/icons/icon.png',
          '--out',
          path.join(icons, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`),
        ])
    }
    run('iconutil', ['-c', 'icns', icons, '-o', 'src-tauri/icons/icon.icns'])
  } finally {
    rmSync(icons, { recursive: true, force: true })
  }
}
