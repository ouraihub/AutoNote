import { parseDocument } from 'yaml'
import {
  isPlainRecord,
  parseFrontMatter,
  splitFrontMatter,
  stripCodeRegions,
} from './markdown-front-matter'
import { bodyTagOccurrences, frontMatterTags } from './markdown-tags'

const WIKI_RE = /\[\[([^[\]|\n]{1,400})(?:\|([^[\]\n]{0,200}))?\]\]/g

export interface WikiLink {
  target: string
  alias: string | null
  key: string
}

export function extractWikiLinks(content: string): WikiLink[] {
  const safe = stripCodeRegions(splitFrontMatter(content).body)
  const seen = new Set<string>()
  const out: WikiLink[] = []
  for (const m of safe.matchAll(WIKI_RE)) {
    const target = m[1]!.trim()
    if (!target) continue
    const noteTarget = wikiNoteTarget(target)
    if (!noteTarget) continue
    const key = normalizeLinkKey(noteTarget)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ target, alias: m[2]?.trim() || null, key })
    if (out.length >= 200) break
  }
  return out
}

const ATTACHMENT_REFERENCE_RE =
  /(?:^|[\s(<"'=])\/api\/files\/([0-9a-hjkmnp-tv-z]{26})(?=$|[\s>)\]"'?#])/g

export function extractAttachmentIds(content: string): string[] {
  const body = splitFrontMatter(content).body
  const ids = new Set<string>()
  for (const match of stripCodeRegions(body).matchAll(ATTACHMENT_REFERENCE_RE))
    ids.add(match[1]!)
  // md-example fences are rendered as live markdown by the client renderer,
  // so references inside them count even though stripCodeRegions discards
  // them as ordinary code regions.
  for (const inner of markdownExampleBodies(body)) {
    for (const id of extractAttachmentIds(inner)) ids.add(id)
  }
  return [...ids]
}

function markdownExampleBodies(text: string): string[] {
  const bodies: string[] = []
  const lines = text.split('\n')
  let fenceChar = ''
  let fenceLen = 0
  let collecting: string[] | null = null
  for (const line of lines) {
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      const marker = fence[1]!
      if (collecting === null) {
        if (/^\s*(?:md-example|markdown-example)\b/.test(fence[2] ?? '')) {
          fenceChar = marker[0]!
          fenceLen = marker.length
          collecting = []
        }
        continue
      }
      if (
        marker[0]! === fenceChar &&
        marker.length >= fenceLen &&
        !(fence[2] ?? '').trim()
      ) {
        bodies.push(collecting.join('\n'))
        collecting = null
        continue
      }
    }
    if (collecting !== null) collecting.push(line)
  }
  if (collecting) bodies.push(collecting.join('\n'))
  return bodies
}

export function normalizeLinkKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function wikiNoteTarget(target: string): string {
  const value = target.trim()
  if (!value || value.startsWith('#') || value.startsWith('^')) return ''
  const hash = value.indexOf('#')
  return (hash >= 0 ? value.slice(0, hash) : value).trim()
}

export function replaceTagInContent(
  content: string,
  from: string,
  to: string | null,
): string {
  const frontMatter = parseFrontMatter(content)
  const hasFrontMatter = frontMatter.lineOffset > 0
  const normalized = content.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const header = hasFrontMatter ? lines.slice(0, frontMatter.lineOffset) : []
  const body = hasFrontMatter
    ? lines.slice(frontMatter.lineOffset).join('\n')
    : normalized
  const rewrittenFrontMatter =
    hasFrontMatter && frontMatter.errors.length === 0
      ? replaceTagInFrontMatter(header, frontMatter.raw, from, to)
      : header
  const rewrittenBody = replaceInlineTag(body, from, to)
  return [...rewrittenFrontMatter, rewrittenBody].join('\n')
}

function replaceInlineTag(
  content: string,
  from: string,
  to: string | null,
): string {
  const matches = bodyTagOccurrences(content).filter(
    (occurrence) => occurrence.name === from,
  )
  let rewritten = content
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i]!
    if (to) {
      rewritten =
        rewritten.slice(0, match.nameStart) +
        to +
        rewritten.slice(match.nameEnd)
    } else {
      rewritten =
        rewritten.slice(0, match.hashStart) + rewritten.slice(match.nameEnd)
    }
  }
  return rewritten
}

function replaceTagInFrontMatter(
  header: string[],
  raw: string,
  from: string,
  to: string | null,
): string[] {
  const document = parseDocument(raw, { prettyErrors: false, uniqueKeys: true })
  if (document.errors.length) return header
  const data = document.toJS({ maxAliasCount: 20 }) as unknown
  if (!isPlainRecord(data)) return header
  const key = Object.prototype.hasOwnProperty.call(data, 'tags')
    ? 'tags'
    : Object.prototype.hasOwnProperty.call(data, 'tag')
      ? 'tag'
      : null
  if (!key) return header
  const value = data[key]
  const rewrite = (tag: string) => {
    const hash = tag.trim().startsWith('#') ? '#' : ''
    const name = tag.trim().replace(/^#/, '')
    if (name !== from) return tag
    return to ? `${hash}${to}` : null
  }
  let next: string[] | string | null = null
  if (Array.isArray(value)) {
    const values = value
      .filter((item): item is string => typeof item === 'string')
      .map(rewrite)
      .filter((item): item is string => item !== null)
    if (
      values.length === value.length &&
      values.every((item, index) => item === value[index])
    )
      return header
    next = values.length ? values : null
  } else if (typeof value === 'string') {
    const separator = value.includes(',') ? ', ' : ' '
    const values = frontMatterTags({ [key]: value })
      .map(rewrite)
      .filter((item): item is string => item !== null)
    const joined = values.join(separator)
    if (joined === value) return header
    next = joined || null
  } else {
    return header
  }
  if (next === null) document.delete(key)
  else document.set(key, next)
  const closing = header.at(-1) ?? '---'
  const serialized = document.toString().replace(/\n$/, '')
  return [
    header[0] ?? '---',
    ...(serialized ? serialized.split('\n') : []),
    closing,
  ]
}

function replaceWikiLinkTargetLine(
  content: string,
  from: string,
  to: string,
): string {
  const fromKey = normalizeLinkKey(from)
  return content.replace(
    /\[\[([^[\]|\n]{1,400})(\|[^[\]\n]{0,200})?\]\]/g,
    (whole, target: string, alias?: string) => {
      const note = wikiNoteTarget(target)
      if (normalizeLinkKey(note) !== fromKey) return whole
      const fragment = target.slice(note.length)
      return `[[${to}${fragment}${alias ?? ''}]]`
    },
  )
}

export function replaceWikiLinkTarget(
  content: string,
  from: string,
  to: string,
): string {
  const frontMatter = parseFrontMatter(content)
  const lines = content.split('\n')
  let inFence = false
  let fenceChar = ''
  let fenceLength = 0
  for (let index = frontMatter.lineOffset; index < lines.length; index++) {
    const line = lines[index]!
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const marker = fence[1]!
      if (!inFence) {
        inFence = true
        fenceChar = marker[0]!
        fenceLength = marker.length
      } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
        inFence = false
      }
      continue
    }
    if (inFence) continue
    const safe = line.replace(/`+[^`\n]*`+/g, (value) =>
      ' '.repeat(value.length),
    )
    if (safe === line) {
      lines[index] = replaceWikiLinkTargetLine(line, from, to)
      continue
    }
    const replacements: Array<{ start: number; end: number; value: string }> =
      []
    for (const match of safe.matchAll(WIKI_RE)) {
      const original = line.slice(match.index!, match.index! + match[0].length)
      const value = replaceWikiLinkTargetLine(original, from, to)
      if (value !== original)
        replacements.push({
          start: match.index!,
          end: match.index! + match[0].length,
          value,
        })
    }
    let next = line
    for (const replacement of replacements.reverse()) {
      next =
        next.slice(0, replacement.start) +
        replacement.value +
        next.slice(replacement.end)
    }
    lines[index] = next
  }
  return lines.join('\n')
}
