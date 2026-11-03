import { crc32, normalizeZipPath } from './zip-common'

export { crc32 } from './zip-common'
export { readZip } from './zip-reader'
export type { ReadZipOptions, UnzippedEntry } from './zip-reader'

export interface ZipEntry {
  path: string
  data: Uint8Array

  mtime?: number
}

export interface ZipEntrySize {
  path: string
  byteLength: number
}

export function estimateZipSize(entries: readonly ZipEntry[]): number {
  return estimateZipSizeFromSizes(
    entries.map((entry) => ({
      path: entry.path,
      byteLength: entry.data.byteLength,
    })),
  )
}

export function estimateZipSizeFromSizes(
  entries: readonly ZipEntrySize[],
): number {
  if (entries.length > 0xffff)
    throw new Error('The ZIP contains too many entries')
  const encoder = new TextEncoder()
  const paths = new Set<string>()
  let total = 22

  for (const entry of entries) {
    const path = normalizeZipPath(entry.path)
    if (!path || path.endsWith('/'))
      throw new Error('The ZIP filename is invalid')
    const nameBytes = encoder.encode(path)
    if (!nameBytes.length || nameBytes.length > 0xffff)
      throw new Error('The ZIP filename is invalid or too long')
    if (
      !Number.isSafeInteger(entry.byteLength) ||
      entry.byteLength < 0 ||
      entry.byteLength > 0xffffffff
    ) {
      throw new Error(`ZIP file is too large: ${entry.path}`)
    }
    const key = path.toLowerCase()
    if (paths.has(key))
      throw new Error(`The ZIP contains a duplicate path: ${entry.path}`)
    paths.add(key)
    total += 76 + nameBytes.byteLength * 2 + entry.byteLength
    if (!Number.isSafeInteger(total) || total > 0xffffffff) {
      throw new Error('The ZIP exceeds ZIP32 limits')
    }
  }
  return total
}

function dosDateTime(ms: number): { date: number; time: number } {
  const d = new Date(ms)
  const year = Math.min(2107, Math.max(1980, d.getUTCFullYear()))
  return {
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time:
      (d.getUTCHours() << 11) |
      (d.getUTCMinutes() << 5) |
      (d.getUTCSeconds() >> 1),
  }
}

export function createZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length > 0xffff)
    throw new Error('The ZIP contains too many entries')

  const encoder = new TextEncoder()
  const now = Date.now()
  const paths = new Set<string>()

  const prepared = entries.map((entry) => {
    const path = normalizeZipPath(entry.path)
    if (!path || path.endsWith('/'))
      throw new Error('The ZIP filename is invalid')
    const nameBytes = encoder.encode(path)
    if (!nameBytes.length || nameBytes.length > 0xffff)
      throw new Error('The ZIP filename is invalid or too long')
    if (entry.data.byteLength > 0xffffffff)
      throw new Error(`ZIP file is too large: ${entry.path}`)
    const key = path.toLowerCase()
    if (paths.has(key))
      throw new Error(`The ZIP contains a duplicate path: ${entry.path}`)
    paths.add(key)
    return {
      nameBytes,
      data: entry.data,
      crc: crc32(entry.data),
      ...dosDateTime(entry.mtime ?? now),
    }
  })

  const localSize = prepared.reduce(
    (sum, e) => sum + 30 + e.nameBytes.length + e.data.length,
    0,
  )
  const centralSize = prepared.reduce(
    (sum, e) => sum + 46 + e.nameBytes.length,
    0,
  )
  const totalSize = localSize + centralSize + 22
  if (!Number.isSafeInteger(totalSize) || totalSize > 0xffffffff) {
    throw new Error('The ZIP exceeds ZIP32 limits')
  }
  const out = new Uint8Array(totalSize)
  const dv = new DataView(out.buffer)

  let offset = 0
  const offsets: number[] = []

  for (const e of prepared) {
    offsets.push(offset)
    dv.setUint32(offset, 0x04034b50, true)
    dv.setUint16(offset + 4, 20, true)
    dv.setUint16(offset + 6, 0x0800, true)
    dv.setUint16(offset + 8, 0, true)
    dv.setUint16(offset + 10, e.time, true)
    dv.setUint16(offset + 12, e.date, true)
    dv.setUint32(offset + 14, e.crc, true)
    dv.setUint32(offset + 18, e.data.length, true)
    dv.setUint32(offset + 22, e.data.length, true)
    dv.setUint16(offset + 26, e.nameBytes.length, true)
    dv.setUint16(offset + 28, 0, true)
    offset += 30
    out.set(e.nameBytes, offset)
    offset += e.nameBytes.length
    out.set(e.data, offset)
    offset += e.data.length
  }

  const centralStart = offset
  for (let i = 0; i < prepared.length; i++) {
    const e = prepared[i]!
    dv.setUint32(offset, 0x02014b50, true)
    dv.setUint16(offset + 4, 20, true)
    dv.setUint16(offset + 6, 20, true)
    dv.setUint16(offset + 8, 0x0800, true)
    dv.setUint16(offset + 10, 0, true)
    dv.setUint16(offset + 12, e.time, true)
    dv.setUint16(offset + 14, e.date, true)
    dv.setUint32(offset + 16, e.crc, true)
    dv.setUint32(offset + 20, e.data.length, true)
    dv.setUint32(offset + 24, e.data.length, true)
    dv.setUint16(offset + 28, e.nameBytes.length, true)
    dv.setUint16(offset + 30, 0, true)
    dv.setUint16(offset + 32, 0, true)
    dv.setUint16(offset + 34, 0, true)
    dv.setUint16(offset + 36, 0, true)
    dv.setUint32(offset + 38, 0, true)
    dv.setUint32(offset + 42, offsets[i]!, true)
    offset += 46
    out.set(e.nameBytes, offset)
    offset += e.nameBytes.length
  }

  dv.setUint32(offset, 0x06054b50, true)
  dv.setUint16(offset + 4, 0, true)
  dv.setUint16(offset + 6, 0, true)
  dv.setUint16(offset + 8, prepared.length, true)
  dv.setUint16(offset + 10, prepared.length, true)
  dv.setUint32(offset + 12, offset - centralStart, true)
  dv.setUint32(offset + 16, centralStart, true)
  dv.setUint16(offset + 20, 0, true)

  return out
}
