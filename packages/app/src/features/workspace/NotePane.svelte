<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import { Text } from '@codemirror/state'
  import type { EditorView } from '@codemirror/view'
  import type { WritingSelection, WritingSnapshot } from '../../root/types'
  import type { WorkspacePane } from '../../state/layout-prefs'
  import type { EditorServices } from '../../editor/services'
  import type { LivePreviewServices } from '../../editor/live-preview'
  import type { Heading as MarkdownHeading } from '../../markdown/renderer'
  import { LIMITS } from '@shared/constants'
  import { logFailure } from '../../log/logger'
  import { readingMinutes } from '@shared/markdown-utils'
  import { organizerColorOrNull } from '@shared/organizer-colors'
  import { folderPath } from '../../state/selectors'
  import {
    ArrowLeft,
    Columns2,
    Eye,
    FolderClosed,
    Hash,
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
  import type { MessageKey } from '@shared/locales/en-US'
  import {
    getBackend,
    getNotes,
    getUi,
    getSettings,
    getI18n,
    getPrefs,
    getNotifier,
    getExtensions,
    getLogger,
    getRegisterFlush,
  } from '../../root/context'
  import { Button } from '../../components/ui/button'
  import * as Menu from '../../components/ui/dropdown-menu'
  import IconButton from '../../components/primitives/IconButton.svelte'
  import Segmented from '../../components/primitives/Segmented.svelte'
  import CodeEditor from '../../editor/CodeEditor.svelte'
  import { insertAttachments } from '../../editor/paste'
  import { enhancePreview } from '../../markdown/enhance'
  import { createRenderServices } from '../preview/services'
  import {
    prepareArticle,
    bindArticleInteractions,
    captureArticleState,
    rememberLightboxFocus,
  } from '../preview/article'
  import Preview from '../preview/Preview.svelte'
  import Outline from '../preview/Outline.svelte'
  import BacklinksPanel from './BacklinksPanel.svelte'
  import EditorToolbar from './EditorToolbar.svelte'
  import SplitResizer from './SplitResizer.svelte'
  import { bindReadingPosition, readingPositionKey } from './reading-position'
  import { bindSyncScroll } from './sync-scroll'
  import type { CoalescingPrefsWriter } from '../../state/prefs-writer'
  import '../../editor/editor.css'
  import { setTaskAtLine } from '../../editor/commands'

  let {
    pane,
    noteId,
    narrow,
    writer,
  }: { pane: WorkspacePane; noteId: string; narrow: boolean; writer: CoalescingPrefsWriter } = $props()
  const backend = getBackend(),
    notes = getNotes(),
    ui = getUi(),
    settings = getSettings(),
    i18n = getI18n(),
    prefs = getPrefs(),
    notifier = getNotifier(),
    extensions = getExtensions(),
    logger = getLogger()
  const registerFlush = getRegisterFlush()
  let view = $state.raw<EditorView | null>(null)
  let selection = $state<WritingSelection>({ from: 0, to: 0, docLength: 0, text: '', doc: Text.empty })
  let editorGeneration = $state(0)
  $effect.pre(() => {
    void noteId
    untrack(() => editorGeneration += 1)
  })
  let headings = $state.raw<readonly MarkdownHeading[]>([])
  let preview = $state.raw<HTMLElement | null>(null)
  let fileInput = $state<HTMLInputElement>()
  const note = $derived(notes.summaries[noteId])
  const source = $derived(notes.contents[noteId])
  const layout = $derived(narrow ? (ui.mobilePane === 'preview' ? 'preview' : 'live') : ui.panes[pane].layout)
  const active = $derived(ui.activePane === pane)
  const splitRatio = $derived(ui.layout.splitRatio ?? 0.5)
  const assist = extensions.workspacePanel
  $effect(() => {
    if (!active || !view) return
    const target = view
    const insert = (text: string): void => {
      const { from, to } = target.state.selection.main
      const block = from === target.state.doc.lineAt(from).from ? text : `\n\n${text}`
      target.dispatch({
        changes: { from, to, insert: block },
        selection: { anchor: from + block.length },
        scrollIntoView: true,
      })
      target.focus()
    }
    ui.insertAtCursor = insert
    return () => {
      if (ui.insertAtCursor === insert) ui.insertAtCursor = null
    }
  })
  function writeSuggestion(text: string, snapshot: WritingSnapshot, replace: boolean): boolean {
    const target = view
    if (!active || notes.panes[pane] !== snapshot.noteId || !target || target !== snapshot.view || !target.dom.isConnected || target.compositionStarted ||
        noteId !== snapshot.noteId || editorGeneration !== snapshot.editorGeneration || notes.summaries[noteId]?.rev !== snapshot.revision ||
        notes.summaries[noteId]?.deletedAt !== null || !target.state.doc.eq(snapshot.doc)) return false
    const from = replace ? snapshot.from : snapshot.cursorOffset
    const to = replace ? snapshot.to : from
    const insert = replace || from === target.state.doc.lineAt(from).from ? text : `\n\n${text}`
    target.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, scrollIntoView: true })
    target.focus()
    return true
  }
  const folders = $derived(notes.readOrganizeSnapshot().folders)
  const noteFolder = $derived(note?.folderId ? folders.find((folder) => folder.id === note.folderId) : undefined)
  const folderLabel = $derived(
    noteFolder
      ? folderPath(folders, noteFolder.id)
          .map((folder) => folder.name)
          .join(' / ')
      : '',
  )
  const liveState = new SvelteMap<string, string>()
  const renderServices = createRenderServices({
    backend,
    notes,
    ui,
    notifier,
    extensions,
    noteId: () => noteId,
    source: () => notes.contents[noteId] ?? '',
    pane: () => pane,
  })
  const services: EditorServices = {
    t: (key, params) => i18n.t(key, params),
    completion: {
      notes: () =>
        Object.values(notes.summaries)
          .filter((item) => !item.deletedAt && item.id !== noteId)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 300),
      tags: () => notes.readOrganizeSnapshot().tags,
    },
    attachments: {
      upload: (file, id) => backend.files.upload(file, id),
      uploadFailed: (_file, error) => {
        logFailure(logger, 'files.upload.failed', error)
        notifier.toast({ key: 'workspace.upload_failed', tone: 'error' })
      },
      replaceDetached(id, placeholder, replacement) {
        const content = notes.contents[id]
        const at = content?.indexOf(placeholder) ?? -1
        if (content !== undefined && at >= 0)
          notes.editContent(id, `${content.slice(0, at)}${replacement}${content.slice(at + placeholder.length)}`)
      },
    },
  }
  const liveServices: LivePreviewServices = {
    revision: () => JSON.stringify([settings.current.preview, settings.current.appearance, i18n.locale]),
    onHeadings: (value) => {
      if (headings !== value) headings = value
    },
    title: () => note?.title ?? '',
    prepare(root, renderedSource, editor) {
      const controller = new AbortController()
      root.title = i18n.t('workspace.live_preview_hint')
      root.dataset.font = settings.current.appearance.proseFont
      const taskServices = {
        ...renderServices,
        async toggleTask(line: number, checked: boolean) {
          if (controller.signal.aborted) throw new Error('Detached task source')
          if (editor.state.doc.toString() !== renderedSource || !setTaskAtLine(editor, line + 1, checked))
            throw new Error('Stale task source')
        },
      }
      const collapseLines = settings.current.preview.codeBlockCollapse
        ? settings.current.preview.codeBlockCollapseLines
        : 0
      prepareArticle(root, { noteId, services: taskServices, i18n, collapseLines, state: liveState })
      const dispose = bindArticleInteractions(root, {
        services: taskServices,
        source: () => editor.state.doc.toString(),
        renderedSource,
        i18n,
        notifier,
        onImage: (image) => {
          rememberLightboxFocus(ui, image)
          ui.setLightbox({ src: image.src, alt: image.alt })
        },
        onTag: (tag) => ui.openView('tag', { tag }),
      })
      const themeRoot = editor.dom.closest<HTMLElement>('[data-app-root]') ?? document.documentElement
      void enhancePreview(root, {
        services: taskServices,
        math: settings.current.preview.math,
        mermaid: settings.current.preview.mermaid,
        dark: themeRoot.dataset.theme === 'dark',
        signal: controller.signal,
      })
        .then(() => {
          if (controller.signal.aborted) return
          prepareArticle(root, { noteId, services: taskServices, i18n, collapseLines, state: liveState })
          editor.requestMeasure()
        })
        .catch((error) => logger.warn('workspace.live.enhance_failed', { error: String(error) }))
      return () => {
        controller.abort()
        for (const [key, value] of captureArticleState(root)) liveState.set(key, value)
        dispose()
      }
    },
  }
  function activate(): void {
    if (!active) ui.activatePane(pane)
  }
  function setLayout(value: string): void {
    if (value !== 'live' && value !== 'split' && value !== 'preview') return
    ui.setPaneLayout(pane, value)
    if (narrow) ui.setMobilePane(value === 'preview' ? 'preview' : 'editor')
  }
  function toggleStar(): void {
    if (!note) return
    void notes
      .patch(noteId, { rev: note.rev, isStarred: !note.isStarred })
      .catch(() => notifier.toast({ key: 'common.action_failed', tone: 'error' }))
  }
  function report(error: unknown): void {
    logger.warn('workspace.reading_position.failed', { error: String(error) })
  }
  $effect(() => {
    const currentView = view,
      root = preview
    if (layout === 'split' && settings.current.preview.syncScroll && currentView && root)
      return bindSyncScroll(currentView, root)
  })
  $effect(() => {
    const scope = ui.scope,
      id = noteId,
      currentView = view
    if (!scope || !currentView || layout === 'preview' || (narrow && !active)) return
    return bindReadingPosition({
      scroller: currentView.scrollDOM,
      view: currentView,
      lineCount: () => currentView.state.doc.lines,
      key: readingPositionKey(scope, id),
      prefs,
      writer,
      registerFlush,
      onError: report,
    })
  })
  $effect(() => {
    const scope = ui.scope,
      id = noteId,
      root = preview
    if (!scope || !root || layout !== 'preview' || (narrow && !active)) return
    return bindReadingPosition({
      scroller: root,
      lineCount: () => untrack(() => (notes.contents[id] ?? '').split('\n').length),
      key: readingPositionKey(scope, id),
      prefs,
      writer,
      registerFlush,
      onError: report,
    })
  })
  onDestroy(() => {
    void notes.flush(noteId).catch((error) => logger.warn('workspace.flush.failed', { error: String(error) }))
  })
</script>

<section
  class="note-pane"
  class:active
  data-workspace-pane={pane}
  aria-label={i18n.t(pane === 'primary' ? 'workspace.left_note_pane' : 'workspace.right_note_pane')}
  onpointerdowncapture={activate}
  onfocusin={activate}
>
  <header class="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
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
        class="h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-[14px] font-semibold tracking-[-0.01em] text-[var(--text-primary)] outline-none transition-colors placeholder:font-medium placeholder:text-[var(--text-quaternary)] hover:border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)]"
        oninput={(event) => notes.editTitle(noteId, event.currentTarget.value)}
        onblur={(event) => notes.editTitle(noteId, event.currentTarget.value.trim())}
        onkeydown={(event) => {
          if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault()
            view?.focus()
          }
        }}
      />
      {#if note?.isStarred}<Star size={11} class="shrink-0 fill-current text-[var(--warning)]" />{/if}
    </div>
    <div class="flex shrink-0 items-center gap-0.5">
      {#if !narrow}<div class={ui.isSplit ? 'mr-1 hidden 2xl:block' : 'mr-1'}>
          <Segmented
            label={i18n.t('workspace.layout')}
            size="sm"
            value={layout}
            onChange={setLayout}
            options={[
              { value: 'live', icon: Pencil, title: i18n.t('workspace.live_preview') },
              { value: 'split', icon: Columns2, title: i18n.t('workspace.split_view') },
              { value: 'preview', icon: Eye, title: i18n.t('workspace.reading_mode') },
            ]}
          />
        </div>{/if}
      {#if !narrow && !ui.isSplit}
        <IconButton
          label={i18n.t(note?.isStarred ? 'common.remove_from_favorites' : 'navigation.favorites')}
          title={i18n.t(note?.isStarred ? 'common.remove_from_favorites' : 'navigation.favorites')}
          size="sm"
          active={note?.isStarred ?? false}
          onclick={toggleStar}><Star size={14} class={note?.isStarred ? 'fill-current' : undefined} /></IconButton
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
          onclick={() => ui.openPanel('versions')}><History size={14} /></IconButton
        >
        <IconButton
          label={i18n.t('common.outline')}
          title={i18n.t('common.outline')}
          size="sm"
          active={ui.outlineOpen && active}
          onclick={() => ui.toggleOutline()}
          >{#if ui.outlineOpen && active}<PanelRightClose size={14} />{:else}<ListTree size={14} />{/if}</IconButton
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
            onclick={() => ui.toggleAssist()}><assist.icon size={14} /></IconButton
          >{/if}
      {:else}
        <Menu.Root
          ><Menu.Trigger
            title={i18n.t('common.more_actions')}
            class="inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--r-md)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:size-6"
            aria-label={i18n.t('common.more_actions')}><MoreHorizontal size={16} /></Menu.Trigger
          ><Menu.Content align="end"
            ><Menu.Group>
              <Menu.Item onSelect={toggleStar}
                ><Star size={13} />{i18n.t(
                  note?.isStarred ? 'common.remove_from_favorites' : 'navigation.favorites',
                )}</Menu.Item
              >
              <Menu.Item onSelect={() => ui.toggleBacklinks()}><Link size={13} />{i18n.t('common.backlinks')}</Menu.Item
              >
              <Menu.Item onSelect={() => ui.toggleOutline()}><ListTree size={13} />{i18n.t('common.outline')}</Menu.Item
              >
              <Menu.Item onSelect={() => ui.openPanel('versions')}
                ><History size={13} />{i18n.t('common.version_history')}</Menu.Item
              >
              {#if backend.capabilities.share}<Menu.Item onSelect={() => ui.openPanel('share')}
                  ><Share2 size={13} />{i18n.t('workspace.share')}</Menu.Item
                >{/if}
              {#if assist}<Menu.Item onSelect={() => ui.toggleAssist()}
                  ><assist.icon size={13} />{i18n.t(assist.titleKey as MessageKey)}</Menu.Item
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
  {#if source === undefined}
    <div role="status" aria-busy={!notes.loadErrors[noteId]} class="p-5">
      {notes.loadErrors[noteId] ? i18n.t('common.action_failed') : i18n.t('workspace.loading_note_content')}
      {#if notes.loadErrors[noteId]}<Button variant="outline" size="sm" onclick={() => notes.open(noteId, pane)}
          >{i18n.t('common.retry')}</Button
        >{/if}
    </div>
  {:else}
    {#if settings.current.editor.showToolbar && layout !== 'preview'}<EditorToolbar
        {view}
        onPickImage={() => fileInput?.click()}
      />{/if}
    <div class="pane-content" data-editor-layout={layout}>
      <div
        class="editor-side"
        hidden={layout === 'preview'}
        inert={layout === 'preview'}
        style:width={layout === 'split'
          ? `${splitRatio * 100}%`
          : layout === 'live' && ui.outlineOpen && active
            ? 'calc(100% - 168px)'
            : '100%'}
      >
        <CodeEditor
          {noteId}
          value={source}
          settings={settings.current.editor}
          {services}
          live={layout === 'live'}
          {liveServices}
          placeholder={i18n.t('editor.start_writing')}
          onChange={(value) => notes.editContent(noteId, value)}
          onViewReady={(next) => { view = next; untrack(() => editorGeneration += 1) }}
          onSelectionChange={(next) => (selection = next)}
        />
        {#if extensions.writingToolbar && view}
          {@const WritingToolbar = extensions.writingToolbar.component}
          <WritingToolbar
            {view}
            {selection}
            {noteId}
            noteTitle={note?.title ?? ''}
            noteRev={note?.rev ?? 0}
            {editorGeneration}
            onReplace={(text, snapshot) => writeSuggestion(text, snapshot, true)}
            onInsert={(text, snapshot) => writeSuggestion(text, snapshot, false)}
          />
        {/if}
      </div>
      {#if layout === 'live' && ui.outlineOpen && active && view}<Outline
          {headings}
          scroller={view.scrollDOM}
          onSelect={(heading) => {
            if (!view) return
            view.dispatch({
              selection: { anchor: view.state.doc.line(Math.min(view.state.doc.lines, heading.line + 1)).from },
              scrollIntoView: true,
            })
            view.focus()
          }}
        />{/if}
      {#if layout === 'split'}<SplitResizer
          ratio={splitRatio}
          label={i18n.t('workspace.resize_editor_and_preview_panes')}
          onChange={(ratio) => ui.resize({ splitRatio: ratio })}
          onReset={() => ui.resize({ splitRatio: null })}
        />{/if}
      <div class="preview-side" hidden={layout === 'live'} inert={layout === 'live'}>
        <Preview {noteId} {source} {pane} onReady={(root) => (preview = root)} />
      </div>
    </div>
    {#if ui.backlinksOpen && active}<BacklinksPanel {noteId} {backend} {notes} {ui} {i18n} {extensions} />{/if}
    <footer
      class="flex h-[var(--statusbar-h)] shrink-0 items-center gap-2 overflow-hidden border-t border-[var(--border-subtle)] px-3 text-[11px] text-[var(--text-quaternary)]"
    >
      <span class="tabular">{note?.wordCount ?? 0}{i18n.t('common.words')}</span>
      <span class="tabular hidden sm:inline">{source.length}{i18n.t('workspace.characters')}</span>
      <span class="tabular hidden md:inline"
        >{i18n.t('common.about')}{readingMinutes(note?.wordCount ?? 0)}{i18n.t('common.min')}</span
      >
      {#if noteFolder}<button
          type="button"
          title={folderLabel}
          onclick={() => ui.openView('folder', { folderId: noteFolder.id })}
          class="inline-flex max-w-40 min-w-0 items-center gap-1 truncate rounded px-1 py-0.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] md:max-w-48"
          ><FolderClosed
            size={11}
            class="shrink-0"
            style={`color: ${organizerColorOrNull(noteFolder.color) ?? 'inherit'}`}
          /><span class="truncate">{folderLabel}</span></button
        >{/if}
      {#if note?.tags.length}<span class="flex min-w-0 items-center gap-0.5 overflow-hidden">
          {#each note.tags.slice(0, narrow ? 2 : 4) as tag (tag)}<button
              type="button"
              onclick={() => ui.openView('tag', { tag })}
              class="inline-flex min-w-0 items-center gap-0.5 rounded px-1 py-0.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]"
              ><Hash size={9} class="shrink-0" /><span class="truncate">{tag}</span></button
            >{/each}
        </span>{/if}
      <span class="flex-1"></span>
      <span
        role="status"
        data-save-state={notes.saveState[noteId] ?? 'idle'}
        class={notes.saveState[noteId] === 'failed' ? 'text-[var(--danger)]' : undefined}
        >{i18n.t(
          notes.saveState[noteId] === 'failed'
            ? 'common.save_failed'
            : notes.saveState[noteId] === 'persisting'
              ? 'shell.saving'
              : notes.saveState[noteId] === 'saved-local'
                ? 'shell.offline_changes_are_saved_locally'
                : notes.dirtyById[noteId]
                  ? 'shell.unsaved_changes'
                  : 'shell.synced',
        )}</span
      >
      {#if notes.saveState[noteId] === 'failed'}<button
          type="button"
          onclick={() => notes.flush(noteId)}
          class="rounded px-1 py-0.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]"
          >{i18n.t('common.retry')}</button
        >{/if}
    </footer>
  {/if}
  <input
    bind:this={fileInput}
    hidden
    type="file"
    accept="image/*"
    multiple
    onchange={(event) => {
      const files = [...(event.currentTarget.files ?? [])]
      event.currentTarget.value = ''
      if (view && files.length) void insertAttachments(view, files)
    }}
  />
</section>

<style>
  .note-pane {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    background: var(--bg-editor);
  }
  .active {
    box-shadow: inset 0 2px var(--accent);
  }

  .pane-content {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  .editor-side {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    flex-shrink: 0;
  }
  .editor-side > :global(.ink-editor) {
    flex: 1;
    min-height: 0;
    height: auto;
  }
  .preview-side {
    flex: 1;
    display: flex;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  .editor-side[hidden],
  .preview-side[hidden] {
    display: none;
  }
</style>
