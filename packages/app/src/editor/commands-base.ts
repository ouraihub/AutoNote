import {
  EditorSelection,
  Facet,
  type ChangeSpec,
  type StateCommand,
} from '@codemirror/state'
import {
  containedMarkers,
  codeSpanMarkers,
  countRunAfter,
  countRunBefore,
  lineIndent,
  linePrefixMatch,
  longestCharacterRun,
  selectedLineBounds,
  surroundingMarkers,
} from './commands-helpers'
import type { MessageKey } from '@shared/locales/en-US'
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
        ? '<' +
          `${url.replace(/[\u0000-\u0020<>]/g, (value) =>
            encodeURIComponent(value),
          )}` +
          '>'
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
        ? '<' +
          `${url.replace(/[\u0000-\u0020<>]/g, (value) =>
            encodeURIComponent(value),
          )}` +
          '>'
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
