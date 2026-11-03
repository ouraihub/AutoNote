<script lang="ts">
  import type { EditorView } from '@codemirror/view'
  import { LIMITS } from '@shared/constants'
  import type { MessageKey } from '@shared/locales/en-US'
  import {
    ArrowLeft,
    Columns2,
    Eye,
    History,
    Link,
    ListTree,
    MoreHorizontal,
    PanelRightClose,
    Pencil,
    Share2,
    Star,
    X,
  } from '@lucide/svelte'
  import type { WorkspacePane } from '../../state/layout-prefs'
  import {
    getBackend,
    getExtensions,
    getI18n,
    getNotes,
    getNotifier,
    getUi,
  } from '../../root/context'
  import IconButton from '../../components/primitives/IconButton.svelte'
  import Segmented from '../../components/primitives/Segmented.svelte'
  import * as Menu from '../../components/ui/dropdown-menu'

  let {
    pane,
    noteId,
    narrow,
    view,
  }: {
    pane: WorkspacePane
    noteId: string
    narrow: boolean
    view: EditorView | null
  } = $props()
  const backend = getBackend()
  const notes = getNotes()
  const ui = getUi()
  const i18n = getI18n()
  const extensions = getExtensions()
  const notifier = getNotifier()
  const note = $derived(notes.summaries[noteId])
  const source = $derived(notes.contents[noteId])
  const layout = $derived(
    narrow
      ? ui.mobilePane === 'preview'
        ? 'preview'
        : 'live'
      : ui.panes[pane].layout,
  )
  const active = $derived(ui.activePane === pane)
  const assist = extensions.workspacePanel

  function setLayout(value: string): void {
    if (value !== 'live' && value !== 'split' && value !== 'preview') return
    ui.setPaneLayout(pane, value)
    if (narrow) ui.setMobilePane(value === 'preview' ? 'preview' : 'editor')
  }

  function toggleStar(): void {
    if (!note) return
    void notes
      .patch(noteId, { rev: note.rev, isStarred: !note.isStarred })
      .catch(() =>
        notifier.toast({ key: 'common.action_failed', tone: 'error' }),
      )
  }
</script>

<header
  class="flex h-11 shrink-0 items-center gap-2 border-b
    border-[var(--border-subtle)] px-3"
>
  {#if narrow}<IconButton
      label={i18n.t('workspace.back_to_notes')}
      title={i18n.t('workspace.back_to_notes')}
      size="sm"
      onclick={() => ui.mobileBack()}><ArrowLeft size={16} /></IconButton
    >{/if}
  <div class="flex min-w-0 flex-1 items-center gap-1">
    <input
      type="text"
      value={note?.title ?? ''}
      maxlength={LIMITS.titleMaxLength}
      disabled={source === undefined}
      readonly={narrow && layout === 'preview'}
      aria-label={i18n.t('workspace.note_title')}
      placeholder={i18n.t('common.untitled_note')}
      class="h-8 min-w-0 flex-1 rounded-md border border-transparent
        bg-transparent px-2 text-[14px] font-semibold tracking-[-0.01em]
        text-[var(--text-primary)] outline-none transition-colors
        placeholder:font-medium placeholder:text-[var(--text-quaternary)]
        hover:border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]
        focus:border-[var(--accent)] focus:bg-[var(--bg-surface)]"
      oninput={(event) => notes.editTitle(noteId, event.currentTarget.value)}
      onblur={(event) =>
        notes.editTitle(noteId, event.currentTarget.value.trim())}
      onkeydown={(event) => {
        if (
          event.key === 'Enter' &&
          !event.isComposing &&
          event.keyCode !== 229
        ) {
          event.preventDefault()
          view?.focus()
        }
      }}
    />
    {#if note?.isStarred}<Star
        size={11}
        class="shrink-0 fill-current text-[var(--warning)]"
      />{/if}
  </div>
  <div class="flex shrink-0 items-center gap-0.5">
    {#if !narrow}<div class={ui.isSplit ? 'mr-1 hidden 2xl:block' : 'mr-1'}>
        <Segmented
          label={i18n.t('workspace.layout')}
          size="sm"
          value={layout}
          onChange={setLayout}
          options={[
            {
              value: 'live',
              icon: Pencil,
              title: i18n.t('workspace.live_preview'),
            },
            {
              value: 'split',
              icon: Columns2,
              title: i18n.t('workspace.split_view'),
            },
            {
              value: 'preview',
              icon: Eye,
              title: i18n.t('workspace.reading_mode'),
            },
          ]}
        />
      </div>{/if}
    {#if !narrow && !ui.isSplit}
      <IconButton
        label={i18n.t(
          note?.isStarred
            ? 'common.remove_from_favorites'
            : 'navigation.favorites',
        )}
        title={i18n.t(
          note?.isStarred
            ? 'common.remove_from_favorites'
            : 'navigation.favorites',
        )}
        size="sm"
        active={note?.isStarred ?? false}
        onclick={toggleStar}
        ><Star
          size={14}
          class={note?.isStarred ? 'fill-current' : undefined}
        /></IconButton
      >
      <IconButton
        label={i18n.t('common.backlinks')}
        title={i18n.t('common.backlinks')}
        size="sm"
        active={ui.backlinksOpen && active}
        onclick={() => ui.toggleBacklinks()}><Link size={14} /></IconButton
      >
      <IconButton
        label={i18n.t('common.version_history')}
        title={i18n.t('common.version_history')}
        size="sm"
        onclick={() => ui.openPanel('versions')}
        ><History size={14} /></IconButton
      >
      <IconButton
        label={i18n.t('common.outline')}
        title={i18n.t('common.outline')}
        size="sm"
        active={ui.outlineOpen && active}
        onclick={() => ui.toggleOutline()}
        >{#if ui.outlineOpen && active}<PanelRightClose
            size={14}
          />{:else}<ListTree size={14} />{/if}</IconButton
      >
      {#if backend.capabilities.share}<IconButton
          label={i18n.t('workspace.share')}
          title={i18n.t('workspace.share')}
          size="sm"
          onclick={() => ui.openPanel('share')}><Share2 size={14} /></IconButton
        >{/if}
      {#if assist}<IconButton
          label={i18n.t(assist.titleKey as MessageKey)}
          title={i18n.t(assist.titleKey as MessageKey)}
          size="sm"
          active={ui.layout.assistOpen}
          onclick={() => ui.toggleAssist()}
          ><assist.icon size={14} /></IconButton
        >{/if}
    {:else}
      <Menu.Root
        ><Menu.Trigger
          title={i18n.t('common.more_actions')}
          class="inline-flex size-8 shrink-0 items-center justify-center
            rounded-[var(--r-md)] text-[var(--text-secondary)] transition-colors
            hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]
            md:size-6"
          aria-label={i18n.t('common.more_actions')}
          ><MoreHorizontal size={16} /></Menu.Trigger
        ><Menu.Content align="end"
          ><Menu.Group>
            <Menu.Item onSelect={toggleStar}
              ><Star size={13} />{i18n.t(
                note?.isStarred
                  ? 'common.remove_from_favorites'
                  : 'navigation.favorites',
              )}</Menu.Item
            >
            <Menu.Item onSelect={() => ui.toggleBacklinks()}
              ><Link size={13} />{i18n.t('common.backlinks')}</Menu.Item
            >
            <Menu.Item onSelect={() => ui.toggleOutline()}
              ><ListTree size={13} />{i18n.t('common.outline')}</Menu.Item
            >
            <Menu.Item onSelect={() => ui.openPanel('versions')}
              ><History size={13} />{i18n.t(
                'common.version_history',
              )}</Menu.Item
            >
            {#if backend.capabilities.share}<Menu.Item
                onSelect={() => ui.openPanel('share')}
                ><Share2 size={13} />{i18n.t('workspace.share')}</Menu.Item
              >{/if}
            {#if assist}<Menu.Item onSelect={() => ui.toggleAssist()}
                ><assist.icon size={13} />{i18n.t(
                  assist.titleKey as MessageKey,
                )}</Menu.Item
              >{/if}
          </Menu.Group></Menu.Content
        ></Menu.Root
      >
    {/if}
    {#if pane === 'secondary'}<IconButton
        label={i18n.t('workspace.close_right_note')}
        title={i18n.t('workspace.close_right_note')}
        size="sm"
        onclick={() => ui.closePane('secondary')}><X size={15} /></IconButton
      >{/if}
  </div>
</header>
