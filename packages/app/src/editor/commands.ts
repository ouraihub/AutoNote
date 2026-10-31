import {
  EditorSelection,
  Facet,
  type ChangeSpec,
  type EditorState,
  type StateCommand,
} from '@codemirror/state'
import type { MessageKey } from '@shared/locales/en-US'
import {
  codeSpanMarkers,
  containedMarkers,
  countRunAfter,
  countRunBefore,
  lineIndent,
  linePrefixMatch,
  longestCharacterRun,
  selectedLineBounds,
  surroundingMarkers,
} from './command-helpers.ts'
export {
  setTaskAtLine,
  toggleTaskDone,
  updateTaskAtSourceLine,
} from './task-commands.ts'
export const commandLabels = Facet.define<
  (key: MessageKey) => string,
  (key: MessageKey) => string
>({
  combine: (values) =>
    values[0] ??
    (() => {
      throw new Error('Editor command labels were not provided')
    }),
})

export function toggleWrap(open: string, close = open): StateCommand {
  return ({ state, dispatch }) => {
    const changes = state.changeByRange((range) => {
      const surrounding = surroundingMarkers(state, range, open, close)

      if (surrounding) {
        return {
          changes: [
            { from: range.from - surrounding.open, to: range.from },
            { from: range.to, to: range.to + surrounding.close },
          ],
          range: EditorSelection.range(
            range.from - surrounding.open,
            range.to - surrounding.open,
          ),
        }
      }

      let { from, to } = range
      if (from === to) {
        const line = state.doc.lineAt(from)
        const offset = from - line.from
        const wordStart = /[\p{L}\p{N}_]+$/u.exec(line.text.slice(0, offset))
        const wordEnd = /^[\p{L}\p{N}_]+/u.exec(line.text.slice(offset))
        if (wordStart || wordEnd) {
          from = line.from + offset - (wordStart?.[0].length ?? 0)
          to = line.from + offset + (wordEnd?.[0].length ?? 0)
        }
      }
      const text = state.sliceDoc(from, to)

      const contained = containedMarkers(text, open, close)
      if (contained) {
        return {
          changes: {
            from,
            to,
            insert: text.slice(contained.open, text.length - contained.close),
          },
          range: EditorSelection.range(
            from,
            to - contained.open - contained.close,
          ),
        }
      }
      return {
        changes: { from, to, insert: `${open}${text}${close}` },
        range: text
          ? EditorSelection.range(from + open.length, to + open.length)
          : EditorSelection.cursor(from + open.length),
      }
    })
    dispatch(
      state.update(changes, {
        scrollIntoView: true,
        userEvent: 'input.format',
      }),
    )
    return true
  }
}
export function toggleLinePrefix(
  prefix: string | ((index: number) => string),
  pattern: RegExp,
  replacementPattern?: RegExp,
): StateCommand {
  return ({ state, dispatch }) => {
    const changes: ChangeSpec[] = []
    const seen = new Set<number>()
    let index = 0
    for (const range of state.selection.ranges) {
      const { startLine, endLine } = selectedLineBounds(state, range)
      let allPrefixed = true
      for (let n = startLine; n <= endLine; n++) {
        if (!linePrefixMatch(state.doc.line(n).text, pattern)) {
          allPrefixed = false
          break
        }
      }
      for (let n = startLine; n <= endLine; n++) {
        if (seen.has(n)) continue
        seen.add(n)
        const line = state.doc.line(n)
        const indent = lineIndent(line.text)
        const match = linePrefixMatch(line.text, pattern)
        const replacement = replacementPattern
          ? linePrefixMatch(line.text, replacementPattern)
          : null
        if (allPrefixed && match) {
          changes.push({
            from: line.from + indent.length,
            to: line.from + indent.length + match[0].length,
          })
        } else if (!match) {
          const value = typeof prefix === 'function' ? prefix(index) : prefix
          changes.push({
            from: line.from + indent.length,
            to: replacement
              ? line.from + indent.length + replacement[0].length
              : line.from + indent.length,
            insert: value,
          })
        }
        index++
      }
    }
    if (!changes.length) return false
    const changeSet = state.changes(changes)
    dispatch(
      state.update({
        changes: changeSet,
        selection: state.selection.map(changeSet, 1),
        scrollIntoView: true,
        userEvent: 'input.format',
      }),
    )
    return true
  }
}
export const toggleBold = toggleWrap('**')
export const toggleItalic = toggleWrap('*')
export const toggleInlineCode: StateCommand = ({ state, dispatch }) => {
  const changes = state.changeByRange((range) => {
    let { from, to } = range
    if (from === to) {
      const line = state.doc.lineAt(from)
      const offset = from - line.from
      const wordStart = /[\p{L}\p{N}_]+$/u.exec(line.text.slice(0, offset))
      const wordEnd = /^[\p{L}\p{N}_]+/u.exec(line.text.slice(offset))
      if (wordStart || wordEnd) {
        from -= wordStart?.[0].length ?? 0
        to += wordEnd?.[0].length ?? 0
      }
    }
    const selected = state.sliceDoc(from, to)
    const contained = codeSpanMarkers(selected)
    if (contained) {
      let content = selected.slice(contained, selected.length - contained)
      if (
        content.startsWith(' ') &&
        content.endsWith(' ') &&
        /\S/.test(content)
      )
        content = content.slice(1, -1)
      return {
        changes: { from, to, insert: content },
        range: EditorSelection.range(from, from + content.length),
      }
    }
    const before = countRunBefore(state, from, '`')
    const after = countRunAfter(state, to, '`')
    if (before > 0 && before === after) {
      return {
        changes: [
          { from: from - before, to: from },
          { from: to, to: to + after },
        ],
        range: EditorSelection.range(from - before, to - before),
      }
    }
    const fence = '`'.repeat(
      Math.max(1, longestCharacterRun(selected, '`') + 1),
    )
    const pad = selected && /^(?:\s|`)|(?:\s|`)$/.test(selected) ? ' ' : ''
    const insert = `${fence}${pad}${selected}${pad}${fence}`
    const selectionFrom = from + fence.length + pad.length
    return {
      changes: { from, to, insert },
      range: selected
        ? EditorSelection.range(selectionFrom, selectionFrom + selected.length)
        : EditorSelection.cursor(from + fence.length),
    }
  })
  dispatch(
    state.update(changes, { scrollIntoView: true, userEvent: 'input.format' }),
  )
  return true
}
export const toggleStrikethrough = toggleWrap('~~')
export const toggleHighlight = toggleWrap('==')
export const toggleInlineMath = toggleWrap('$')
export const toggleWikiLink = toggleWrap('[[', ']]')
export const toggleNoteEmbed = toggleWrap('![[', ']]')
export const toggleBlockReference = toggleWrap('[[#^', ']]')
export const toggleQuote = toggleLinePrefix('> ', /^>\s?/)
const ANY_LIST_PREFIX = /^(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/
export const toggleBulletList = toggleLinePrefix(
  '- ',
  /^[-*+][ \t]+(?!\[[ xX]\][ \t]+)/,
  ANY_LIST_PREFIX,
)
export const toggleTaskList = toggleLinePrefix(
  '- [ ] ',
  /^(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\][ \t]+/,
  ANY_LIST_PREFIX,
)
export const toggleOrderedList = toggleLinePrefix(
  (i) => `${i + 1}. `,
  /^\d+[.)][ \t]+(?!\[[ xX]\][ \t]+)/,
  ANY_LIST_PREFIX,
)
export function setHeading(level: number): StateCommand {
  return ({ state, dispatch }) => {
    const changes: ChangeSpec[] = []
    const seen = new Set<number>()
    for (const range of state.selection.ranges) {
      const { startLine, endLine } = selectedLineBounds(state, range)
      for (let n = startLine; n <= endLine; n++) {
        if (seen.has(n)) continue
        seen.add(n)
        const line = state.doc.line(n)
        const match = /^(#{1,6})\s+/.exec(line.text)
        const marker = '#'.repeat(level)
        if (match && match[1]!.length === level) {
          changes.push({ from: line.from, to: line.from + match[0].length })
        } else if (match) {
          changes.push({
            from: line.from,
            to: line.from + match[0].length,
            insert: `${marker} `,
          })
        } else {
          changes.push({ from: line.from, insert: `${marker} ` })
        }
      }
    }
    if (!changes.length) return false
    const changeSet = state.changes(changes)
    dispatch(
      state.update({
        changes: changeSet,
        selection: state.selection.map(changeSet, 1),
        scrollIntoView: true,
        userEvent: 'input.format',
      }),
    )
    return true
  }
}
export function insertLink(url = ''): StateCommand {
  return ({ state, dispatch }) => {
    const changes = state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to)
      const label = text.replace(/\\/g, '\\\\').replace(/[\[\]]/g, '\\$&')
      const destination = url
        ? `<${url.replace(
            /[\u0000-\u0020<>]/g,
            (value) => encodeURIComponent(value),
          )}>`
        : ''
      const insert = `[${label}](${destination})`
      const cursor = text ? range.from + insert.length - 1 : range.from + 1
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(cursor),
      }
    })
    dispatch(
      state.update(changes, {
        scrollIntoView: true,
        userEvent: 'input.format',
      }),
    )
    return true
  }
}
export function insertImage(url = ''): StateCommand {
  return ({ state, dispatch }) => {
    const changes = state.changeByRange((range) => {
      const alt = state
        .sliceDoc(range.from, range.to)
        .replace(/\\/g, '\\\\')
        .replace(/[\[\]]/g, '\\$&')
      const destination = url
        ? `<${url.replace(
            /[\u0000-\u0020<>]/g,
            (value) => encodeURIComponent(value),
          )}>`
        : ''
      const insert = `![${alt}](${destination})`
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(
          alt ? range.from + insert.length - 1 : range.from + 2,
        ),
      }
    })
    dispatch(
      state.update(changes, {
        scrollIntoView: true,
        userEvent: 'input.format',
      }),
    )
    return true
  }
}
export function insertText(text: string, cursorOffset?: number): StateCommand {
  return ({ state, dispatch }) => {
    const changes = state.changeByRange((range) => ({
      changes: { from: range.from, to: range.to, insert: text },
      range: EditorSelection.cursor(range.from + (cursorOffset ?? text.length)),
    }))
    dispatch(
      state.update(changes, {
        scrollIntoView: true,
        userEvent: 'input.insert',
      }),
    )
    return true
  }
}

export function insertPrefix(prefix: string): StateCommand {
  return ({ state, dispatch }) => {
    const changes = state.changeByRange((range) => ({
      changes: { from: range.from, insert: prefix },
      range: range.empty
        ? EditorSelection.cursor(range.from + prefix.length)
        : EditorSelection.range(
            range.from + prefix.length,
            range.to + prefix.length,
          ),
    }))
    dispatch(
      state.update(changes, {
        scrollIntoView: true,
        userEvent: 'input.insert',
      }),
    )
    return true
  }
}

export const insertTag = insertPrefix('#')

export const insertBlockId: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main
  const position = range.to
  const prefix =
    position > 0 && !/\s/.test(state.sliceDoc(position - 1, position))
      ? ' '
      : ''
  const insert = `${prefix}^`
  dispatch(
    state.update({
      changes: { from: position, insert },
      selection: EditorSelection.cursor(position + insert.length),
      scrollIntoView: true,
      userEvent: 'input.insert',
    }),
  )
  return true
}

export const insertFootnote: StateCommand = ({ state, dispatch }) => {
  const source = state.doc.toString()
  let number = 1
  while (source.includes(`[^${number}]`)) number++
  const reference = `[^${number}]`
  const separator =
    source.length === 0
      ? '\n\n'
      : source.endsWith('\n\n')
        ? ''
        : source.endsWith('\n')
          ? '\n'
          : '\n\n'
  const definition = `${separator}[^${number}]: `
  const position = state.selection.main.to
  const changes: ChangeSpec[] = [
    { from: position, insert: reference },
    { from: state.doc.length, insert: definition },
  ]
  const definitionStart =
    state.doc.length +
    definition.length +
    (position === state.doc.length ? reference.length : 0)
  dispatch(
    state.update({
      changes,
      selection: EditorSelection.cursor(definitionStart),
      scrollIntoView: true,
      userEvent: 'input.insert',
    }),
  )
  return true
}

export const insertMermaid: StateCommand = (target) =>
  insertWrappedBlock('```mermaid', '```', 'flowchart LR\n  A --> B')(target)

export const insertCallout: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main
  const selected = state.sliceDoc(range.from, range.to)
  const body = selected
    ? selected
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    : '> '
  const insert = `> [!NOTE]\n${body}`
  dispatch(
    state.update({
      changes: { from: range.from, to: range.to, insert },
      selection: EditorSelection.cursor(range.from + insert.length),
      scrollIntoView: true,
      userEvent: 'input.insert',
    }),
  )
  return true
}

export const insertDetails: StateCommand = (target) =>
  insertWrappedBlock(
    '::: details []',
    ':::',
    '',
    '::: details ['.length,
  )(target)

export const insertTabs: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main
  const selected = state.sliceDoc(range.from, range.to)
  const firstContent = selected ? `\n${selected}` : ''
  // The shared renderer uses five-colon tabs containers.
  const tabOne = state.facet(commandLabels)('editor.tab_1')
  const tabTwo = state.facet(commandLabels)('editor.tab_2')
  const insert =
    `::::: tabs\n::: tab ${tabOne}${firstContent}\n\n:::\n` +
    `::: tab ${tabTwo}\n\n:::\n:::::\n`
  const cursor = selected
    ? range.from + insert.indexOf(selected) + selected.length
    : range.from + insert.indexOf(tabOne)
  dispatch(
    state.update({
      changes: { from: range.from, to: range.to, insert },
      selection: selected
        ? EditorSelection.cursor(cursor)
        : EditorSelection.range(cursor, cursor + tabOne.length),
      scrollIntoView: true,
      userEvent: 'input.insert',
    }),
  )
  return true
}

export const insertFrontMatter: StateCommand = ({ state, dispatch }) => {
  const source = state.doc.toString()
  if (/^---[ \t]*\r?\n/.test(source)) {
    const firstLineEnd = source.indexOf('\n') + 1
    dispatch(
      state.update({
        selection: EditorSelection.cursor(firstLineEnd),
        scrollIntoView: true,
      }),
    )
    return true
  }
  const insert = '---\ntitle: \ntags: []\n---\n\n'
  dispatch(
    state.update({
      changes: { from: 0, insert },
      selection: EditorSelection.cursor('---\ntitle: '.length),
      scrollIntoView: true,
      userEvent: 'input.insert',
    }),
  )
  return true
}
export const insertTable: StateCommand = (target) => {
  const template = [
    target.state.facet(commandLabels)('editor.column_1_column_2_column_3'),
    '| --- | --- | --- |',
    '|  |  |  |',
    '',
  ].join('\n')
  return insertPrefixedBlock(template, 2)(target)
}
export const insertCodeBlock: StateCommand = ({ state, dispatch }) => {
  const changes = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to)
    const fence = '`'.repeat(
      Math.max(3, longestCharacterRun(selected, '`') + 1),
    )
    const insert = `${fence}\n${selected}\n${fence}\n`
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + fence.length),
    }
  })
  dispatch(
    state.update(changes, { scrollIntoView: true, userEvent: 'input.insert' }),
  )
  return true
}
export const insertAdvancedCodeBlock: StateCommand = ({ state, dispatch }) => {
  const changes = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to)
    const fence = '`'.repeat(
      Math.max(3, longestCharacterRun(selected, '`') + 1),
    )
    const info = 'text title="" line-numbers {1}'
    const insert = `${fence}${info}\n${selected}\n${fence}\n`
    return {
      changes: { from: range.from, to: range.to, insert },
      range: selected
        ? EditorSelection.range(
            range.from + fence.length + info.length + 1,
            range.from + fence.length + info.length + 1 + selected.length,
          )
        : EditorSelection.cursor(range.from + fence.length),
    }
  })
  dispatch(
    state.update(changes, { scrollIntoView: true, userEvent: 'input.insert' }),
  )
  return true
}
export const insertHorizontalRule: StateCommand = (target) =>
  insertPrefixedBlock('---\n\n', 5)(target)

function insertWrappedBlock(
  open: string,
  close: string,
  fallback: string,
  emptyCursorOffset?: number,
): StateCommand {
  return ({ state, dispatch }) => {
    const range = state.selection.main
    const selected = state.sliceDoc(range.from, range.to)
    const content = selected || fallback
    const insert = `${open}\n${content}\n${close}\n`
    const cursor = selected
      ? range.from + open.length + 1 + selected.length
      : range.from + (emptyCursorOffset ?? open.length + 1)
    dispatch(
      state.update({
        changes: { from: range.from, to: range.to, insert },
        selection: EditorSelection.cursor(cursor),
        scrollIntoView: true,
        userEvent: 'input.insert',
      }),
    )
    return true
  }
}
function insertPrefixedBlock(text: string, cursorOffset: number): StateCommand {
  return ({ state, dispatch }) => {
    const range = state.selection.main
    const line = state.doc.lineAt(range.head)
    const needsBreak = line.text.trim().length > 0
    const insert = (needsBreak ? '\n' : '') + text
    dispatch(
      state.update({
        changes: { from: line.to, insert },
        selection: EditorSelection.cursor(
          line.to + (needsBreak ? 1 : 0) + cursorOffset,
        ),
        scrollIntoView: true,
        userEvent: 'input.insert',
      }),
    )
    return true
  }
}
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
