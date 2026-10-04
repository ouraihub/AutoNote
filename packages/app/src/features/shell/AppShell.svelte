<script lang="ts">
  import { onMount } from 'svelte'
  import { Button } from '../../components/ui/button'
  import Workspace from '../workspace/Workspace.svelte'
  import SettingsPanel from '../settings/SettingsPanel.svelte'
  import CommandPalette from '../command/CommandPalette.svelte'
  import ShortcutsPanel from '../command/ShortcutsPanel.svelte'
  import GraphPanel from '../graph/GraphPanel.svelte'
  import { createHotkeys, type Hotkeys } from '../../lib/hotkeys'
  import { getBackend, getExtensions, getI18n, getNotes, getNotifier, getOrganize, getSettings, getUi } from '../../root/context'

  const backend = getBackend()
  const extensions = getExtensions()
  const notifier = getNotifier()
  const i18n = getI18n()
  const notes = getNotes()
  const settings = getSettings()
  const ui = getUi()
  const organize = getOrganize()
  let surface = $state<HTMLDivElement>()
  let hotkeys = $state<Hotkeys>()

  onMount(() => {
    if (!surface) return
    const registry = createHotkeys({ target: surface })
    hotkeys = registry
    registry.registerAll([
      { id: 'command', combo: 'mod+k', description: () => i18n.t('common.command_palette'), group: () => i18n.t('common.navigation'), allowInInput: true, handler: () => ui.togglePanel('command') },
      { id: 'settings', combo: 'mod+,', description: () => i18n.t('common.open_settings'), group: () => i18n.t('common.interface'), allowInInput: true, handler: () => ui.togglePanel('settings') },
      { id: 'new', combo: 'mod+n', description: () => i18n.t('common.new_note'), group: () => i18n.t('common.navigation'), handler: () => void createNote() },
      { id: 'shortcuts', combo: 'shift+?', description: () => i18n.t('command.keyboard_shortcuts'), group: () => i18n.t('common.interface'), handler: () => ui.togglePanel('shortcuts') },
    ])
    return () => registry.dispose()
  })

  async function createNote(): Promise<void> {
    try {
      const note = await notes.create({})
      await openNote(note.id)
    } catch {
      notifier.toast({ key: 'common.action_failed', tone: 'error' })
    }
  }

  async function openNote(id: string, secondary = false): Promise<void> {
    try {
      ui.openNote(id, secondary ? { pane: 'secondary' } : {})
      extensions.onNoteOpened?.(id)
      await notes.open(id, ui.activePane)
    } catch {
      notifier.toast({ key: 'common.action_failed', tone: 'error' })
    }
  }
</script>

<div bind:this={surface} class="flex h-full min-h-0 flex-col" data-testid="app-shell">
  <header class="flex flex-wrap items-center gap-2 border-b border-[var(--border-default)] px-3 py-2">
    <strong class="mr-auto text-sm">{i18n.t('common.product_name')}</strong>
    <Button variant="ghost" onclick={() => void createNote()}>{i18n.t('common.new_note')}</Button>
    <Button variant="ghost" onclick={() => ui.openPanel('command')}>{i18n.t('common.command_palette')}</Button>
    <Button variant="ghost" onclick={() => ui.openPanel('graph')}>{i18n.t('command.open_graph')}</Button>
    <Button variant="ghost" onclick={() => ui.openPanel('settings')}>{i18n.t('common.open_settings')}</Button>
  </header>
  <div class="flex min-h-0 flex-1">
    <nav class="note-navigation w-56 shrink-0 overflow-auto border-r border-[var(--border-default)] p-2" class:mobile-hidden={ui.mobilePane !== 'list'} aria-label={i18n.t('common.navigation')}>
      {#each Object.values(notes.summaries).filter((note) => note.deletedAt === null) as note (note.id)}
        <Button class="mb-1 w-full justify-start truncate" variant={ui.activeNoteId === note.id ? 'secondary' : 'ghost'} onclick={(event) => void openNote(note.id, event.shiftKey || event.altKey)}>{note.title || i18n.t('common.untitled_note')}</Button>
      {/each}
    </nav>
    <main class="min-h-0 min-w-0 flex-1" class:mobile-hidden={ui.mobilePane === 'list'}><Workspace /></main>
  </div>
  {#if ui.panel === 'settings'}<SettingsPanel onClose={() => ui.closePanel()} />{/if}
  {#if ui.panel === 'command' || ui.panel === 'search'}
    <CommandPalette {notes} {ui} {backend} {i18n} {settings} {organize} onOpenChange={(open) => { if (!open) ui.closePanel() }} />
  {/if}
  {#if ui.panel === 'shortcuts' && hotkeys}<ShortcutsPanel {hotkeys} {i18n} onOpenChange={(open) => { if (!open) ui.closePanel() }} />{/if}
  {#if ui.panel === 'graph'}<GraphPanel {backend} {ui} {notes} {i18n} onClose={() => ui.closePanel()} />{/if}
</div>

<style>
  @media (max-width: 767px) {
    .mobile-hidden { display: none; }
    .note-navigation { width: 100%; border-right: 0; }
  }
</style>
