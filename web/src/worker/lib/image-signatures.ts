function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

export function hasExpectedImageSignature(
  bytes: Uint8Array,
  mime: string,
): boolean {
  if (mime === 'image/png') {
    return (
      bytes.length >= 24 &&
      bytes[0] === 0x89 &&
      ascii(bytes, 1, 4) === 'PNG' &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    )
  }
  if (mime === 'image/jpeg') {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    )
  }
  if (mime === 'image/gif') {
    const header = ascii(bytes, 0, 6)
    return header === 'GIF87a' || header === 'GIF89a'
  }
  if (mime === 'image/webp') {
    return (
      bytes.length >= 16 &&
      ascii(bytes, 0, 4) === 'RIFF' &&
      ascii(bytes, 8, 12) === 'WEBP'
    )
  }
  if (mime === 'image/avif') {
    if (bytes.length < 16 || ascii(bytes, 4, 8) !== 'ftyp') return false
    const boxSize = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getUint32(0)
    if (boxSize < 16 || boxSize > bytes.length) return false
    for (let offset = 8; offset + 4 <= Math.min(boxSize, 64); offset += 4) {
      const brand = ascii(bytes, offset, offset + 4)
      if (brand === 'avif' || brand === 'avis') return true
    }
  }
  return false
}
