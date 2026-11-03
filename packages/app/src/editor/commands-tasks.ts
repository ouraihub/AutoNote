import type { EditorView } from '@codemirror/view'
import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type StateCommand,
} from '@codemirror/state'
import { selectedLineBounds, taskMarker } from './commands-helpers'

const LIST_RE = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/

export const completeCodeFenceOnEnter: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.head)
  if (range.head !== line.to || openFenceBeforeLine(state, line.number))
    return false
  const match = FENCE_RE.exec(line.text)
  if (!match) return false
  const fence = match[1]!
  const insert = `\n\n${fence}`
  dispatch(
    state.update({
      changes: { from: range.head, insert },
      selection: EditorSelection.cursor(range.head + 1),
      scrollIntoView: true,
      userEvent: 'input.complete',
    }),
  )
  return true
}

function openFenceBeforeLine(state: EditorState, lineNumber: number): boolean {
  let opening: { char: string; length: number } | null = null
  for (let number = 1; number < lineNumber; number++) {
    const match = FENCE_RE.exec(state.doc.line(number).text)
    if (!match) continue
    const marker = match[1]!
    if (!opening) {
      opening = { char: marker[0]!, length: marker.length }
      continue
    }
    if (
      marker[0] === opening.char &&
      marker.length >= opening.length &&
      /^[ \t]*$/.test(match[2]!)
    )
      opening = null
  }
  return opening !== null
}

export const smartEnter: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.head)
  const match = LIST_RE.exec(line.text)
  if (!match) return false
  const [, indent, marker, space, task, content] = match
  const markerEnd =
    line.from +
    (indent?.length ?? 0) +
    (marker?.length ?? 0) +
    (space?.length ?? 0) +
    (task?.length ?? 0)
  if (range.head < markerEnd) return false
  if (!content?.trim()) {
    dispatch(
      state.update({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: EditorSelection.cursor(line.from),
        userEvent: 'input',
      }),
    )
    return true
  }
  const nextMarker = /^\d+[.)]$/.test(marker ?? '')
    ? `${parseInt(marker!, 10) + 1}${marker!.slice(-1)}`
    : marker
  const nextTask = task ? '[ ] ' : ''
  const insert = `\n${indent}${nextMarker}${space}${nextTask}`
  dispatch(
    state.update({
      changes: { from: range.head, insert },
      selection: EditorSelection.cursor(range.head + insert.length),
      scrollIntoView: true,
      userEvent: 'input',
    }),
  )
  return true
}
export const tableTab: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main
  const line = state.doc.lineAt(range.head)
  if (!/^\s*\|/.test(line.text)) return false
  const rest = line.text.slice(range.head - line.from)
  const next = rest.indexOf('|')
  if (next < 0) return false
  const target = range.head + next + 1
  const after = /^\s*/.exec(
    state.doc.sliceString(target, Math.min(target + 4, state.doc.length)),
  )
  dispatch(
    state.update({
      selection: EditorSelection.cursor(target + (after?.[0].length ?? 0)),
      scrollIntoView: true,
    }),
  )
  return true
}
export const toggleTaskDone: StateCommand = ({ state, dispatch }) => {
  const changes: ChangeSpec[] = []
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
