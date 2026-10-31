// ZIP32 path and checksum helpers shared by reading and writing.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
export function normalizeZipPath(input: string): string {
  if (!input || input.includes('\0'))
    throw new Error('The ZIP filename is invalid')
  const path = input.replace(/\\/g, '/')
  if (path.startsWith('/') || /^[a-z]:\//i.test(path))
    throw new Error('The ZIP contains an absolute path')

  const segments = path.split('/')
  const normalized: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..')
      throw new Error('The ZIP contains a parent traversal path')
    normalized.push(segment)
  }
  return normalized.join('/') + (path.endsWith('/') ? '/' : '')
}
