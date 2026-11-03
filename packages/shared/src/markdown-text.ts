import { splitFrontMatter, stripCodeRegions } from './markdown-front-matter'
import { truncateText } from './text-utils'

export function deriveTitle(
  content: string,
  fallback = 'Untitled note',
): string {
  const { body, meta } = splitFrontMatter(content)
  if (meta.title) return trimTitle(meta.title)
  const safe = stripCodeRegions(body)
  const lines = safe.split('\n')
  for (const line of lines) {
    const h = /^[ \t]{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) {
      const t = inlinePlain(h[2]!)
      if (t) return trimTitle(t)
    }
  }
  for (const line of lines) {
    const t = inlinePlain(
      line.replace(/^[ \t>*+\-]+/, '').replace(/^\d+[.)]\s*/, ''),
    )
    if (t) return trimTitle(t)
  }
  return fallback
}

function trimTitle(t: string): string {
  const clean = t.replace(/\s+/g, ' ').trim()
  return clean.length > 200 ? truncateText(clean, 200) + '…' : clean
}

export function deriveExcerpt(content: string, max = 220): string {
  const plain = toPlainText(content)
  const title = deriveTitle(content, '')
  let text = plain
  if (title && text.startsWith(title)) text = text.slice(title.length)
  text = text
    .replace(/^[\s\n]+/, '')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
  if (text.length <= max) return text
  return truncateText(text, max).replace(/\s+\S*$/, '') + '…'
}

function inlinePlain(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(
      /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g,
      (_s, a: string, b?: string) => b || a,
    )
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/==(.*?)==/g, '$1')
    .replace(/<[^>]{1,200}>/g, '')
    .replace(/`+/g, '')
    .trim()
}

export function toPlainText(md: string): string {
  let t = stripCodeRegions(splitFrontMatter(md).body)
  t = t.replace(/^ {0,3}(?:[-*_][ \t]*){3,}$/gm, '')
  t = t.replace(/^[ \t]{0,3}#{1,6}\s+/gm, '')
  t = t.replace(/^[ \t]{0,3}>[ \t]?/gm, '')
  t = t.replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/gm, '')
  t = t.replace(/^[ \t]*[-*+][ \t]+/gm, '')
  t = t.replace(/^[ \t]*\d+[.)][ \t]+/gm, '')
  t = t.replace(/^[ \t]*\|.*\|[ \t]*$/gm, (row) =>
    /^[ \t]*\|[\s:|-]+\|[ \t]*$/.test(row) ? '' : row.replace(/\|/g, ' '),
  )
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  t = t.replace(
    /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g,
    (_s, a: string, b?: string) => b || a,
  )
  t = t.replace(/\$\$([\s\S]*?)\$\$/g, ' $1 ')
  t = t.replace(/\$([^$\n]+)\$/g, ' $1 ')
  t = t.replace(/(\*\*|__)(.*?)\1/g, '$2')
  t = t.replace(/(\*|_)(.*?)\1/g, '$2')
  t = t.replace(/~~(.*?)~~/g, '$1')
  t = t.replace(/==(.*?)==/g, '$1')
  t = t.replace(/<[^>]{1,300}>/g, '')
  t = t.replace(/^\[\^[^\]]+\]:/gm, '')
  t = t.replace(/\[\^[^\]]+\]/g, '')
  return t
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const CJK_CHAR = /[\u2e80-\u9fff\uf900-\ufaff]/
const CJK_GLOBAL = /[\u2e80-\u9fff\uf900-\ufaff\uff01-\uffe0]/g

export function countText(md: string): { words: number; chars: number } {
  const plain = toPlainText(md)
  let cjk = 0
  for (const ch of plain) if (CJK_CHAR.test(ch)) cjk++
  const latin = plain.match(/[A-Za-z0-9_'’-]+/g)?.length ?? 0
  return { words: cjk + latin, chars: [...md].length }
}

export function segmentCJK(text: string): string {
  return text.replace(CJK_GLOBAL, (c) => ` ${c} `).replace(/\s{2,}/g, ' ')
}

export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 300))
}

export function slugifyHeading(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '-')
      .replace(
        new RegExp('[!-/:-@[-`{-~！-～，。、；：？（）【】「」『』]', 'g'),
        '',
      )
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  )
}
