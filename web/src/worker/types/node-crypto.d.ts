
declare module 'node:crypto' {
  interface AutoNoteScryptOptions {
    N: number
    r: number
    p: number
    maxmem: number
  }

  export function scrypt(
    password: string,
    salt: Uint8Array,
    keyLength: number,
    options: AutoNoteScryptOptions,
    callback: (error: Error | null, derivedKey: Uint8Array) => void,
  ): void
}
