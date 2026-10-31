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
  import { History, RotateCcw } from '@lucide/svelte'
  import Modal from '../../components/primitives/Modal.svelte'
  import Button from '../../components/primitives/Button.svelte'
  import Empty from '../../components/primitives/Empty.svelte'

  interface Props {
    noteId: string
    pane: WorkspacePane
    backend: {
      notes: Pick<Backend['notes'], 'versions' | 'version' | 'restoreVersion'>
    }
    notes: Pick<
      NotesState,
      | 'flush'
      | 'open'
      | 'panes'
      | 'summaries'
      | 'contents'
      | 'dirtyById'
      | 'loadErrors'
    >
    i18n: Pick<I18nState, 't'>
    notifier: Pick<Notifier, 'confirm'>
    onClose: () => void
  }

  let { noteId, pane, backend, notes, i18n, notifier, onClose }: Props =
    $props()
  let history = $state<{ noteId: string; versions: NoteVersionMeta[] } | null>(
    null,
  )
  let selected = $state<{ noteId: string; versionId: string } | null>(null)
  let preview = $state<{
    noteId: string
    versionId: string
    content: string
  } | null>(null)
  let historyError = $state('')
  let previewError = $state('')
  let restoreError = $state('')
  let historyReload = $state(0)
  let previewReload = $state(0)
  let busy = $state(false)
  let alive = true
  const versions = $derived(
    history?.noteId === noteId ? history.versions : null,
  )
  const versionId = $derived(
    selected?.noteId === noteId ? selected.versionId : null,
  )
  const content = $derived(
    preview?.noteId === noteId && preview.versionId === versionId
      ? preview.content
      : null,
  )

  onDestroy(() => {
    alive = false
  })

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
    void backend.notes
      .versions(id, { signal: controller.signal })
      .then((items) => {
        if (controller.signal.aborted || noteId !== id) return
        history = { noteId: id, versions: items }
        selected = items[0] ? { noteId: id, versionId: items[0].id } : null
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && noteId === id)
          historyError = i18n.t(
            isBackendError(error)
              ? messageKeyForError(error.code)
              : 'common.action_failed',
          )
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
    void backend.notes
      .version(id, version, { signal: controller.signal })
      .then((item) => {
        if (
          !controller.signal.aborted &&
          noteId === id &&
          versionId === version
        ) {
          preview = { noteId: id, versionId: version, content: item.content }
        }
      })
      .catch((error: unknown) => {
        if (
          !controller.signal.aborted &&
          noteId === id &&
          versionId === version
        ) {
          previewError = i18n.t(
            isBackendError(error)
              ? messageKeyForError(error.code)
              : 'common.action_failed',
          )
        }
      })
    return () => controller.abort()
  })

  async function restore(): Promise<void> {
    const id = noteId
    const currentPane = pane
    const version = versionId
    if (busy || !version || content === null || notes.panes[currentPane] !== id)
      return
    busy = true
    restoreError = ''
    const unchanged = (rev: number, text: string) =>
      alive &&
      noteId === id &&
      pane === currentPane &&
      versionId === version &&
      notes.panes[currentPane] === id &&
      notes.summaries[id]?.rev === rev &&
      notes.contents[id] === text &&
      !notes.dirtyById[id]
    try {
      let saved = await notes.flush(id)
      if (saved.pending || saved.failed || notes.dirtyById[id]) {
        restoreError = i18n.t('shell.unsaved_changes')
        return
      }
      if (
        !alive ||
        noteId !== id ||
        pane !== currentPane ||
        notes.panes[currentPane] !== id ||
        versionId !== version
      )
        return
      const rev = notes.summaries[id]?.rev
      const text = notes.contents[id]
      if (rev === undefined || text === undefined)
        throw new Error('Note is not loaded')
      if (
        !(await notifier.confirm({
          titleKey: 'workspace.restore_this_version',
          bodyKey:
            'workspace.the_current_content_will_be_automatically_saved_as_a_new_version_first_a',
        }))
      )
        return
      if (!unchanged(rev, text)) {
        restoreError = i18n.t('shell.unsaved_changes')
        return
      }
      saved = await notes.flush(id)
      if (saved.pending || saved.failed || !unchanged(rev, text)) {
        restoreError = i18n.t('shell.unsaved_changes')
        return
      }
      await backend.notes.restoreVersion(id, version)
      if (
        !alive ||
        noteId !== id ||
        pane !== currentPane ||
        notes.panes[currentPane] !== id
      )
        return
      await notes.open(id, currentPane)
      if (notes.loadErrors[id]) throw new Error(notes.loadErrors[id])
      historyReload++
    } catch (error) {
      if (alive && noteId === id)
        restoreError = i18n.t(
          isBackendError(error)
            ? messageKeyForError(error.code)
            : 'common.action_failed',
        )
    } finally {
      if (alive) busy = false
    }
  }
</script>

<Modal
  open
  onClose={() => {
    if (!busy) onClose()
  }}
  title={i18n.t('common.version_history')}
  description={notes.summaries[noteId]
    ? i18n.t('workspace.autosave_for_value0', {
        value0: notes.summaries[noteId]!.title,
      })
    : undefined}
  width={880}
>
  {#if historyError}
    <Empty
      art="notes"
      compact
      title={i18n.t('workspace.could_not_load_version_history')}
      description={historyError}
    >
      {#snippet action()}<Button
          size="sm"
          variant="secondary"
          onclick={() => historyReload++}>{i18n.t('common.retry')}</Button
        >{/snippet}
    </Empty>
  {:else if !versions}
    <p
      role="status"
      class="py-10 text-center text-[12px] text-[var(--text-quaternary)]"
    >
      {i18n.t('common.loading')}
    </p>
  {:else if !versions.length}
    <Empty
      art="notes"
      compact
      title={i18n.t('workspace.no_version_history_yet')}
      description={i18n.t(
        'workspace.a_snapshot_is_saved_every_few_minutes_or_after_larger_edits',
      )}
    />
  {:else}
    <div
      class="flex h-[min(68dvh,560px)] min-h-0 flex-col gap-3 md:h-[440px] md:flex-row"
    >
      <ul
        class="flex w-full shrink-0 gap-1 overflow-x-auto border-b border-[var(--border-subtle)] pb-2 md:block md:w-[210px] md:space-y-px md:overflow-y-auto md:border-r md:border-b-0 md:pr-2 md:pb-0"
      >
        {#each versions as item, index (item.id)}
          <li class="w-[188px] shrink-0 md:w-auto">
            <button
              type="button"
              aria-pressed={versionId === item.id}
              onclick={() => (selected = { noteId, versionId: item.id })}
              class={[
                'w-full rounded-[var(--r-md)] px-2 py-2 text-left transition-colors',
                versionId === item.id
                  ? 'bg-[var(--accent-soft)]'
                  : 'hover:bg-[var(--bg-hover)]',
              ]}
            >
              <span
                class="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-primary)]"
              >
                <History
                  size={11}
                  class="shrink-0 text-[var(--text-quaternary)]"
                />
                {index === 0
                  ? i18n.t('workspace.latest')
                  : new Date(item.createdAt).toLocaleString()}
              </span>
              <span
                class="mt-0.5 block truncate pl-4 text-[10.5px] text-[var(--text-quaternary)]"
                >{item.title}</span
              >
            </button>
          </li>
        {/each}
      </ul>
      <div
        class="min-w-0 flex-1 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)]"
      >
        {#if previewError}
          <Empty
            art="notes"
            compact
            title={i18n.t('workspace.could_not_load_version')}
            description={previewError}
          >
            {#snippet action()}<Button
                size="sm"
                variant="secondary"
                onclick={() => previewReload++}>{i18n.t('common.retry')}</Button
              >{/snippet}
          </Empty>
        {:else if content === null}
          <p
            role="status"
            class="py-10 text-center text-[12px] text-[var(--text-quaternary)]"
          >
            {i18n.t('common.loading')}
          </p>
        {:else}
          <pre
            class="p-3 font-mono text-[11.5px] leading-[1.65] whitespace-pre-wrap break-words">{content}</pre>
        {/if}
      </div>
    </div>
  {/if}
  {#if restoreError}<p
      role="alert"
      class="mt-3 text-[12px] text-[var(--danger)]"
    >
      {i18n.t('common.restore_failed')}: {restoreError}
    </p>{/if}
  {#snippet footer()}
    <Button variant="ghost" disabled={busy} onclick={onClose}
      >{i18n.t('common.close')}</Button
    >
    <Button
      variant="primary"
      loading={busy}
      disabled={busy || content === null || notes.panes[pane] !== noteId}
      onclick={() => void restore()}
      ><RotateCcw size={13} />{i18n.t(
        'workspace.restore_this_version_da5169',
      )}</Button
    >
  {/snippet}
</Modal>
