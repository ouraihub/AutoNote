import { parseDocument } from 'yaml'
export interface FrontMatterResult {
  body: string
  data: Record<string, unknown>
  raw: string

  lineOffset: number
  errors: string[]
}

const FRONT_MATTER_LIMIT = 64 * 1024
const UTF8_ENCODER = new TextEncoder()

export function parseFrontMatter(text: string): FrontMatterResult {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text
  if (!/^---[ \t]*(?:\r?\n|$)/.test(source)) {
    return { body: source, data: {}, raw: '', lineOffset: 0, errors: [] }
  }

  const lines = source.split(/\r?\n/)
  const separators = source.match(/\r?\n/g) ?? []
  let closing = -1
  let bytes = UTF8_ENCODER.encode(lines[0]!).byteLength
  for (let index = 1; index < lines.length; index++) {
    bytes += UTF8_ENCODER.encode(separators[index - 1] ?? '').byteLength
    bytes += UTF8_ENCODER.encode(lines[index]!).byteLength
    if (bytes > FRONT_MATTER_LIMIT) {
      return {
        body: source,
        data: {},
        raw: '',
        lineOffset: 0,
        errors: ['Front Matter exceeds the 64 KiB safety limit'],
      }
    }
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[index]!)) {
      closing = index
      break
    }
  }
  if (closing < 0)
    return { body: source, data: {}, raw: '', lineOffset: 0, errors: [] }

  const raw = lines.slice(1, closing).join('\n')
  try {
    const document = parseDocument(raw, {
      prettyErrors: false,
      uniqueKeys: true,
    })
    const errors = document.errors.map((error) => error.message)
    if (errors.length) {
      return {
        body: lines.slice(closing + 1).join('\n'),
        data: {},
        raw,
        lineOffset: closing + 1,
        errors,
      }
    }
    const value = document.toJS({ maxAliasCount: 20 }) as unknown
    const data = isPlainRecord(value) ? value : {}
    if (value != null && !isPlainRecord(value)) {
      errors.push('Front Matter root must be a YAML mapping')
    }
    return {
      body: lines.slice(closing + 1).join('\n'),
      data,
      raw,
      lineOffset: closing + 1,
      errors,
    }
  } catch (error) {
    return {
      body: lines.slice(closing + 1).join('\n'),
      data: {},
      raw,
      lineOffset: closing + 1,
      errors: [error instanceof Error ? error.message : String(error)],
    }
  }
}

export function splitFrontMatter(text: string): {
  body: string
  meta: Record<string, string>
} {
  const parsed = parseFrontMatter(text)
  const meta: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value == null) continue
    if (typeof value === 'string') meta[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean')
      meta[key] = String(value)
    else meta[key] = JSON.stringify(value)
  }
  return { body: parsed.body, meta }
}

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
