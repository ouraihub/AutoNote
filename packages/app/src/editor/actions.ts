import { startCompletion } from '@codemirror/autocomplete'
import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { insertAttachments } from './paste'

/**
 * Toolbar entry points for the completion and attachment features. Each command keeps
 * focus in the editor so the opened completion list can be driven from the keyboard.
 */

/** Wraps the selection (or inserts an empty pair) in `[[…]]` and opens note-title completion. */
export function insertWikiLink(view: EditorView): boolean {
  view.dispatch(
    view.state.changeByRange((range) => {
      const selected = view.state.sliceDoc(range.from, range.to)
      return {
        changes: { from: range.from, to: range.to, insert: `[[${selected}]]` },
        range: EditorSelection.cursor(range.from + 2 + selected.length),
      }
    }),
    { scrollIntoView: true, userEvent: 'input.format' },
  )
  view.focus()
  startCompletion(view)
  return true
}

/** Inserts `#` before each selection and opens tag completion. */
export function insertTag(view: EditorView): boolean {
  view.dispatch(
    view.state.changeByRange((range) => ({
      changes: { from: range.from, insert: '#' },
      range: range.empty
        ? EditorSelection.cursor(range.from + 1)
        : EditorSelection.range(range.from + 1, range.to + 1),
    })),
    { scrollIntoView: true, userEvent: 'input.insert' },
  )
  view.focus()
  startCompletion(view)
  return true
}

/** Uploads files chosen from a toolbar file picker at the current selection. */
export async function insertPickedFiles(
  view: EditorView,
  files: Iterable<File>,
): Promise<void> {
  const list = [...files]
  if (!list.length) return
  view.focus()
  await insertAttachments(view, list)
}
