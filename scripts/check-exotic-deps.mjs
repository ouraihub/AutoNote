// pnpm has no per-package exotic allowlist, and Aether's Git subpackages depend on each other through
// workspace:*, so `blockExoticSubdeps` must be off. This gate restores the narrow policy: every non-registry
// resolution in the lockfile must be an ouraihub GitHub tarball pinned to a full commit SHA.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ALLOWED = /^https:\/\/codeload\.github\.com\/ouraihub\/(?:Aether|desktop-kit|release-kit)\/tar\.gz\/[0-9a-f]{40}$/

/** Returns one message per lockfile resolution that is not a registry package or an allowed pinned tarball. */
export function exoticViolations(lockfile) {
  const violations = []
  for (const [index, line] of lockfile.split('\n').entries()) {
    const resolution = /^\s+resolution: \{(.*)\}$/.exec(line)?.[1]
    if (resolution === undefined || /^integrity: [^,]+$/.test(resolution)) continue
    const tarball = /(?:^|, )tarball: ([^,]+)(?:,|$)/.exec(resolution)?.[1]
    if (!tarball || !ALLOWED.test(tarball) || /(?:^|, )type: /.test(resolution))
      violations.push(`pnpm-lock.yaml:${index + 1}: exotic resolution not allowed: {${resolution}}`)
  }
  return violations
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const violations = exoticViolations(readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'))
  for (const violation of violations) console.error(violation)
  if (violations.length) process.exit(1)
}
