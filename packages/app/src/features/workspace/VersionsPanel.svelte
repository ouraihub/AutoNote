<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { NoteVersionMeta } from '@shared/types'
  import type { Backend } from '../../backend'
  import { isBackendError } from '../../backend/errors'
  import { messageKeyForError } from '../../i18n/errors'
  import type { I18nState } from '../../i18n/runtime.svelte'
  import type { Notifier } from '../../platform/notifier'
  import type { WorkspacePane } from '../../state/layout-prefs'
  import type { NotesState } from '../../state/notes.svelte'
  import * as Dialog from '../../components/ui/dialog'

  interface Props {
    noteId: string
    pane: WorkspacePane
    backend: { notes: Pick<Backend['notes'], 'versions' | 'version' | 'restoreVersion'> }
    notes: Pick<NotesState, 'flush' | 'open' | 'panes' | 'summaries' | 'contents' | 'dirtyById' | 'loadErrors'>
    i18n: Pick<I18nState, 't'>
    notifier: Pick<Notifier, 'confirm'>
    onClose: () => void
  }

  let { noteId, pane, backend, notes, i18n, notifier, onClose }: Props = $props()
  let history = $state<{ noteId: string; versions: NoteVersionMeta[] } | null>(null)
  let selected = $state<{ noteId: string; versionId: string } | null>(null)
  let preview = $state<{ noteId: string; versionId: string; content: string } | null>(null)
  let historyError = $state('')
  let previewError = $state('')
  let restoreError = $state('')
  let historyReload = $state(0)
  let previewReload = $state(0)
  let busy = $state(false)
  let alive = true
  const versions = $derived(history?.noteId === noteId ? history.versions : null)
  const versionId = $derived(selected?.noteId === noteId ? selected.versionId : null)
  const content = $derived(preview?.noteId === noteId && preview.versionId === versionId ? preview.content : null)

  onDestroy(() => { alive = false })

  $effect(() => {
    const id = noteId
    void historyReload
    const controller = new AbortController()
    history = null
    selected = null
    preview = null
    historyError = ''
    previewError = ''
    restoreError = ''
    void backend.notes.versions(id, { signal: controller.signal }).then((items) => {
      if (controller.signal.aborted || noteId !== id) return
      history = { noteId: id, versions: items }
      selected = items[0] ? { noteId: id, versionId: items[0].id } : null
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && noteId === id) historyError = i18n.t(isBackendError(error) ? messageKeyForError(error.code) : 'common.action_failed')
    })
    return () => controller.abort()
  })

  $effect(() => {
    const id = noteId
    const version = versionId
    void previewReload
    preview = null
    previewError = ''
    if (!version) return
    const controller = new AbortController()
    void backend.notes.version(id, version, { signal: controller.signal }).then((item) => {
      if (!controller.signal.aborted && noteId === id && versionId === version) {
        preview = { noteId: id, versionId: version, content: item.content }
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && noteId === id && versionId === version) {
        previewError = i18n.t(isBackendError(error) ? messageKeyForError(error.code) : 'common.action_failed')
      }
    })
    return () => controller.abort()
  })

  async function restore(): Promise<void> {
    const id = noteId
    const currentPane = pane
    const version = versionId
    if (busy || !version || content === null || notes.panes[currentPane] !== id) return
    busy = true
    restoreError = ''
    const unchanged = (rev: number, text: string) =>
      alive && noteId === id && pane === currentPane && versionId === version &&
      notes.panes[currentPane] === id && notes.summaries[id]?.rev === rev &&
      notes.contents[id] === text && !notes.dirtyById[id]
    try {
      let saved = await notes.flush(id)
      if (saved.pending || saved.failed || notes.dirtyById[id]) { restoreError = i18n.t('shell.unsaved_changes'); return }
      if (!alive || noteId !== id || pane !== currentPane || notes.panes[currentPane] !== id || versionId !== version) return
      const rev = notes.summaries[id]?.rev
      const text = notes.contents[id]
      if (rev === undefined || text === undefined) throw new Error('Note is not loaded')
      if (!await notifier.confirm({
        titleKey: 'workspace.restore_this_version',
        bodyKey: 'workspace.the_current_content_will_be_automatically_saved_as_a_new_version_first_a',
      })) return
      if (!unchanged(rev, text)) { restoreError = i18n.t('shell.unsaved_changes'); return }
      saved = await notes.flush(id)
      if (saved.pending || saved.failed || !unchanged(rev, text)) { restoreError = i18n.t('shell.unsaved_changes'); return }
      await backend.notes.restoreVersion(id, version)
      if (!alive || noteId !== id || pane !== currentPane || notes.panes[currentPane] !== id) return
      await notes.open(id, currentPane)
      if (notes.loadErrors[id]) throw new Error(notes.loadErrors[id])
      historyReload++
    } catch (error) {
      if (alive && noteId === id) restoreError = i18n.t(isBackendError(error) ? messageKeyForError(error.code) : 'common.action_failed')
    } finally {
      if (alive) busy = false
    }
  }
</script>

<Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
  <Dialog.Content class="flex max-h-[85vh] w-[min(95vw,880px)] max-w-none flex-col" showCloseButton={false}>
    <Dialog.Title>{i18n.t('common.version_history')}</Dialog.Title>
    {#if notes.summaries[noteId]}<Dialog.Description>{i18n.t('workspace.autosave_for_value0', { value0: notes.summaries[noteId]!.title })}</Dialog.Description>{/if}
    {#if historyError}
      <p role="alert">{i18n.t('workspace.could_not_load_version_history')}: {historyError} <button type="button" onclick={() => historyReload++}>{i18n.t('common.retry')}</button></p>
    {:else if !versions}
      <p role="status">{i18n.t('common.loading')}</p>
    {:else if !versions.length}
      <p>{i18n.t('workspace.no_version_history_yet')}</p>
    {:else}
      <div class="flex min-h-0 flex-col gap-3 overflow-auto sm:flex-row">
        <ul class="min-w-40 shrink-0 overflow-y-auto">
          {#each versions as item, index (item.id)}
            <li><button type="button" aria-pressed={versionId === item.id} onclick={() => (selected = { noteId, versionId: item.id })}>
              {index === 0 ? i18n.t('workspace.latest') : new Date(item.createdAt).toLocaleString()} · {item.title}
            </button></li>
          {/each}
        </ul>
        <div class="min-w-0 flex-1 overflow-y-auto">
          {#if previewError}
            <p role="alert">{i18n.t('workspace.could_not_load_version')}: {previewError} <button type="button" onclick={() => previewReload++}>{i18n.t('common.retry')}</button></p>
          {:else if content === null}
            <p role="status">{i18n.t('common.loading')}</p>
          {:else}
            <pre class="whitespace-pre-wrap break-words">{content}</pre>
          {/if}
        </div>
      </div>
    {/if}
    {#if restoreError}<p role="alert">{i18n.t('common.restore_failed')}: {restoreError}</p>{/if}
    <Dialog.Footer>
      <button type="button" disabled={busy} onclick={onClose}>{i18n.t('common.close')}</button>
      <button type="button" disabled={busy || content === null || notes.panes[pane] !== noteId} onclick={() => void restore()}>{i18n.t('workspace.restore_this_version_da5169')}</button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
