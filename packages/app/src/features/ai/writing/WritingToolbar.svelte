<script lang="ts">
  import { Copy, FileInput, Sparkles, Square, WandSparkles } from '@lucide/svelte'
  import Button from '@app/components/primitives/Button.svelte'
  import Modal from '@app/components/primitives/Modal.svelte'
  import { getBackend, getI18n } from '@app/root/context'
  import type { WritingToolbarProps } from '@app/root/types'
  import type { AiWriteAction } from '@shared/ai-types'

  let { view, selection, noteTitle, onReplace, onInsert }: WritingToolbarProps = $props()
  const backend = getBackend()
  const i18n = getI18n()
  const ai = backend.capabilities.ai ? backend.ai : undefined
  let open = $state(false)
  let generating = $state(false)
  let preview = $state('')
  let fallback = $state(false)
  let error = $state<string | null>(null)
  let abort = $state<AbortController | null>(null)

  const hasSelection = $derived(selection.from !== selection.to && selection.text.length > 0)
  const label = $derived(hasSelection ? selection.text.slice(0, 28) : i18n.t('writing.continue'))
  const context = $derived(view ? view.state.sliceDoc(Math.max(0, selection.from - 1000), Math.min(view.state.doc.length, selection.to + 1000)) : '')
  const canRun = (next: AiWriteAction): boolean => (next === 'continue' ? context.trim().length > 0 : hasSelection)

  async function run(next: AiWriteAction): Promise<void> {
    if (!ai || generating || !canRun(next)) return
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
          text: selection.text,
          language: i18n.locale,
          ...(context ? { context } : {}),
          noteTitle,
        },
        (event) => {
          if (event.kind === 'delta') preview += event.text
        },
        { signal: abort.signal },
      )
      fallback = result.isFallback
    } catch (cause) {
      if (!abort.signal.aborted) error = cause instanceof Error ? cause.message : i18n.t('common.action_failed')
    } finally {
      generating = false
      abort = null
    }
  }
  function replace(): void {
    if (!preview || !onReplace(preview, selection)) error = i18n.t('writing.selection_changed')
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
