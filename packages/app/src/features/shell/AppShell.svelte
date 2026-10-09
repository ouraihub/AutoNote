<script lang="ts">
  import { onMount } from 'svelte'
  import { Eye, FileText, PanelLeft, PencilLine, UserRound } from '@lucide/svelte'
  import IconButton from '../../components/primitives/IconButton.svelte'
  import Resizer from '../../components/primitives/Resizer.svelte'
  import SearchButton from '../../components/primitives/SearchButton.svelte'
  import { PANEL_WIDTHS } from '../../state/layout-prefs'
  import type { MobilePane } from '../../state/ui.svelte'
  import Workspace from '../workspace/Workspace.svelte'
  import AssistDock from './AssistDock.svelte'
  import SettingsPanel from '../settings/SettingsPanel.svelte'
  import CommandPalette from '../command/CommandPalette.svelte'
  import ShortcutsPanel from '../command/ShortcutsPanel.svelte'
  import GraphPanel from '../graph/GraphPanel.svelte'
  import SharePanel from '../share/SharePanel.svelte'
  import Sidebar from '../sidebar/Sidebar.svelte'
  import NoteList from '../list/NoteList.svelte'
  import { createHotkeys, type Hotkeys } from '../../lib/hotkeys'
  import { breakpoint as currentBreakpoint } from '../../lib/breakpoint.svelte'
  import { getBackend, getExtensions, getI18n, getNotes, getNotifier, getOrganize, getSettings, getUi } from '../../root/context'
  import type { MessageKey } from '@shared/locales/en-US'

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
  const breakpoint = $derived(currentBreakpoint())
  const mobileTabs: { id: MobilePane; icon: typeof FileText; key: 'common.note' | 'common.edit' | 'mobile.view' | 'mobile.account' }[] = [
    { id: 'list', icon: FileText, key: 'common.note' },
    { id: 'editor', icon: PencilLine, key: 'common.edit' },
    { id: 'preview', icon: Eye, key: 'mobile.view' },
    { id: 'account', icon: UserRound, key: 'mobile.account' },
  ]
  const notePane = $derived(ui.mobilePane === 'editor' || ui.mobilePane === 'preview')

  $effect(() => {
    if (breakpoint === 'mobile' && notePane && !ui.activeNoteId) ui.setMobilePane('list')
  })
  function selectMobileTab(pane: MobilePane): void {
    if (pane === 'account') {
      ui.openPanel('settings')
      return
    }
    ui.setMobilePane(pane)
  }

  onMount(() => {
    if (!surface) return
    const registry = createHotkeys({ target: surface })
    hotkeys = registry
    registry.registerAll([
      { id: 'command', combo: 'mod+k', description: () => i18n.t('common.command_palette'), group: () => i18n.t('common.navigation'), allowInInput: true, handler: () => ui.togglePanel('command') },
      { id: 'settings', combo: 'mod+,', description: () => i18n.t('common.open_settings'), group: () => i18n.t('common.interface'), allowInInput: true, handler: () => ui.togglePanel('settings') },
      { id: 'new', combo: 'mod+n', description: () => i18n.t('common.new_note'), group: () => i18n.t('common.navigation'), handler: () => void createNote() },
      { id: 'shortcuts', combo: 'shift+?', description: () => i18n.t('command.keyboard_shortcuts'), group: () => i18n.t('common.interface'), handler: () => ui.togglePanel('shortcuts') },
      ...(extensions.workspacePanel
        ? [{ id: 'assist', combo: 'mod+shift+l', description: () => i18n.t('chat.toggle'), group: () => i18n.t('common.interface'), allowInInput: true, handler: () => ui.toggleAssist() }]
        : []),
    ])
    const unsubscribeIntent = extensions.subscribeIntents?.((intent) => {
      if (intent === 'new-note') void createNote()
    })
    return () => { registry.dispose(); unsubscribeIntent?.() }
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

<div bind:this={surface} class="h-full min-h-0" data-testid="app-shell">
  {#if breakpoint === 'mobile'}
    <div
      class="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)] pt-[env(safe-area-inset-top)]"
    >
      <div class="relative min-h-0 flex-1">
        <div
          aria-hidden={ui.mobilePane !== 'list'}
          inert={ui.mobilePane !== 'list'}
          data-active={ui.mobilePane === 'list' || undefined}
          class="mobile-pane-layer absolute inset-0"
        >
          <NoteList />
        </div>
        <div
          aria-hidden={!notePane}
          inert={!notePane}
          data-active={notePane || undefined}
          data-from="right"
          class="mobile-pane-layer absolute inset-0"
        >
          {#if notePane && ui.activeNoteId}<Workspace />{/if}
        </div>
      </div>
      <nav
        aria-label={i18n.t('shell.mobile_navigation')}
        class="mobile-bottom-nav flex h-[calc(64px+env(safe-area-inset-bottom))] shrink-0 items-stretch justify-around border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] pb-[env(safe-area-inset-bottom)]"
      >
        {#each mobileTabs as tab (tab.id)}
          {@const current = tab.id === 'account' ? ui.panel === 'settings' : ui.mobilePane === tab.id && ui.panel !== 'settings'}
          <button
            type="button"
            disabled={!ui.activeNoteId && (tab.id === 'editor' || tab.id === 'preview')}
            aria-current={current ? 'page' : undefined}
            onclick={() => selectMobileTab(tab.id)}
            class={[
              'flex min-w-0 flex-1 items-center justify-center text-[12px] transition-colors disabled:opacity-40',
              current ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]',
            ]}
          >
            <span class="mobile-tab-content"><tab.icon size={19} /><span>{i18n.t(tab.key as MessageKey)}</span></span>
          </button>
        {/each}
      </nav>
      <Sidebar />
      <AssistDock narrow />
    </div>
  {:else}
    <div class="relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--bg-base)]">
      {#if breakpoint === 'tablet'}
        <div
          class="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3"
        >
          <IconButton
            label={i18n.t('common.navigation')}
            title={i18n.t('common.navigation')}
            onclick={() => ui.toggleNavDrawer(true)}><PanelLeft size={16} /></IconButton
          >
          <div class="w-full max-w-sm"><SearchButton /></div>
        </div>
      {/if}
      <div class="flex min-h-0 min-w-0 flex-1">
        {#if breakpoint === 'desktop'}
          <div
            style:width={`${ui.layout.navCollapsed ? 48 : ui.layout.navWidth}px`}
            class="shrink-0 overflow-hidden transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
          >
            <Sidebar />
          </div>
          {#if !ui.layout.navCollapsed}<Resizer
              label={i18n.t('shell.resize_navigation_panel')}
              value={ui.layout.navWidth}
              min={PANEL_WIDTHS.navigation.min}
              max={PANEL_WIDTHS.navigation.max}
              onChange={(navWidth) => ui.resize({ navWidth })}
              onReset={() => ui.resize({ navWidth: PANEL_WIDTHS.navigation.min })}
            />{/if}
        {:else}
          <Sidebar />
        {/if}
        {#if !ui.layout.listCollapsed}
          <div style:width={`${ui.layout.listWidth}px`} class="anim-view-content shrink-0 overflow-hidden">
            <NoteList />
          </div>
          <Resizer
            label={i18n.t('shell.resize_note_list')}
            value={ui.layout.listWidth}
            min={PANEL_WIDTHS.noteList.min}
            max={PANEL_WIDTHS.noteList.max}
            onChange={(listWidth) => ui.resize({ listWidth })}
            onReset={() => ui.resize({ listWidth: PANEL_WIDTHS.noteList.min })}
          />
        {/if}
        <main class="flex min-w-0 flex-1"><div class="min-w-0 flex-1"><Workspace /></div><AssistDock narrow={false} /></main>
      </div>
    </div>
  {/if}
  {#if ui.panel === 'settings'}<SettingsPanel onClose={() => ui.closePanel()} />{/if}
  {#if ui.panel === 'command' || ui.panel === 'search'}
    <CommandPalette
      {notes}
      {ui}
      {backend}
      {i18n}
      {settings}
      {organize}
      onOpenChange={(open) => {
        if (!open) ui.closePanel()
      }}
    />
  {/if}
  {#if ui.panel === 'shortcuts' && hotkeys}<ShortcutsPanel
      {hotkeys}
      {i18n}
      onOpenChange={(open) => {
        if (!open) ui.closePanel()
      }}
    />{/if}
  {#if ui.panel === 'graph'}<GraphPanel {backend} {ui} {notes} {i18n} onClose={() => ui.closePanel()} />{/if}
  {#if ui.panel === 'share'}<SharePanel onClose={() => ui.closePanel()} />{/if}
</div>
