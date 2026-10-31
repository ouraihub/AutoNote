import { hasExpectedImageSignature } from './image-signatures'

export function readImageSize(
  bytes: Uint8Array,
  mime: string,
): { width: number; height: number } | null {
  try {
    if (!hasExpectedImageSignature(bytes, mime)) return null
    if (mime === 'image/png') return pngSize(bytes)
    if (mime === 'image/jpeg') return jpegSize(bytes)
    if (mime === 'image/gif') return gifSize(bytes)
    if (mime === 'image/webp') return webpSize(bytes)
  } catch {}
  return null
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function pngSize(b: Uint8Array) {
  if (b.length < 24 || new TextDecoder().decode(b.subarray(12, 16)) !== 'IHDR')
    return null
  const dv = view(b)
  return { width: dv.getUint32(16), height: dv.getUint32(20) }
}

function gifSize(b: Uint8Array) {
  if (b.length < 10) return null
  const dv = view(b)
  return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) }
}

function jpegSize(b: Uint8Array) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  const dv = view(b)
  let offset = 2
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = b[offset + 1]!
    if (
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
      return {
        height: dv.getUint16(offset + 5),
        width: dv.getUint16(offset + 7),
      }
    }
    offset += 2 + dv.getUint16(offset + 2)
  }
  return null
}

function webpSize(b: Uint8Array) {
  if (b.length < 30) return null
  const dv = view(b)
  const format = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
  if (format === 'VP8 ') {
    return {
      width: dv.getUint16(26, true) & 0x3fff,
      height: dv.getUint16(28, true) & 0x3fff,
    }
  }
  if (format === 'VP8L') {
    const bits = dv.getUint32(21, true)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (format === 'VP8X') {
    const w = (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1
    const h = (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1
    return { width: w, height: h }
  }
  return null
}
