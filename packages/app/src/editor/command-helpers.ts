import type {
  EditorState,
  SelectionRange,
} from '@codemirror/state'

export function taskMarker(line: string): RegExpExecArray | null {
  return /^((?:[ \t]*>[ \t]?)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/.exec(
    line,
  )
}

export function selectedLineBounds(
  state: EditorState,
  range: SelectionRange,
): { startLine: number; endLine: number } {
  const startLine = state.doc.lineAt(range.from).number
  let endLine = state.doc.lineAt(range.to).number
  if (!range.empty && range.to === state.doc.line(endLine).from) endLine--
  return { startLine, endLine }
}

export function lineIndent(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? ''
}

export function linePrefixMatch(
  line: string,
  pattern: RegExp,
): RegExpExecArray | null {
  pattern.lastIndex = 0
  return pattern.exec(line.slice(lineIndent(line).length))
}

export function surroundingMarkers(
  state: EditorState,
  range: SelectionRange,
  open: string,
  close: string,
): { open: number; close: number } | null {
  if (open === '*' && close === '*') {
    const before = countRunBefore(state, range.from, '*')
    const after = countRunAfter(state, range.to, '*')
    return before % 2 === 1 && after % 2 === 1 ? { open: 1, close: 1 } : null
  }
  return state.sliceDoc(Math.max(0, range.from - open.length), range.from) ===
      open &&
    state.sliceDoc(
      range.to,
      Math.min(state.doc.length, range.to + close.length),
    ) === close
    ? { open: open.length, close: close.length }
    : null
}

export function containedMarkers(
  text: string,
  open: string,
  close: string,
): { open: number; close: number } | null {
  if (open === '*' && close === '*') {
    const before = countStringRun(text, 0, 1, '*')
    const after = countStringRun(text, text.length - 1, -1, '*')
    return before % 2 === 1 && after % 2 === 1 && text.length > 2
      ? { open: 1, close: 1 }
      : null
  }
  return text.startsWith(open) &&
    text.endsWith(close) &&
    text.length > open.length + close.length
    ? { open: open.length, close: close.length }
    : null
}

export function codeSpanMarkers(text: string): number {
  const before = countStringRun(text, 0, 1, '`')
  const after = countStringRun(text, text.length - 1, -1, '`')
  return before > 0 && before === after && text.length > before * 2 ? before : 0
}

export function countRunBefore(
  state: EditorState,
  position: number,
  character: string,
): number {
  let count = 0
  while (
    position - count - 1 >= 0 &&
    state.sliceDoc(position - count - 1, position - count) === character
  )
    count++
  return count
}

export function countRunAfter(
  state: EditorState,
  position: number,
  character: string,
): number {
  let count = 0
  while (
    position + count < state.doc.length &&
    state.sliceDoc(position + count, position + count + 1) === character
  )
    count++
  return count
}

function countStringRun(
  value: string,
  start: number,
  step: 1 | -1,
  character: string,
): number {
  let count = 0
  for (
    let index = start;
    index >= 0 && index < value.length && value[index] === character;
    index += step
  )
    count++
  return count
}

export function longestCharacterRun(value: string, character: string): number {
  let longest = 0
  let current = 0
  for (const valueCharacter of value) {
    current = valueCharacter === character ? current + 1 : 0
    longest = Math.max(longest, current)
  }
  return longest
}
