// Git workspace edges need exotic subdependencies; validate every YAML resolution instead.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseAllDocuments } from 'yaml'

const ALLOWED = /^https:\/\/codeload\.github\.com\/ouraihub\/(?:Aether|desktop-kit|release-kit)\/tar\.gz\/[0-9a-f]{40}$/
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const integrity = (value) => typeof value === 'string' && /^sha(?:256|512)-[A-Za-z0-9+/]+={0,2}$/.test(value)

function allowed(value, name) {
  if (!object(value)) return false
  const keys = Object.keys(value)
  if (keys.length === 1 && integrity(value.integrity)) return true
  if (keys.every((key) => ['gitHosted', 'integrity', 'path', 'tarball'].includes(key)) &&
      value.gitHosted === true && integrity(value.integrity) && typeof value.tarball === 'string' && ALLOWED.test(value.tarball) &&
      (value.path === undefined || typeof value.path === 'string' && /^packages\/[a-z-]+$/.test(value.path))) return true
  const runtime = /^node@runtime:(\d+\.\d+\.\d+)$/.exec(name)?.[1]
  if (!runtime || value.type !== 'variations' || keys.some((key) => !['type', 'variants'].includes(key)) ||
      !Array.isArray(value.variants) || !value.variants.length) return false
  return value.variants.every((variant) => {
    if (!object(variant) || !object(variant.resolution)) return false
    const r = variant.resolution
    return Object.keys(r).every((key) => ['archive', 'bin', 'prefix', 'integrity', 'type', 'url'].includes(key)) &&
      r.type === 'binary' && integrity(r.integrity) && typeof r.url === 'string' &&
      (r.url.startsWith(`https://nodejs.org/download/release/v${runtime}/node-v${runtime}-`) ||
        ['arm64', 'x64'].some((arch) => r.url === `https://unofficial-builds.nodejs.org/download/release/v${runtime}/node-v${runtime}-linux-${arch}-musl.tar.gz`)) &&
      !r.url.includes('..') && /^https:\/\/(?:nodejs\.org|unofficial-builds\.nodejs\.org)\/[A-Za-z0-9/_.-]+$/.test(r.url)
  })
}

export function exoticViolations(lockfile) {
  const violations = []
  try {
    const documents = parseAllDocuments(lockfile)
    if (!documents.length) return ['pnpm-lock.yaml: missing document']
    for (const document of documents) {
      if (document.errors.length) throw new Error('invalid YAML')
      const data = document.toJS({ maxAliasCount: 0 })
      if (!object(data) || !object(data.packages)) throw new Error('missing packages')
      for (const [name, pkg] of Object.entries(data.packages)) {
        if (!object(pkg) || !allowed(pkg.resolution, name)) violations.push(`pnpm-lock.yaml: unapproved resolution for ${name}`)
      }
    }
  } catch {
    violations.push('pnpm-lock.yaml: invalid or unsupported lockfile')
  }
  return violations
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const violations = exoticViolations(readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'))
  for (const violation of violations) console.error(violation)
  if (violations.length) process.exit(1)
}
