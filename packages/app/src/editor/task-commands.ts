import type { EditorView } from '@codemirror/view'
import type { StateCommand } from '@codemirror/state'
import {
  selectedLineBounds,
  taskMarker,
} from './command-helpers.ts'

export const toggleTaskDone: StateCommand = ({ state, dispatch }) => {
  const changes: { from: number; to: number; insert: string }[] = []
  const seen = new Set<number>()
  for (const range of state.selection.ranges) {
    const { startLine, endLine } = selectedLineBounds(state, range)
    for (let n = startLine; n <= endLine; n++) {
      if (seen.has(n)) continue
      seen.add(n)
      const line = state.doc.line(n)
      const match = taskMarker(line.text)
      if (!match) continue
      const from = line.from + match[1]!.length
      changes.push({ from, to: from + 1, insert: match[2] === ' ' ? 'x' : ' ' })
    }
  }
  if (!changes.length) return false
  dispatch(state.update({ changes, userEvent: 'input.format' }))
  return true
}

export function setTaskAtLine(
  view: EditorView,
  lineNumber: number,
  checked: boolean,
): boolean {
  const doc = view.state.doc
  if (lineNumber < 1 || lineNumber > doc.lines) return false
  const line = doc.line(lineNumber)
  const match = taskMarker(line.text)
  if (!match) return false
  const from = line.from + match[1]!.length
  view.dispatch({
    changes: { from, to: from + 1, insert: checked ? 'x' : ' ' },
    userEvent: 'input.format',
  })
  return true
}

export function updateTaskAtSourceLine(
  source: string,
  lineIndex: number,
  checked: boolean,
): string | null {
  if (!Number.isInteger(lineIndex) || lineIndex < 0) return null
  let from = 0
  for (let index = 0; index < lineIndex; index++) {
    const newline = source.indexOf('\n', from)
    if (newline < 0) return null
    from = newline + 1
  }
  const newline = source.indexOf('\n', from)
  let to = newline < 0 ? source.length : newline
  if (to > from && source[to - 1] === '\r') to--
  const match = taskMarker(source.slice(from, to))
  if (!match) return null
  const marker = from + match[1]!.length
  const value = checked ? 'x' : ' '
  if (source[marker]?.toLowerCase() === value) return source
  return `${source.slice(0, marker)}${value}${source.slice(marker + 1)}`
}
