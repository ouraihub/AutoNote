import type { Backend } from '../../backend'
import type { NotesState } from '../../state/notes.svelte'
import type { UiState } from '../../state/ui.svelte'
import type { WorkspacePane } from '../../state/layout-prefs'
import type { Notifier } from '../../platform/notifier'
import type { HostExtensions } from '../../root/types'
import type { RenderServices, ResolvedNote } from '../../markdown/embeds'
import { parseWikiTarget, type WikiTarget } from '../../markdown/renderer'

export interface PreviewServiceOptions {
  backend: Backend
  notes: NotesState
  ui: UiState
  notifier: Notifier
  extensions: HostExtensions
  noteId(): string
  source(): string
  pane(): WorkspacePane
  onNavigate?(target: WikiTarget, id: string): void
}

export function updateTaskAtSourceLine(
  source: string,
  line: number,
  checked: boolean,
): string | null {
  if (!Number.isInteger(line) || line < 0) return null
  let from = 0
  for (let index = 0; index < line; index += 1) {
    const newline = source.indexOf('\n', from)
    if (newline < 0) return null
    from = newline + 1
  }
  const end = source.indexOf('\n', from)
  const match =
    /^((?:[ \t]*>[ \t]?)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/.exec(
      source.slice(from, end < 0 ? source.length : end),
    )
  if (!match?.[1]) return null
  const marker = from + match[1].length
  return (
    source.slice(0, marker) + (checked ? 'x' : ' ') + source.slice(marker + 1)
  )
}

export function createRenderServices(
  options: PreviewServiceOptions,
): RenderServices {
  let navigation = 0
  async function resolveNote(
    target: string,
    signal: AbortSignal,
  ): Promise<ResolvedNote | null> {
    const parsed = parseWikiTarget(target)
    const title = parsed.noteTitle
    const known = title
      ? Object.values(options.notes.summaries).find(
          (note) =>
            !note.deletedAt && (note.id === title || note.title === title),
        )
      : options.notes.summaries[options.noteId()]
    let id = known?.id
    if (!id && title) {
      const found = await options.backend.search.query(title, 100, { signal })
      if (signal.aborted) return null
      id = found.results.find(
        ({ note }) => !note.deletedAt && note.title === title,
      )?.note.id
    }
    if (!id || signal.aborted) return null
    if (id === options.noteId())
      return { id, title: known?.title ?? title, content: options.source() }
    const content = options.notes.contents[id]
    if (known && content !== undefined)
      return { id, title: known.title, content }
    return options.backend.notes.get(id, { signal })
  }
  return {
    resolveNote,
    resolveAssetUrl: (url) => options.backend.files.resolveUrl(url),
    openNote(target) {
      const epoch = ++navigation
      const origin = options.noteId()
      const pane = options.pane()
      const controller = new AbortController()
      const parsed = parseWikiTarget(target)
      void (async () => {
        let note = await resolveNote(target, controller.signal)
        if (epoch !== navigation || origin !== options.noteId()) return
        if (!note && parsed.noteTitle)
          note = await options.notes.create({
            title: parsed.noteTitle,
            content: '',
          })
        if (!note || epoch !== navigation || origin !== options.noteId()) return
        if (note.id !== origin) {
          options.ui.openNote(note.id, { pane })
          await options.notes.open(note.id, pane)
        }
        if (
          epoch !== navigation ||
          options.ui.panes[pane].noteId !== note.id ||
          options.notes.loadErrors[note.id]
        )
          return
        options.extensions.onNoteOpened?.(note.id)
        options.onNavigate?.(parsed, note.id)
      })().catch(() =>
        options.notifier.toast({ key: 'common.action_failed', tone: 'error' }),
      )
    },
    async toggleTask(line, checked) {
      const id = options.noteId()
      const source = options.source()
      if (options.notes.contents[id] !== source)
        throw new Error('Stale preview source')
      const next = updateTaskAtSourceLine(source, line, checked)
      if (next === null) throw new Error('Invalid task source line')
      options.notes.editContent(id, next)
    },
  }
}
