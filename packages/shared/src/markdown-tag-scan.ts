// Lexical tag scanning excludes code, links and hidden Markdown regions.
const TAG_RE = new RegExp(
  String.raw`(^|[\s(\uff08[\u3010>\u300c\u300e\uff0c,\u3001;\uff1b])#` +
    String.raw`([\p{L}\p{N}_\-/·]{1,60})(?![\p{L}\p{N}_\-/·])`,
  'gu',
)
interface BodyTagOccurrence {
  name: string
  hashStart: number
  nameStart: number
  nameEnd: number
}

export function isEscaped(text: string, index: number): boolean {
  let slashes = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++
  return slashes % 2 === 1
}

function tagSearchText(text: string): string {
  const protectedChars = new Uint8Array(text.length)
  const protect = (start: number, end: number) => {
    const boundedStart = Math.max(0, start)
    const boundedEnd = Math.min(text.length, end)
    for (let i = boundedStart; i < boundedEnd; i++) protectedChars[i] = 1
  }

  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  let lineStart = 0
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? text.length : newline + 1
    const line = text
      .slice(lineStart, newline < 0 ? text.length : newline)
      .replace(/\r$/, '')
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const marker = fence[1]!
      if (!inFence) {
        inFence = true
        fenceChar = marker[0]!
        fenceLen = marker.length
      } else if (marker[0] === fenceChar && marker.length >= fenceLen) {
        inFence = false
      }
      protect(lineStart, lineEnd)
    } else if (inFence) {
      protect(lineStart, lineEnd)
    }
    lineStart = lineEnd
  }

  for (let i = 0; i < text.length;) {
    if (protectedChars[i] || text[i] !== '`' || isEscaped(text, i)) {
      i++
      continue
    }
    let markerEnd = i + 1
    while (text[markerEnd] === '`') markerEnd++
    const markerLength = markerEnd - i
    let closing = markerEnd
    let matched = false
    while (closing < text.length) {
      closing = text.indexOf('`', closing)
      if (closing < 0) break
      let closingEnd = closing + 1
      while (text[closingEnd] === '`') closingEnd++
      if (closingEnd - closing === markerLength) {
        protect(i, closingEnd)
        i = closingEnd
        matched = true
        break
      }
      closing = closingEnd
    }
    if (!matched) i = markerEnd
  }

  const protectPattern = (pattern: RegExp) => {
    for (const match of text.matchAll(pattern)) {
      const start = match.index
      if (start === undefined) continue
      let overlaps = false
      for (let i = start; i < start + match[0].length; i++) {
        if (protectedChars[i]) {
          overlaps = true
          break
        }
      }
      if (!overlaps) protect(start, start + match[0].length)
    }
  }

  protectPattern(/<!--(?:[\s\S]*?-->|[\s\S]*$)/g)
  protectPattern(/\$\$(?:[\s\S]*?\$\$|[\s\S]*$)/g)
  protectPattern(/\$(?!\s)(?:[^$\\]|\\.)+?(?<!\s)\$/g)

  let commentStart = -1
  for (let index = 0; index < text.length - 1; index++) {
    if (
      protectedChars[index] ||
      !text.startsWith('%%', index) ||
      isEscaped(text, index)
    )
      continue
    if (commentStart < 0) commentStart = index
    else {
      protect(commentStart, index + 2)
      commentStart = -1
    }
    index++
  }
  if (commentStart >= 0) protect(commentStart, text.length)

  lineStart = 0
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? text.length : newline + 1
    const line = text.slice(lineStart, newline < 0 ? text.length : newline)
    if (/^[ \t]{0,3}\[(?!\^)[^\]\n]+\]:/.test(line)) protect(lineStart, lineEnd)
    lineStart = lineEnd
  }

  const bracketStack: Array<{ start: number; image: boolean }> = []
  for (let i = 0; i < text.length; i++) {
    if (protectedChars[i] || isEscaped(text, i)) continue

    if (text.startsWith('[[', i)) {
      const closing = text.indexOf(']]', i + 2)
      if (closing >= 0) {
        const pipe = text.indexOf('|', i + 2)
        const targetEnd = pipe >= 0 && pipe < closing ? pipe : closing
        protect(i, pipe >= 0 && pipe < closing ? targetEnd + 1 : targetEnd)
        protect(closing, closing + 2)
        i = targetEnd - 1
        continue
      }
    }

    if (text[i] === '<' && /[A-Za-z/!?]/.test(text[i + 1] ?? '')) {
      let end = i + 1
      let quote = ''
      while (end < text.length) {
        const ch = text[end]!
        if (quote) {
          if (ch === quote && !isEscaped(text, end)) quote = ''
        } else if (ch === '"' || ch === "'") {
          quote = ch
        } else if (ch === '>') {
          end++
          break
        }
        end++
      }
      if (end <= text.length && end > i + 1 && text[end - 1] === '>') {
        protect(i, end)
        i = end - 1
        continue
      }
    }

    if (text[i] === '[') {
      bracketStack.push({
        start: i,
        image: i > 0 && text[i - 1] === '!' && !isEscaped(text, i - 1),
      })
      continue
    }
    if (text[i] !== ']' || bracketStack.length === 0) continue

    const opening = bracketStack.pop()!
    const destinationStart = i + 1
    if (text[destinationStart] === '(') {
      let depth = 1
      let quote = ''
      let end = destinationStart + 1
      for (; end < text.length; end++) {
        if (protectedChars[end] || isEscaped(text, end)) continue
        const ch = text[end]!
        if (quote) {
          if (ch === quote) quote = ''
          continue
        }
        if (ch === '"' || ch === "'") {
          quote = ch
          continue
        }
        if (ch === '(') depth++
        else if (ch === ')' && --depth === 0) {
          end++
          break
        }
      }
      if (depth === 0) {
        protect(destinationStart, end)
        if (opening.image) protect(opening.start - 1, end)
        i = end - 1
      } else if (opening.image) {
        protect(opening.start - 1, i + 1)
      }
    } else if (opening.image) {
      protect(opening.start - 1, i + 1)
    }
  }

  protectPattern(
    /(?:https?|ftp):\/\/[^\s<>]+|mailto:[^\s<>]+|\bwww\.[^\s<>]+/giu,
  )

  const chars = text.split('')
  for (let i = 0; i < chars.length; i++) {
    if (protectedChars[i] && chars[i] !== '\n' && chars[i] !== '\r')
      chars[i] = ' '
  }
  return chars.join('')
}

export function bodyTagOccurrences(content: string): BodyTagOccurrence[] {
  const safe = tagSearchText(content)
  const occurrences: BodyTagOccurrence[] = []
  for (const match of safe.matchAll(TAG_RE)) {
    const raw = match[2]!
    const name = raw.replace(
      /[.,\uff0c\u3002;\uff1b:\uff1a!\uff01?\uff1f\u3001·/]+$/u,
      '',
    )
    if (!name || /^\d+$/.test(name) || name.length > 60) continue
    const hashStart = match.index! + match[1]!.length
    const nameStart = hashStart + 1
    occurrences.push({
      name,
      hashStart,
      nameStart,
      nameEnd: nameStart + name.length,
    })
  }
  return occurrences
}
