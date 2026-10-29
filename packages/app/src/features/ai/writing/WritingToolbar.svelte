<script lang="ts">
  import { Copy, FileInput, Sparkles, Square, WandSparkles } from '@lucide/svelte'
  import { onDestroy, untrack } from 'svelte'
  import Button from '@app/components/primitives/Button.svelte'
  import Modal from '@app/components/primitives/Modal.svelte'
  import { getBackend, getI18n, getLogger } from '@app/root/context'
  import type { WritingSnapshot, WritingToolbarProps } from '@app/root/types'
  import { KitClientError, type KitErrorCode, type RunEvent } from '@ouraihub/aether-ui/ports'
  import { KIT_ERROR_KEYS } from '../kit'

  type WriteAction = 'polish' | 'rewrite' | 'shorten' | 'expand' | 'continue'

  let { view, selection, noteId, noteTitle, noteRev, editorGeneration, onReplace, onInsert }: WritingToolbarProps = $props()
  const i18n = getI18n()
  const logger = getLogger()
  const ai = getBackend().aiHost
  const chat = ai?.kit.chat
  function fail(code: KitErrorCode): void {
    logger.warn('ai.write.failed', { code })
    error = i18n.t(KIT_ERROR_KEYS[code] ?? 'common.action_failed')
  }
  const MAX_SELECTED_BYTES = 8_000
  const MAX_CONTEXT_BYTES = 8_000
  const MAX_TOTAL_BYTES = 24_000
  let open = $state(false)
  let generating = $state(false)
  let preview = $state('')
  let fallback = $state(false)
  let error = $state<string | null>(null)
  let abort = $state<AbortController | null>(null)
  let requestSnapshot = $state.raw<WritingSnapshot | null>(null)
  let alive = true
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  function bounded(value: string, maxBytes: number, rejectOversized = false): string | null {
    const bytes = new Uint8Array(maxBytes)
    const { read, written } = encoder.encodeInto(value, bytes)
    if (rejectOversized && read !== value.length) return null
    return decoder.decode(bytes.subarray(0, written))
  }
  function cancel(): void {
    abort?.abort()
    abort = null
    generating = false
  }
  $effect.pre(() => {
    void noteId
    void view
    void editorGeneration
    untrack(cancel)
  })
  onDestroy(() => { alive = false; cancel() })
  const hasSelection = $derived(selection.from !== selection.to && selection.text.length > 0)
  const label = $derived(hasSelection ? selection.text.slice(0, 28) : i18n.t('writing.continue'))
  const context = $derived(view ? view.state.sliceDoc(Math.max(0, selection.from - 1000), Math.min(view.state.doc.length, selection.to + 1000)) : '')
  const canRun = (next: WriteAction): boolean => (next === 'continue' ? context.trim().length > 0 : hasSelection)

  async function run(next: WriteAction): Promise<void> {
    if (!ai || !chat || generating || !canRun(next) || !view || !view.dom.isConnected || view.compositionStarted || view.composing) return
    const target = view
    const { from, to, head } = target.state.selection.main
    const snapshot: WritingSnapshot = {
      from, to, cursorOffset: head, docLength: target.state.doc.length,
      text: target.state.sliceDoc(from, to), doc: target.state.doc,
      noteId, view: target, editorGeneration, revision: noteRev,
    }
    const selectedText = bounded(snapshot.text, MAX_SELECTED_BYTES, true)
    if (selectedText === null) {
      error = i18n.t('api.error.payload_too_large')
      open = true
      return
    }
    requestSnapshot = snapshot
    let beforeStart = Math.max(0, from - 1000)
    let afterEnd = Math.min(snapshot.docLength, to + 1000)
    if (beforeStart > 0 && /[\uDC00-\uDFFF]/.test(target.state.sliceDoc(beforeStart, beforeStart + 1))) beforeStart -= 1
    if (afterEnd < snapshot.docLength && /[\uD800-\uDBFF]/.test(target.state.sliceDoc(afterEnd - 1, afterEnd))) afterEnd += 1
    const beforeText = bounded(target.state.sliceDoc(beforeStart, from), MAX_CONTEXT_BYTES)!
    const remaining = MAX_TOTAL_BYTES - encoder.encode(selectedText).length - encoder.encode(beforeText).length
    const afterText = remaining > 0 ? bounded(target.state.sliceDoc(to, afterEnd), Math.min(MAX_CONTEXT_BYTES, remaining))! : ''
    preview = ''
    error = null
    fallback = false
    open = true
    generating = true
    const controller = new AbortController()
    abort = controller
    const current = (): boolean => alive && abort === controller && noteId === snapshot.noteId &&
      view === snapshot.view && editorGeneration === snapshot.editorGeneration
    void ai.roles({ signal: controller.signal }).then((roles) => {
      if (current()) fallback = roles.some((role) => role.role === 'writing' && role.isFallback)
    }).catch(() => {})
    const ended = Promise.withResolvers<Extract<RunEvent, { kind: 'end' }>>()
    try {
      await chat.start(
        {
          purpose: 'writing',
          model: null,
          skills: [],
          permissionMode: 'default',
          context: { kind: 'autonote-note', id: snapshot.noteId },
          scope: `note:${snapshot.noteId}:writing`,
          input: JSON.stringify({
            action: next,
            noteId: snapshot.noteId,
            selectedText,
            beforeText,
            afterText,
            cursorOffset: snapshot.cursorOffset,
            language: i18n.locale,
            title: noteTitle,
          }),
          conversationId: null,
          regenerate: false,
          language: i18n.locale,
        },
        (event) => {
          if (event.kind === 'end') ended.resolve(event)
          else if (current() && !controller.signal.aborted && event.kind === 'text_delta') preview += event.text
        },
        { signal: controller.signal },
      )
      const end = await ended.promise
      if (end.status === 'failed' && current() && !controller.signal.aborted) fail(end.error?.code ?? 'internal')
    } catch (cause) {
      if (current() && !controller.signal.aborted) fail(cause instanceof KitClientError ? cause.code : 'internal')
    } finally {
      if (current()) {
        generating = false
        abort = null
      }
    }
  }
  function replace(): void {
    if (!preview || !requestSnapshot || !onReplace(preview, requestSnapshot)) error = i18n.t('writing.selection_changed')
    else open = false
  }
  function insert(): void {
    if (!preview || !requestSnapshot || !onInsert(preview, requestSnapshot)) error = i18n.t('writing.selection_changed')
    else open = false
  }
  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(preview)
  }
</script>

{#if chat}
  <div class="flex items-center gap-1 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1">
    {#if hasSelection}<Button size="sm" variant="ghost" disabled={generating} onclick={() => void run('polish')}><Sparkles size={13} />{i18n.t('writing.polish')}</Button>{/if}
    {#if hasSelection}<Button size="sm" variant="ghost" disabled={generating} onclick={() => void run('rewrite')}>{i18n.t('writing.rewrite')}</Button>{/if}
    <Button size="sm" variant="ghost" disabled={generating || !canRun(hasSelection ? 'shorten' : 'continue')} onclick={() => void run(hasSelection ? 'shorten' : 'continue')}>{i18n.t(hasSelection ? 'writing.shorten' : 'writing.continue')}</Button>
    <Button size="sm" variant="ghost" disabled={generating || !canRun(hasSelection ? 'expand' : 'continue')} onclick={() => void run(hasSelection ? 'expand' : 'continue')}><WandSparkles size={13} />{i18n.t(hasSelection ? 'writing.expand' : 'writing.generate_next')}</Button>
    <span class="min-w-0 flex-1 truncate text-[11px] text-[var(--text-tertiary)]">{label}</span>
  </div>
{/if}

<Modal {open} onClose={() => { if (!generating) open = false }} width={680} title={i18n.t('writing.preview_title')}>
  <div class="flex flex-col gap-3">
    {#if fallback}<p class="text-[12px] text-[var(--warning)]">{i18n.t('writing.using_chat_fallback')}</p>{/if}
    {#if error}<p role="alert" class="text-[12px] text-[var(--danger)]">{error}</p>{/if}
    <div class="min-h-24 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 text-[13px] whitespace-pre-wrap text-[var(--text-primary)]">{preview}{#if generating}<span class="ml-0.5 animate-pulse">▍</span>{/if}</div>
  </div>
  {#snippet footer()}
    {#if generating}<Button size="sm" variant="secondary" onclick={() => abort?.abort()}><Square size={13} />{i18n.t('writing.stop')}</Button>{/if}
    <Button size="sm" variant="ghost" disabled={!preview || generating} onclick={() => void copy()}><Copy size={13} />{i18n.t('writing.copy')}</Button>
    <Button size="sm" variant="secondary" disabled={!preview || generating} onclick={insert}><FileInput size={13} />{i18n.t('writing.insert')}</Button>
    <Button size="sm" variant="primary" disabled={!preview || generating} onclick={replace}>{i18n.t('writing.replace')}</Button>
  {/snippet}
</Modal>
