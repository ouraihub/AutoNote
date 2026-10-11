<script lang="ts">
  import { Copy, FileInput, Sparkles, Square, WandSparkles } from '@lucide/svelte'
  import Button from '@app/components/primitives/Button.svelte'
  import Modal from '@app/components/primitives/Modal.svelte'
  import { getBackend, getI18n, getLogger } from '@app/root/context'
  import { errorMessageKey } from '@app/i18n/errors'
  import { logFailure } from '@app/log/logger'
  import type { WritingSelection, WritingToolbarProps } from '@app/root/types'
  import type { AiWriteAction } from '@shared/ai-types'

  let { view, selection, noteId, noteTitle, onReplace, onInsert }: WritingToolbarProps = $props()
  const backend = getBackend()
  const i18n = getI18n()
  const logger = getLogger()
  const ai = backend.capabilities.ai ? backend.ai : undefined
  const MAX_SELECTED_BYTES = 8_000
  const MAX_CONTEXT_BYTES = 8_000
  const MAX_TOTAL_BYTES = 24_000
  let open = $state(false)
  let generating = $state(false)
  let preview = $state('')
  let fallback = $state(false)
  let error = $state<string | null>(null)
  let abort = $state<AbortController | null>(null)
  let requestSelection = $state<WritingSelection | null>(null)

  function bounded(value: string, maxBytes: number): string {
    const bytes = new TextEncoder().encode(value)
    return bytes.length <= maxBytes ? value : new TextDecoder().decode(bytes.slice(0, maxBytes))
  }
  const hasSelection = $derived(selection.from !== selection.to && selection.text.length > 0)
  const label = $derived(hasSelection ? selection.text.slice(0, 28) : i18n.t('writing.continue'))
  const context = $derived(view ? view.state.sliceDoc(Math.max(0, selection.from - 1000), Math.min(view.state.doc.length, selection.to + 1000)) : '')
  const canRun = (next: AiWriteAction): boolean => (next === 'continue' ? context.trim().length > 0 : hasSelection)

  async function run(next: AiWriteAction): Promise<void> {
    if (!ai || generating || !canRun(next) || !view) return
    const snapshot = { ...selection, text: view.state.sliceDoc(selection.from, selection.to) }
    requestSelection = snapshot
    let selectedText = bounded(snapshot.text, MAX_SELECTED_BYTES)
    let beforeText = bounded(view.state.sliceDoc(Math.max(0, snapshot.from - 1000), snapshot.from), MAX_CONTEXT_BYTES)
    let afterText = bounded(view.state.sliceDoc(snapshot.to, Math.min(view.state.doc.length, snapshot.to + 1000)), MAX_CONTEXT_BYTES)
    while (new TextEncoder().encode(selectedText + beforeText + afterText).length > MAX_TOTAL_BYTES) {
      if (afterText) afterText = bounded(afterText, Math.max(0, new TextEncoder().encode(afterText).length - 256))
      else if (beforeText) beforeText = bounded(beforeText, Math.max(0, new TextEncoder().encode(beforeText).length - 256))
      else selectedText = bounded(selectedText, Math.max(0, new TextEncoder().encode(selectedText).length - 256))
    }
    preview = ''
    error = null
    fallback = false
    open = true
    generating = true
    abort = new AbortController()
    try {
      const result = await ai.write(
        {
          action: next,
          noteId,
          selectedText,
          beforeText,
          afterText,
          cursorOffset: snapshot.from,
          language: i18n.locale,
          title: noteTitle,
        },
        (event) => {
          if (event.kind === 'delta') preview += event.text
        },
        { signal: abort.signal },
      )
      fallback = result.isFallback
    } catch (cause) {
      if (!abort.signal.aborted) {
        logFailure(logger, 'ai.write.failed', cause)
        error = i18n.t(errorMessageKey(cause))
      }
    } finally {
      generating = false
      abort = null
    }
  }
  function replace(): void {
    if (!preview || !requestSelection || !onReplace(preview, requestSelection)) error = i18n.t('writing.selection_changed')
    else open = false
  }
  function insert(): void {
    if (preview) onInsert(preview)
    open = false
  }
  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(preview)
  }
</script>

{#if ai}
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
