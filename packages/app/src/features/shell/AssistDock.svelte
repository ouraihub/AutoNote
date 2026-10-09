<script lang="ts">
  import type { MessageKey } from '@shared/locales/en-US'
  import { getExtensions, getI18n, getNotes, getUi } from '@app/root/context'
  import type { WorkspacePanelProps } from '@app/root/types'

  // Right-side dock for the host's workspace panel; full-screen overlay when narrow.
  let { narrow }: { narrow: boolean } = $props()
  const extensions = getExtensions()
  const ui = getUi()
  const notes = getNotes()
  const i18n = getI18n()
  const slot = extensions.workspacePanel

  const note = $derived.by((): WorkspacePanelProps['note'] => {
    const id = ui.activeNoteId
    const summary = id ? notes.summaries[id] : undefined
    const content = id ? notes.contents[id] : undefined
    return id && summary && content !== undefined
      ? { id, title: summary.title || i18n.t('common.untitled_note'), content }
      : null
  })
  function insert(text: string): void {
    if (ui.insertAtCursor) return ui.insertAtCursor(text)
    if (note) notes.editContent(note.id, `${note.content}${note.content.endsWith('\n') ? '\n' : '\n\n'}${text}`)
  }
  const close = (): void => ui.toggleAssist(false)
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape' && narrow && ui.layout.assistOpen && !event.defaultPrevented) close()
  }}
/>

{#if slot && ui.layout.assistOpen}
  {@const Panel = slot.component}
  <aside
    aria-label={i18n.t(slot.titleKey as MessageKey)}
    class={narrow
      ? 'app-viewport-fixed fixed inset-0 z-[220] flex flex-col bg-[var(--bg-base)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]'
      : 'flex w-[360px] shrink-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-base)]'}
  >
    <Panel {note} {insert} openSettings={(id) => ui.openSettings(id)} onClose={close} />
  </aside>
{/if}
