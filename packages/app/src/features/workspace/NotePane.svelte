<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import type { EditorView } from '@codemirror/view'
  import type { WorkspacePane } from '../../state/layout-prefs'
  import type { EditorServices } from '../../editor/services'
  import type { LivePreviewServices } from '../../editor/live-preview'
  import type { Heading as MarkdownHeading } from '../../markdown/renderer'
  import { LIMITS } from '@shared/constants'
  import { Star, Link, History, ListTree, X, ArrowLeft, MoreHorizontal } from '@lucide/svelte'
  import { getBackend, getNotes, getUi, getSettings, getI18n, getPrefs, getNotifier, getExtensions, getLogger, getRegisterFlush } from '../../root/context'
  import { Button, buttonVariants } from '../../components/ui/button'
  import { Input } from '../../components/ui/input'
  import * as ToggleGroup from '../../components/ui/toggle-group'
  import * as Menu from '../../components/ui/dropdown-menu'
  import CodeEditor from '../../editor/CodeEditor.svelte'
  import { insertAttachments } from '../../editor/paste'
  import { enhancePreview } from '../../markdown/enhance'
  import { createRenderServices } from '../preview/services'
  import { prepareArticle, bindArticleInteractions, captureArticleState, rememberLightboxFocus, type ArticleState } from '../preview/article'
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

  let { pane, noteId, narrow, writer }: { pane: WorkspacePane; noteId: string; narrow: boolean; writer: CoalescingPrefsWriter } = $props()
  const backend = getBackend(), notes = getNotes(), ui = getUi(), settings = getSettings(), i18n = getI18n(), prefs = getPrefs(), notifier = getNotifier(), extensions = getExtensions(), logger = getLogger()
  const registerFlush = getRegisterFlush()
  let view = $state.raw<EditorView | null>(null)
  let headings = $state.raw<readonly MarkdownHeading[]>([])
  let preview = $state.raw<HTMLElement | null>(null)
  let container = $state<HTMLDivElement>()
  let fileInput = $state<HTMLInputElement>()
  const note = $derived(notes.summaries[noteId])
  const source = $derived(notes.contents[noteId])
  const layout = $derived(narrow ? (ui.mobilePane === 'preview' ? 'preview' : 'live') : ui.panes[pane].layout)
  const active = $derived(ui.activePane === pane)
  const splitRatio = $derived(ui.layout.splitRatio ?? 0.5)
  const liveState: ArticleState = new Map()
  const renderServices = createRenderServices({ backend, notes, ui, notifier, extensions, noteId: () => noteId, source: () => notes.contents[noteId] ?? '', pane: () => pane })
  const services: EditorServices = {
    t: (key, params) => i18n.t(key, params),
    completion: {
      notes: () => Object.values(notes.summaries).filter(item => !item.deletedAt && item.id !== noteId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 300),
      tags: () => notes.readOrganizeSnapshot().tags,
    },
    attachments: {
      upload: (file, id) => backend.files.upload(file, id),
      uploadFailed: () => notifier.toast({ key: 'workspace.upload_failed', tone: 'error' }),
      replaceDetached(id, placeholder, replacement) {
        const content = notes.contents[id]
        const at = content?.indexOf(placeholder) ?? -1
        if (content !== undefined && at >= 0) notes.editContent(id, `${content.slice(0, at)}${replacement}${content.slice(at + placeholder.length)}`)
      },
    },
  }
  const liveServices: LivePreviewServices = {
    revision: () => JSON.stringify([settings.current.preview, settings.current.appearance, i18n.locale]),
    onHeadings: value => { if (headings !== value) headings = value },
    title: () => note?.title ?? '',
    prepare(root, renderedSource, editor) {
      const controller = new AbortController()
      root.title = i18n.t('workspace.live_preview_hint')
      root.dataset.font = settings.current.appearance.proseFont
      const taskServices = { ...renderServices, async toggleTask(line: number, checked: boolean) {
        if (controller.signal.aborted) throw new Error('Detached task source')
        if (editor.state.doc.toString() !== renderedSource || !setTaskAtLine(editor, line + 1, checked)) throw new Error('Stale task source')
      } }
      const collapseLines = settings.current.preview.codeBlockCollapse ? settings.current.preview.codeBlockCollapseLines : 0
      prepareArticle(root, { noteId, services: taskServices, i18n, collapseLines, state: liveState })
      const dispose = bindArticleInteractions(root, { services: taskServices, source: () => editor.state.doc.toString(), renderedSource, i18n, notifier, onImage: image => { rememberLightboxFocus(ui, image); ui.setLightbox({ src: image.src, alt: image.alt }) }, onTag: tag => ui.openView('tag', { tag }) })
      const themeRoot = editor.dom.closest<HTMLElement>('[data-app-root]') ?? document.documentElement
      void enhancePreview(root, { services: taskServices, math: settings.current.preview.math, mermaid: settings.current.preview.mermaid, dark: themeRoot.dataset.theme === 'dark', signal: controller.signal }).then(() => {
        if (controller.signal.aborted) return
        prepareArticle(root, { noteId, services: taskServices, i18n, collapseLines, state: liveState })
        editor.requestMeasure()
      }).catch(error => logger.warn('workspace.live.enhance_failed', { error: String(error) }))
      return () => { controller.abort(); for (const [key, value] of captureArticleState(root)) liveState.set(key, value); dispose() }
    },
  }
  function activate(): void { if (!active) ui.activatePane(pane) }
  function setLayout(value: string): void {
    if (value !== 'live' && value !== 'split' && value !== 'preview') return
    ui.setPaneLayout(pane, value)
    if (narrow) ui.setMobilePane(value === 'preview' ? 'preview' : 'editor')
  }
  function report(error: unknown): void { logger.warn('workspace.reading_position.failed', { error: String(error) }) }
  $effect(() => {
    const currentView = view, root = preview
    if (layout === 'split' && settings.current.preview.syncScroll && currentView && root) return bindSyncScroll(currentView, root)
  })
  $effect(() => {
    const scope = ui.scope, id = noteId, currentView = view
    if (!scope || !currentView || layout === 'preview' || (narrow && !active)) return
    return bindReadingPosition({ scroller: currentView.scrollDOM, view: currentView, lineCount: () => currentView.state.doc.lines, key: readingPositionKey(scope, id), prefs, writer, registerFlush, onError: report })
  })
  $effect(() => {
    const scope = ui.scope, id = noteId, root = preview
    if (!scope || !root || layout !== 'preview' || (narrow && !active)) return
    return bindReadingPosition({ scroller: root, lineCount: () => untrack(() => (notes.contents[id] ?? '').split('\n').length), key: readingPositionKey(scope, id), prefs, writer, registerFlush, onError: report })
  })
  onDestroy(() => { void notes.flush(noteId).catch(error => logger.warn('workspace.flush.failed', { error: String(error) })) })
</script>

<section class="note-pane" class:active data-workspace-pane={pane} aria-label={i18n.t(pane === 'primary' ? 'workspace.left_note_pane' : 'workspace.right_note_pane')} onpointerdowncapture={activate} onfocusin={activate}>
  <header class="pane-header">
    {#if narrow}<Button variant="ghost" size="icon-sm" aria-label={i18n.t('workspace.back_to_notes')} onclick={() => ui.mobileBack()}><ArrowLeft /></Button>{/if}
    <Input class="min-w-20 flex-1 basis-0" type="text" value={note?.title ?? ''} maxlength={LIMITS.titleMaxLength} disabled={source === undefined} readonly={narrow && layout === 'preview'} aria-label={i18n.t('workspace.note_title')} placeholder={i18n.t('common.untitled_note')} oninput={(event) => notes.editTitle(noteId, event.currentTarget.value)} onblur={(event) => notes.editTitle(noteId, event.currentTarget.value.trim())} onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); view?.focus() } }} />
    <ToggleGroup.Root type="single" value={layout} onValueChange={setLayout} size="sm" aria-label={i18n.t('workspace.layout')}>
      <ToggleGroup.Item value="live" aria-label={i18n.t('workspace.live_preview')}>{i18n.t('workspace.live_label')}</ToggleGroup.Item>
      {#if !narrow}<ToggleGroup.Item value="split" aria-label={i18n.t('workspace.split_view')}>{i18n.t('workspace.split_label')}</ToggleGroup.Item>{/if}
      <ToggleGroup.Item value="preview" aria-label={i18n.t('workspace.reading_mode')}>{i18n.t('workspace.preview_label')}</ToggleGroup.Item>
    </ToggleGroup.Root>
    <Menu.Root><Menu.Trigger class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} aria-label={i18n.t('common.more_actions')}><MoreHorizontal /></Menu.Trigger><Menu.Content align="end"><Menu.Group>
      <Menu.Item onSelect={() => { if (note) void notes.patch(noteId, { rev: note.rev, isStarred: !note.isStarred }).catch(() => notifier.toast({ key: 'common.action_failed', tone: 'error' })) }}><Star />{i18n.t(note?.isStarred ? 'common.remove_from_favorites' : 'navigation.favorites')}</Menu.Item>
      <Menu.Item onSelect={() => ui.toggleBacklinks()}><Link />{i18n.t('common.backlinks')}</Menu.Item>
      <Menu.Item onSelect={() => ui.toggleOutline()}><ListTree />{i18n.t('common.outline')}</Menu.Item>
      <Menu.Item onSelect={() => ui.openPanel('versions')}><History />{i18n.t('common.version_history')}</Menu.Item>
      {#if backend.capabilities.share}<Menu.Item onSelect={() => ui.openPanel('share')}>{i18n.t('workspace.share')}</Menu.Item>{/if}
    </Menu.Group></Menu.Content></Menu.Root>
    {#if pane === 'secondary'}<Button variant="ghost" size="icon-sm" aria-label={i18n.t('workspace.close_right_note')} onclick={() => ui.closePane('secondary')}><X /></Button>{/if}
  </header>
  {#if source === undefined}
    <div role="status" aria-busy={!notes.loadErrors[noteId]} class="p-5">{notes.loadErrors[noteId] ? i18n.t('common.action_failed') : i18n.t('workspace.loading_note_content')}
      {#if notes.loadErrors[noteId]}<Button variant="outline" size="sm" onclick={() => notes.open(noteId, pane)}>{i18n.t('common.retry')}</Button>{/if}
    </div>
  {:else}
    {#if settings.current.editor.showToolbar && layout !== 'preview'}<EditorToolbar {view} onPickImage={() => fileInput?.click()} />{/if}
    <div class="pane-content" bind:this={container} data-editor-layout={layout}>
      <div class="editor-side" hidden={layout === 'preview'} inert={layout === 'preview'} style:width={layout === 'split' ? `${splitRatio * 100}%` : layout === 'live' && ui.outlineOpen && active ? 'calc(100% - 168px)' : '100%'}>
        <CodeEditor {noteId} value={source} settings={settings.current.editor} {services} live={layout === 'live'} {liveServices} placeholder={i18n.t('editor.start_writing')} onChange={value => notes.editContent(noteId, value)} onViewReady={next => view = next} />
      </div>
      {#if layout === 'live' && ui.outlineOpen && active && view}<Outline {headings} scroller={view.scrollDOM} onSelect={heading => { if (!view) return; view.dispatch({ selection: { anchor: view.state.doc.line(Math.min(view.state.doc.lines, heading.line + 1)).from }, scrollIntoView: true }); view.focus() }} />{/if}
      {#if layout === 'split'}<SplitResizer {container} ratio={splitRatio} label={i18n.t('workspace.resize_editor_and_preview_panes')} onChange={ratio => ui.resize({ splitRatio: ratio })} onReset={() => ui.resize({ splitRatio: null })} />{/if}
      <div class="preview-side" hidden={layout === 'live'} inert={layout === 'live'}><Preview {noteId} {source} {pane} onReady={root => preview = root} /></div>
    </div>
    {#if ui.backlinksOpen && active}<BacklinksPanel {noteId} {backend} {notes} {ui} {i18n} {extensions} />{/if}
    <footer class="pane-footer">
      <span>{note?.wordCount ?? 0}{i18n.t('common.words')}</span><span>{source.length}{i18n.t('workspace.characters')}</span>
      <span class="save-status" role="status" data-save-state={notes.saveState[noteId] ?? 'idle'}>{i18n.t(notes.saveState[noteId] === 'failed' ? 'common.save_failed' : notes.saveState[noteId] === 'persisting' ? 'shell.saving' : notes.saveState[noteId] === 'saved-local' ? 'shell.offline_changes_are_saved_locally' : notes.dirtyById[noteId] ? 'shell.unsaved_changes' : 'shell.synced')}</span>
      {#if notes.saveState[noteId] === 'failed'}<Button variant="ghost" size="sm" onclick={() => notes.flush(noteId)}>{i18n.t('common.retry')}</Button>{/if}
    </footer>
  {/if}
  <input bind:this={fileInput} hidden type="file" accept="image/*" multiple onchange={(event) => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ''; if (view && files.length) void insertAttachments(view, files) }} />
</section>

<style>
  .note-pane { display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; min-height: 0; background: var(--bg-editor); }
  .active { box-shadow: inset 0 2px var(--accent); }
  .pane-header { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; flex-shrink: 0; min-height: 44px; padding: 4px 8px; border-bottom: 1px solid var(--border-subtle); }
  .pane-content { display: flex; flex: 1; min-height: 0; min-width: 0; overflow: hidden; }
  .editor-side { min-height: 0; min-width: 0; flex-shrink: 0; }
  .preview-side { flex: 1; display: flex; min-height: 0; min-width: 0; overflow: hidden; }
  .editor-side[hidden], .preview-side[hidden] { display: none; }
  .pane-footer { display: flex; flex-shrink: 0; align-items: center; gap: 8px; padding: 4px 10px; border-top: 1px solid var(--border-subtle); color: var(--text-tertiary); font-size: 11px; }
  .save-status { margin-left: auto; }
</style>
