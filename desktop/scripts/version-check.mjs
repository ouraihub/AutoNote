import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [config, pkg, cargo] = await Promise.all([readFile(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'), readFile(resolve(root, 'package.json'), 'utf8'), readFile(resolve(root, 'src-tauri/Cargo.toml'), 'utf8')])
const version = JSON.parse(config).version
const workspace = cargo.match(/\[workspace\.package\]([\s\S]*?)(?=\n\[)/)?.[1]?.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || JSON.parse(pkg).version !== version || workspace !== version) throw new Error('Desktop package, Tauri and Cargo workspace versions must agree')
if (process.argv[2] && process.argv[2] !== `desktop-v${version}`) throw new Error('Release tag must match desktop version')
process.stdout.write(`${version}\n`)
