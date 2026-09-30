const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const MAX_VERSION_LENGTH = 64

export function isValidVersion(version: unknown): version is string {
  return (
    typeof version === 'string' &&
    version.length <= MAX_VERSION_LENGTH &&
    SEMVER_PATTERN.test(version)
  )
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  if (!leftParts || !rightParts) return 0

  for (let index = 0; index < 3; index++) {
    const compared = compareNumericStrings(leftParts[index]!, rightParts[index]!)
    if (compared !== 0) return compared
  }
  return 0
}

export function isNewerVersion(latest: string | null, current: string): boolean {
  return (
    latest !== null &&
    isValidVersion(latest) &&
    isValidVersion(current) &&
    compareVersions(latest, current) > 0
  )
}

function parseVersion(version: string): [string, string, string] | null {
  const match = SEMVER_PATTERN.exec(version)
  return match ? [match[1]!, match[2]!, match[3]!] : null
}

function compareNumericStrings(left: string, right: string): number {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1
  if (left === right) return 0
  return left > right ? 1 : -1
}
