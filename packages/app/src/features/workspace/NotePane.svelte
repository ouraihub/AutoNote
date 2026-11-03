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
  import { logFailure } from '../../log/logger'
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
  import NotePaneHeader from './NotePaneHeader.svelte'
  import NotePaneFooter from './NotePaneFooter.svelte'
  import { bindReadingPosition, readingPositionKey } from './reading-position'
  import { bindSyncScroll } from './sync-scroll'
  import type { CoalescingPrefsWriter } from '../../state/prefs-writer'
  import '../../editor/editor.css'
  import './note-pane.css'
  import { setTaskAtLine } from '../../editor/commands'
  let {
    pane,
    noteId,
    narrow,
    writer,
  }: {
    pane: WorkspacePane
    noteId: string
    narrow: boolean
    writer: CoalescingPrefsWriter
  } = $props()
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
  let selection = $state<WritingSelection>({
    from: 0,
    to: 0,
    docLength: 0,
    text: '',
    doc: Text.empty,
  })
  let editorGeneration = $state(0)
  $effect.pre(() => {
    void noteId
    untrack(() => (editorGeneration += 1))
  })
  let headings = $state.raw<readonly MarkdownHeading[]>([])
  let preview = $state.raw<HTMLElement | null>(null)
  let fileInput = $state<HTMLInputElement>()
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
  const splitRatio = $derived(ui.layout.splitRatio ?? 0.5)
  const liveState = new SvelteMap<string, string>()
  $effect(() => {
    if (!active || !view) return
    const target = view
    const insert = (text: string): void => {
      const { from, to } = target.state.selection.main
      const block =
        from === target.state.doc.lineAt(from).from ? text : `\n\n${text}`
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
  function writeSuggestion(
    text: string,
    snapshot: WritingSnapshot,
    replace: boolean,
  ): boolean {
    const target = view
    if (
      !active ||
      notes.panes[pane] !== snapshot.noteId ||
      !target ||
      target !== snapshot.view ||
      !target.dom.isConnected ||
      target.compositionStarted ||
      noteId !== snapshot.noteId ||
      editorGeneration !== snapshot.editorGeneration ||
      notes.summaries[noteId]?.rev !== snapshot.revision ||
      notes.summaries[noteId]?.deletedAt !== null ||
      !target.state.doc.eq(snapshot.doc)
    )
      return false
    const from = replace ? snapshot.from : snapshot.cursorOffset
    const to = replace ? snapshot.to : from
    const insert =
      replace || from === target.state.doc.lineAt(from).from
        ? text
        : `\n\n${text}`
    target.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      scrollIntoView: true,
    })
    target.focus()
    return true
  }
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
        if (content !== undefined && at >= 0) {
          const after = content.slice(at + placeholder.length)
          notes.editContent(id, `${content.slice(0, at)}${replacement}${after}`)
        }
      },
    },
  }
  const liveServices: LivePreviewServices = {
    revision: () =>
      JSON.stringify([
        settings.current.preview,
        settings.current.appearance,
        i18n.locale,
      ]),
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
          if (
            editor.state.doc.toString() !== renderedSource ||
            !setTaskAtLine(editor, line + 1, checked)
          )
            throw new Error('Stale task source')
        },
      }
      const collapseLines = settings.current.preview.codeBlockCollapse
        ? settings.current.preview.codeBlockCollapseLines
        : 0
      prepareArticle(root, {
        noteId,
        services: taskServices,
        i18n,
        collapseLines,
        state: liveState,
      })
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
      const themeRoot =
        editor.dom.closest<HTMLElement>('[data-app-root]') ??
        document.documentElement
      void enhancePreview(root, {
        services: taskServices,
        math: settings.current.preview.math,
        mermaid: settings.current.preview.mermaid,
        dark: themeRoot.dataset.theme === 'dark',
        signal: controller.signal,
      })
        .then(() => {
          if (controller.signal.aborted) return
          prepareArticle(root, {
            noteId,
            services: taskServices,
            i18n,
            collapseLines,
            state: liveState,
          })
          editor.requestMeasure()
        })
        .catch((error) =>
          logger.warn('workspace.live.enhance_failed', {
            error: String(error),
          }),
        )
      return () => {
        controller.abort()
        for (const [key, value] of captureArticleState(root))
          liveState.set(key, value)
        dispose()
      }
    },
  }
  function activate(): void {
    if (!active) ui.activatePane(pane)
  }
  function report(error: unknown): void {
    logger.warn('workspace.reading_position.failed', { error: String(error) })
  }
  $effect(() => {
    const currentView = view,
      root = preview
    if (
      layout === 'split' &&
      settings.current.preview.syncScroll &&
      currentView &&
      root
    )
      return bindSyncScroll(currentView, root)
  })
  $effect(() => {
    const scope = ui.scope,
      id = noteId,
      currentView = view
    if (!scope || !currentView || layout === 'preview' || (narrow && !active))
      return
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
      lineCount: () =>
        untrack(() => (notes.contents[id] ?? '').split('\n').length),
      key: readingPositionKey(scope, id),
      prefs,
      writer,
      registerFlush,
      onError: report,
    })
  })
  onDestroy(() => {
    void notes
      .flush(noteId)
      .catch((error) =>
        logger.warn('workspace.flush.failed', { error: String(error) }),
      )
  })
</script>

<section
  class="note-pane"
  class:active
  data-workspace-pane={pane}
  aria-label={i18n.t(
    pane === 'primary'
      ? 'workspace.left_note_pane'
      : 'workspace.right_note_pane',
  )}
  onpointerdowncapture={activate}
  onfocusin={activate}
>
  <NotePaneHeader {pane} {noteId} {narrow} {view} />
  {#if source === undefined}
    <div role="status" aria-busy={!notes.loadErrors[noteId]} class="p-5">
      {notes.loadErrors[noteId]
        ? i18n.t('common.action_failed')
        : i18n.t('workspace.loading_note_content')}
      {#if notes.loadErrors[noteId]}<Button
          variant="outline"
          size="sm"
          onclick={() => notes.open(noteId, pane)}
          >{i18n.t('common.retry')}</Button
        >{/if}
    </div>
  {:else}
    {#if settings.current.editor.showToolbar && layout !== 'preview'}
      <EditorToolbar {view} onPickImage={() => fileInput?.click()} />
    {/if}
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
          onViewReady={(next) => {
            view = next
            untrack(() => (editorGeneration += 1))
          }}
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
            onReplace={(text, snapshot) =>
              writeSuggestion(text, snapshot, true)}
            onInsert={(text, snapshot) =>
              writeSuggestion(text, snapshot, false)}
          />
        {/if}
      </div>
      {#if layout === 'live' && ui.outlineOpen && active && view}<Outline
          {headings}
          scroller={view.scrollDOM}
          onSelect={(heading) => {
            if (!view) return
            view.dispatch({
              selection: {
                anchor: view.state.doc.line(
                  Math.min(view.state.doc.lines, heading.line + 1),
                ).from,
              },
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
      <div
        class="preview-side"
        hidden={layout === 'live'}
        inert={layout === 'live'}
      >
        <Preview
          {noteId}
          {source}
          {pane}
          onReady={(root) => (preview = root)}
        />
      </div>
    </div>
    {#if ui.backlinksOpen && active}<BacklinksPanel
        {noteId}
        {backend}
        {notes}
        {ui}
        {i18n}
        {extensions}
      />{/if}
    <NotePaneFooter {noteId} {narrow} />
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
