import { crc32, normalizeZipPath } from './zip-common'

export interface UnzippedEntry {
  path: string
  data: Uint8Array
}

export interface ReadZipOptions {
  maxEntries?: number
  maxEntryBytes?: number
  maxTotalBytes?: number
  include?: (path: string) => boolean
}

interface CentralEntry {
  path: string
  flags: number
  method: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

export async function readZip(
  buffer: Uint8Array,
  options: ReadZipOptions = {},
): Promise<UnzippedEntry[]> {
  const maxEntries = positiveLimit(options.maxEntries, 2500)
  const maxEntryBytes = positiveLimit(options.maxEntryBytes, 96 * 1024 * 1024)
  const maxTotalBytes = positiveLimit(options.maxTotalBytes, 96 * 1024 * 1024)
  if (buffer.byteLength < 22) throw new Error('This is not a valid ZIP file')

  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

  let eocd = -1
  const searchStart = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= searchStart; i--) {
    if (
      dv.getUint32(i, true) === 0x06054b50 &&
      i + 22 + dv.getUint16(i + 20, true) === buffer.length
    ) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('This is not a valid ZIP file')

  requireRange(buffer, eocd, 22, 'The ZIP end record is incomplete')
  const commentLength = dv.getUint16(eocd + 20, true)
  requireRange(
    buffer,
    eocd + 22,
    commentLength,
    'The ZIP comment is incomplete',
  )
  if (
    dv.getUint16(eocd + 4, true) !== 0 ||
    dv.getUint16(eocd + 6, true) !== 0
  ) {
    throw new Error('Split ZIP archives are not supported')
  }
  const diskCount = dv.getUint16(eocd + 8, true)
  const count = dv.getUint16(eocd + 10, true)
  const centralSize = dv.getUint32(eocd + 12, true)
  const centralOffset = dv.getUint32(eocd + 16, true)
  if (
    count === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error('ZIP64 archives are not supported')
  }
  if (diskCount !== count) throw new Error('ZIP entry counts do not match')
  if (count > maxEntries)
    throw new Error(`ZIP entries exceed the limit of ${maxEntries}`)
  requireRange(
    buffer,
    centralOffset,
    centralSize,
    'The ZIP central directory is out of bounds',
  )
  if (centralOffset + centralSize > eocd)
    throw new Error('The ZIP central directory location is invalid')

  let pointer = centralOffset
  const entries: CentralEntry[] = []
  const seenPaths = new Set<string>()
  for (let i = 0; i < count; i++) {
    requireRange(buffer, pointer, 46, 'The ZIP central directory is incomplete')
    if (dv.getUint32(pointer, true) !== 0x02014b50) {
      throw new Error('The ZIP central directory is corrupt')
    }
    const disk = dv.getUint16(pointer + 34, true)
    if (disk !== 0) throw new Error('Split ZIP archives are not supported')
    const flags = dv.getUint16(pointer + 8, true)
    if (flags & 0x0001)
      throw new Error('Encrypted ZIP archives are not supported')
    const method = dv.getUint16(pointer + 10, true)
    const crc = dv.getUint32(pointer + 16, true)
    const compressedSize = dv.getUint32(pointer + 20, true)
    const uncompressedSize = dv.getUint32(pointer + 24, true)
    const nameLen = dv.getUint16(pointer + 28, true)
    const extraLen = dv.getUint16(pointer + 30, true)
    const commentLen = dv.getUint16(pointer + 32, true)
    const localOffset = dv.getUint32(pointer + 42, true)
    const recordSize = 46 + nameLen + extraLen + commentLen
    requireRange(
      buffer,
      pointer,
      recordSize,
      'A ZIP central directory entry is out of bounds',
    )

    let decodedPath: string
    try {
      decodedPath = decoder.decode(
        buffer.subarray(pointer + 46, pointer + 46 + nameLen),
      )
    } catch {
      throw new Error('A ZIP filename is not valid UTF-8')
    }
    const path = normalizeZipPath(decodedPath)
    pointer += recordSize

    if (!path || path.endsWith('/')) continue
    const pathKey = path.toLowerCase()
    if (seenPaths.has(pathKey))
      throw new Error(`The ZIP contains a duplicate path: ${path}`)
    seenPaths.add(pathKey)
    entries.push({
      path,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
    })
  }
  if (pointer !== centralOffset + centralSize)
    throw new Error('The ZIP central directory length does not match')

  const selected = options.include
    ? entries.filter((entry) => options.include!(entry.path))
    : entries
  const declaredTotal = selected.reduce(
    (sum, entry) => sum + entry.uncompressedSize,
    0,
  )
  if (!Number.isSafeInteger(declaredTotal) || declaredTotal > maxTotalBytes) {
    throw new Error(
      `Expanded ZIP data exceeds the ${formatBytes(maxTotalBytes)} limit`,
    )
  }

  const out: UnzippedEntry[] = []
  let totalBytes = 0
  for (const entry of selected) {
    if (entry.method !== 0 && entry.method !== 8) {
      throw new Error(
        `ZIP entry uses an unsupported compression method: ${entry.path}`,
      )
    }
    if (entry.uncompressedSize > maxEntryBytes) {
      throw new Error(`ZIP entry is too large: ${entry.path}`)
    }

    requireRange(
      buffer,
      entry.localOffset,
      30,
      `ZIP local entry is corrupt: ${entry.path}`,
    )
    if (dv.getUint32(entry.localOffset, true) !== 0x04034b50) {
      throw new Error(`ZIP local entry signature is invalid: ${entry.path}`)
    }
    const localFlags = dv.getUint16(entry.localOffset + 6, true)
    const localMethod = dv.getUint16(entry.localOffset + 8, true)
    if (localFlags & 0x0001 || localMethod !== entry.method) {
      throw new Error(
        `ZIP local entry does not match the central directory: ${entry.path}`,
      )
    }
    const localNameLen = dv.getUint16(entry.localOffset + 26, true)
    const localExtraLen = dv.getUint16(entry.localOffset + 28, true)
    requireRange(
      buffer,
      entry.localOffset + 30,
      localNameLen,
      `ZIP local filename is corrupt: ${entry.path}`,
    )
    let localPath: string
    try {
      localPath = normalizeZipPath(
        decoder.decode(
          buffer.subarray(
            entry.localOffset + 30,
            entry.localOffset + 30 + localNameLen,
          ),
        ),
      )
    } catch {
      throw new Error(`ZIP local filename is invalid: ${entry.path}`)
    }
    if (localPath !== entry.path) {
      throw new Error(
        `ZIP local filename does not match \
the central directory: ${entry.path}`,
      )
    }
    const dataStart = entry.localOffset + 30 + localNameLen + localExtraLen
    requireRange(
      buffer,
      dataStart,
      entry.compressedSize,
      `ZIP data is out of bounds: ${entry.path}`,
    )
    const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize)

    let data: Uint8Array
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) {
        throw new Error(`ZIP entry length does not match: ${entry.path}`)
      }
      data = raw
    } else {
      data = await inflateRaw(
        raw,
        Math.min(maxEntryBytes, maxTotalBytes - totalBytes),
      )
    }
    if (data.byteLength !== entry.uncompressedSize) {
      throw new Error(`Expanded ZIP entry length does not match: ${entry.path}`)
    }
    totalBytes += data.byteLength
    if (totalBytes > maxTotalBytes) {
      throw new Error(
        `Expanded ZIP data exceeds the ${formatBytes(maxTotalBytes)} limit`,
      )
    }
    if (crc32(data) !== entry.crc)
      throw new Error(`ZIP entry checksum failed: ${entry.path}`)
    out.push({ path: entry.path, data })
  }

  return out
}

async function inflateRaw(
  data: Uint8Array,
  maxBytes: number,
): Promise<Uint8Array> {
  if (maxBytes < 0) throw new Error('Expanded ZIP data exceeds the limit')
  const source = new Response(data as unknown as BodyInit).body
  if (!source)
    throw new Error('ZIP decompression is unavailable in this environment')

  const reader = source
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) {
        await reader.cancel()
        throw new Error(
          `Expanded ZIP entry exceeds the ${formatBytes(maxBytes)} limit`,
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function requireRange(
  buffer: Uint8Array,
  offset: number,
  length: number,
  message: string,
): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > buffer.byteLength - length
  ) {
    throw new Error(message)
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.ceil(bytes / (1024 * 1024))} MB`
    : `${Math.ceil(bytes / 1024)} KB`
}
