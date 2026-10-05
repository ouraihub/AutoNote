<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import {
    getBackend,
    getNotes,
    getUi,
    getI18n,
    getPrefs,
    getNotifier,
    getLogger,
    getRegisterFlush,
  } from '../../root/context'
  import { CoalescingPrefsWriter } from '../../state/prefs-writer'
  import type { WorkspacePane } from '../../state/layout-prefs'
  import { Button } from '../../components/ui/button'
  import NotePane from './NotePane.svelte'
  import SplitResizer from './SplitResizer.svelte'
  import VersionsPanel from './VersionsPanel.svelte'

  const backend = getBackend(),
    notes = getNotes(),
    ui = getUi(),
    i18n = getI18n(),
    prefs = getPrefs(),
    notifier = getNotifier(),
    logger = getLogger()
  const writer = new CoalescingPrefsWriter((key, value) => prefs.save(key, value))
  const panes: readonly WorkspacePane[] = ['primary', 'secondary']
  const unregisterFlush = getRegisterFlush()(() => writer.flush())
  let narrow = $state(false)
  let createError = $state(false)
  let creating = $state(false)
  const ratio = $derived(ui.layout.workspaceSplitRatio ?? 0.5)
  onMount(() => {
    const media = matchMedia('(max-width: 767px)')
    const update = () => {
      narrow = media.matches
    }
    update()
    media.addEventListener('change', update)
    const flush = () => {
      void writer.flush().catch((error) => logger.warn('workspace.reading_position.failed', { error: String(error) }))
    }
    window.addEventListener('pagehide', flush)
    return () => {
      media.removeEventListener('change', update)
      window.removeEventListener('pagehide', flush)
    }
  })
  onDestroy(() => {
    unregisterFlush()
    void writer.flush().catch((error) => logger.warn('workspace.reading_position.failed', { error: String(error) }))
  })
  async function create(): Promise<void> {
    if (creating) return
    creating = true
    createError = false
    try {
      const note = await notes.create({ content: '', folderId: ui.filter.folderId })
      ui.openNote(note.id)
      ui.setMobilePane('editor')
    } catch {
      createError = true
    } finally {
      creating = false
    }
  }
</script>

<div class="workspace" data-workspace data-active-pane={ui.activePane}>
  {#if narrow && ui.isSplit}
    <nav class="pane-switch" aria-label={i18n.t('shell.resize_note_panes')}>
      {#each panes as pane (pane)}<Button
          variant="ghost"
          size="sm"
          aria-pressed={ui.activePane === pane}
          onclick={() => ui.activatePane(pane)}
          >{notes.summaries[ui.panes[pane].noteId ?? '']?.title ||
            i18n.t(pane === 'primary' ? 'workspace.left_note_pane' : 'workspace.right_note_pane')}</Button
        >{/each}
    </nav>
  {/if}
  <div class="workspace-panes">
    {#each panes as pane (pane)}
      {@const id = ui.panes[pane].noteId}
      {#if pane === 'secondary' && ui.isSplit && !narrow}<SplitResizer
          {ratio}
          label={i18n.t('shell.resize_note_panes')}
          onChange={(workspaceSplitRatio) => ui.resize({ workspaceSplitRatio })}
          onReset={() => ui.resize({ workspaceSplitRatio: null })}
        />{/if}
      {#if id}
        <div
          class="workspace-pane"
          hidden={narrow && ui.activePane !== pane}
          inert={narrow && ui.activePane !== pane}
          style:width={!narrow && ui.isSplit ? `${(pane === 'primary' ? ratio : 1 - ratio) * 100}%` : '100%'}
        >
          {#key `${ui.scope}:${id}`}<NotePane {pane} noteId={id} {narrow} {writer} />{/key}
        </div>
      {/if}
    {/each}
    {#if !ui.panes.primary.noteId}
      <div class="empty-workspace">
        <h2>{i18n.t('workspace.choose_a_note_or_write_a_new_one')}</h2>
        <p>
          {i18n.t('workspace.open_a_note_from_the_list_or_press_shortcut_to_create_one', { shortcut: 'Ctrl / ⌘ + N' })}
        </p>
        <Button disabled={creating} onclick={create}>{i18n.t('common.new_note')}</Button>{#if createError}<p
            role="alert"
          >
            {i18n.t('common.action_failed')}
          </p>{/if}
      </div>
    {/if}
  </div>
  {#if ui.panel === 'versions' && ui.activeNoteId}<VersionsPanel
      noteId={ui.activeNoteId}
      pane={ui.activePane}
      {backend}
      {notes}
      {i18n}
      {notifier}
      onClose={() => ui.closePanel()}
    />{/if}
</div>

<style>
  .workspace {
    display: flex;
    flex: 1;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    min-width: 0;
  }
  .workspace-panes {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  .workspace-pane {
    min-width: 0;
    min-height: 0;
    flex-shrink: 0;
  }
  .workspace-pane[hidden] {
    display: none;
  }
  .pane-switch {
    display: flex;
    gap: 4px;
    padding: 4px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .pane-switch :global(button) {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty-workspace {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px;
    text-align: center;
  }
  .empty-workspace h2 {
    font-size: 18px;
    font-weight: 600;
  }
  .empty-workspace p {
    color: var(--text-secondary);
  }
</style>
