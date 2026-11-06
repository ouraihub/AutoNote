<script lang="ts">
  import type { ImageRef } from '@ouraihub/aether-ui/ports'
  import type { MessageKey } from '@shared/locales/en-US'
  import {
    getBackend,
    getExtensions,
    getI18n,
    getNotes,
    getUi,
  } from '@app/root/context'
  import { uploadedFileMarkdown } from '@app/editor'
  import type { WorkspacePanelProps } from '@app/root/types'
  import Resizer from '../../components/primitives/Resizer.svelte'
  import { PANEL_WIDTHS } from '../../state/layout-prefs'

  let { narrow }: { narrow: boolean } = $props()
  const extensions = getExtensions()
  const ui = getUi()
  const notes = getNotes()
  const backend = getBackend()
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
    if (note)
      notes.editContent(
        note.id,
        `${note.content}${note.content.endsWith('\n') ? '\n' : '\n\n'}${text}`,
      )
  }
  async function saveNote(
    markdown: string,
    images: readonly ImageRef[] = [],
  ): Promise<void> {
    const first = markdown.split(/\r?\n/).find((line) => line.trim()) ?? ''
    const title = [...first.replace(/^\s{0,3}#{1,6}\s+/, '').trim()]
      .slice(0, 80)
      .join('')
    const links: string[] = []
    for (const [index, image] of images.entries()) {
      if (!image.url || !backend.aiHost) continue
      const blob = await backend.aiHost.readImage(image.url)
      const extension = (image.mime.split('/')[1] ?? 'png').replace(
        'jpeg',
        'jpg',
      )
      const file = new File([blob], `ai-image-${index + 1}.${extension}`, {
        type: image.mime,
      })
      links.push(uploadedFileMarkdown(await backend.files.upload(file)))
    }
    const content = [markdown, ...links].filter(Boolean).join('\n\n')
    await notes.create({ title, content })
  }
  const close = (): void => ui.toggleAssist(false)
</script>

<svelte:window
  onkeydown={(event) => {
    if (
      event.key === 'Escape' &&
      narrow &&
      ui.layout.assistOpen &&
      !event.defaultPrevented
    )
      close()
  }}
/>

{#if slot && ui.layout.assistOpen}
  {@const Panel = slot.component}
  {#if !narrow}<Resizer
      label={i18n.t('shell.resize_assist_panel')}
      value={ui.layout.assistWidth}
      min={PANEL_WIDTHS.assist.min}
      max={PANEL_WIDTHS.assist.max}
      invert
      onChange={(assistWidth) => ui.resize({ assistWidth })}
      onReset={() => ui.resize({ assistWidth: PANEL_WIDTHS.assist.default })}
    />{/if}
  <aside
    aria-label={i18n.t(slot.titleKey as MessageKey)}
    style:width={narrow ? undefined : `${ui.layout.assistWidth}px`}
    class={narrow
      ? 'app-viewport-fixed fixed inset-0 z-[220] flex flex-col ' +
        'bg-[var(--bg-base)] pt-[env(safe-area-inset-top)] ' +
        'pb-[env(safe-area-inset-bottom)]'
      : 'flex max-w-[60%] shrink-0 flex-col border-l ' +
        'border-[var(--border-subtle)] bg-[var(--bg-base)]'}
  >
    <Panel
      {note}
      {insert}
      {saveNote}
      openSettings={(id) => ui.openSettings(id)}
      onClose={close}
    />
  </aside>
{/if}
