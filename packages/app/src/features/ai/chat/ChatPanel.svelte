<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { Copy, FileInput, History, Plus, RotateCcw, Send, Square, Trash2, X } from '@lucide/svelte'
  import Button from '@app/components/primitives/Button.svelte'
  import Empty from '@app/components/primitives/Empty.svelte'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import Select from '@app/components/primitives/Select.svelte'
  import * as DropdownMenu from '@app/components/ui/dropdown-menu'
  import { Textarea } from '@app/components/ui/textarea'
  import type { Backend } from '@app/backend'
  import { renderMarkdown } from '@app/markdown/renderer'
  import { getBackend, getI18n, getNotifier, getPrefs, getUi } from '@app/root/context'
  import type { WorkspacePanelProps } from '@app/root/types'
  import type { AiModelRef, AiPort } from '@shared/ai-types'
  import { ChatSession, type ChatTurn } from './chat-session.svelte'

  let { note, insert, openSettings, onClose }: WorkspacePanelProps = $props()
  const hasAi = (value: Backend): value is Backend & { ai: AiPort } => value.capabilities.ai && value.ai !== undefined
  const backend = getBackend()
  const i18n = getI18n()
  const notifier = getNotifier()
  const prefs = getPrefs()
  const ui = getUi()
  const ai = hasAi(backend) ? backend.ai : undefined
  const session = ai ? new ChatSession(ai, prefs) : undefined
  let models = $state<{ value: string; label: string }[]>([])
  let defaultModel = $state<{ value: string; label: string } | null>(null)
  let model = $state('')
  let ready = $state(false)
  let draft = $state('')
  let excludeNote = $state(false)
  let copied = $state<string | null>(null)
  let input = $state<HTMLTextAreaElement | null>(null)
  let scroller = $state<HTMLElement | null>(null)

  const lastAssistant = $derived(session?.turns.findLast((turn) => turn.role === 'assistant')?.key)
  const withNote = $derived(note !== null && !excludeNote)

  onMount(() => {
    if (!session) return
    void session.restore().catch(() => {})
  })
  $effect(() => {
    if (!ai || ui.panel !== null) return
    void Promise.all([ai.listProviders(), ai.roles()])
      .then(([providers, roles]) => {
        const binding = roles.find((role) => role.role === 'chat')?.binding
        const value = binding ? JSON.stringify([binding.endpointId, binding.modelId]) : null
        const all = providers.flatMap((provider) =>
          provider.endpoints.flatMap((endpoint) =>
            endpoint.models
              .filter((item) => item.modelType === 'chat')
              .map((item) => ({ value: JSON.stringify([endpoint.id, item.id]), label: item.id })),
          ),
        )
        defaultModel = all.find((option) => option.value === value) ?? null
        models = all.filter((option) => option.value !== value)
        if (!models.some((option) => option.value === model)) model = defaultModel ? '' : (models[0]?.value ?? '')
      })
      .catch(() => {})
      .finally(() => {
        if (!ready) void tick().then(() => input?.focus())
        ready = true
      })
  })

  $effect(() => {
    void session?.turns.map((turn) => turn.content.length)
    void tick().then(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight
    })
  })
  $effect(() => {
    void note?.id
    excludeNote = false
  })

  const pickedModel = (): AiModelRef | undefined => {
    if (!model) return undefined
    const [endpointId, modelId] = JSON.parse(model) as [string, string]
    return { endpointId, modelId }
  }
  const noteContext = () => (withNote && note ? { title: note.title, content: note.content } : undefined)
  async function send(regenerate = false): Promise<void> {
    if (!session) return
    const text = draft
    if (!regenerate) draft = ''
    const picked = pickedModel()
    const context = noteContext()
    await session.send(text, {
      regenerate,
      ...(context ? { note: context } : {}),
      ...(picked ? { model: picked } : {}),
    })
  }
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void send()
    }
  }
  async function copy(turn: ChatTurn): Promise<void> {
    await navigator.clipboard.writeText(turn.content)
    copied = turn.key
    setTimeout(() => {
      if (copied === turn.key) copied = null
    }, 1500)
  }
  async function remove(id: string, title: string): Promise<void> {
    if (!session) return
    const ok = await notifier.confirm({
      titleKey: 'chat.delete_title',
      bodyKey: 'chat.delete_desc',
      params: { title: title || i18n.t('chat.untitled') },
      danger: true,
    })
    if (ok) await session.remove(id)
  }
</script>

<header class="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2">
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[var(--r-md)] px-2 text-left text-[13px] font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
      aria-label={i18n.t('chat.history')}
      onclick={() => void session?.refreshHistory().catch(() => {})}
    >
      <History size={14} class="shrink-0 text-[var(--text-tertiary)]" />
      <span class="truncate">{session?.title || i18n.t('chat.title')}</span>
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="start" class="max-h-[60vh] w-[300px] overflow-y-auto">
      <DropdownMenu.Group>
        <DropdownMenu.GroupHeading>{i18n.t('chat.history')}</DropdownMenu.GroupHeading>
        {#each session?.history ?? [] as item (item.id)}
          <DropdownMenu.Item class="group" onclick={() => void session?.open(item.id)}>
            <span class="min-w-0 flex-1 truncate">{item.title || i18n.t('chat.untitled')}</span>
            <IconButton
              size="sm"
              label={i18n.t('chat.delete')}
              class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              onclick={(event) => {
                event.stopPropagation()
                void remove(item.id, item.title)
              }}><Trash2 size={13} /></IconButton
            >
          </DropdownMenu.Item>
        {:else}
          <DropdownMenu.Item disabled>{i18n.t('chat.history_empty')}</DropdownMenu.Item>
        {/each}
      </DropdownMenu.Group>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
  <IconButton size="sm" label={i18n.t('chat.new')} disabled={session?.streaming} onclick={() => session?.reset()}
    ><Plus size={15} /></IconButton
  >
  <IconButton size="sm" label={i18n.t('chat.close')} onclick={onClose}><X size={15} /></IconButton>
</header>

{#if !ai || !session}
  <div class="flex-1"></div>
{:else if ready && !defaultModel && models.length === 0}
  <Empty compact title={i18n.t('chat.no_model')}>
    {#snippet action()}
      <Button size="sm" variant="primary" onclick={() => openSettings('desktop-ai')}
        >{i18n.t('chat.open_settings')}</Button
      >
    {/snippet}
  </Empty>
{:else}
  <div bind:this={scroller} class="min-h-0 flex-1 overflow-y-auto px-3 py-3" aria-live="polite">
    {#if session.turns.length === 0}
      <p class="py-10 text-center text-[12.5px] text-[var(--text-tertiary)]">{i18n.t('chat.empty')}</p>
    {/if}
    <ol class="flex flex-col gap-4">
      {#each session.turns as turn (turn.key)}
        <li class={turn.role === 'user' ? 'flex justify-end' : 'flex flex-col gap-1'}>
          {#if turn.role === 'user'}
            <p
              class="max-w-[85%] rounded-[var(--r-lg)] bg-[var(--bg-raised)] px-3 py-2 text-[13px] whitespace-pre-wrap text-[var(--text-primary)]"
            >
              <span class="sr-only">{i18n.t('chat.you')}:</span>{turn.content}
            </p>
          {:else if turn.status === 'failed'}
            <div role="alert" class="flex flex-col items-start gap-1.5 text-[12.5px] text-[var(--danger)]">
              <span>{i18n.t('chat.failed', { reason: turn.content || i18n.t('common.action_failed') })}</span>
              {#if turn.key === lastAssistant}<Button size="sm" variant="secondary" onclick={() => void send(true)}
                  ><RotateCcw size={13} />{i18n.t('chat.retry')}</Button
                >{/if}
            </div>
          {:else}
            <span class="sr-only">{i18n.t('chat.assistant')}:</span>
            <!-- renderMarkdown output is DOMPurify-sanitized, same path as the note preview. -->
            <div
              class="ink-prose text-[13px]"
              {@attach (node) => {
                node.innerHTML = renderMarkdown(turn.content).html
              }}
            ></div>
            {#if turn.status === 'streaming'}<span
                class="inline-block h-3.5 w-1.5 animate-pulse bg-[var(--text-tertiary)]"
                aria-hidden="true"
              ></span>{/if}
            {#if turn.status === 'interrupted'}<span class="text-[11.5px] text-[var(--text-tertiary)]"
                >{i18n.t('chat.interrupted')}</span
              >{/if}
            {#if turn.status !== 'streaming'}
              <div class="flex items-center gap-0.5 text-[var(--text-tertiary)]">
                <IconButton
                  size="sm"
                  label={i18n.t(copied === turn.key ? 'chat.copied' : 'chat.copy')}
                  title={i18n.t(copied === turn.key ? 'chat.copied' : 'chat.copy')}
                  onclick={() => void copy(turn)}><Copy size={13} /></IconButton
                >
                <IconButton
                  size="sm"
                  label={i18n.t('chat.insert')}
                  title={i18n.t('chat.insert')}
                  disabled={!note}
                  onclick={() => insert(turn.content)}><FileInput size={13} /></IconButton
                >
                {#if turn.key === lastAssistant}<IconButton
                    size="sm"
                    label={i18n.t('chat.regenerate')}
                    title={i18n.t('chat.regenerate')}
                    disabled={session.streaming}
                    onclick={() => void send(true)}><RotateCcw size={13} /></IconButton
                  >{/if}
              </div>
            {/if}
          {/if}
        </li>
      {/each}
    </ol>
  </div>

  <footer class="flex shrink-0 flex-col gap-2 border-t border-[var(--border-subtle)] p-2">
    {#if note}
      <div class="flex items-center gap-1">
        {#if withNote}
          <span
            class="flex min-w-0 items-center gap-1 rounded-[var(--r-sm)] bg-[var(--accent-soft)] py-0.5 pr-0.5 pl-2 text-[11.5px] text-[var(--accent)]"
          >
            <span class="truncate">{i18n.t('chat.note_chip', { title: note.title })}</span>
            <IconButton size="sm" label={i18n.t('chat.note_exclude')} onclick={() => (excludeNote = true)}
              ><X size={12} /></IconButton
            >
          </span>
        {:else}
          <Button size="sm" variant="ghost" onclick={() => (excludeNote = false)}>{i18n.t('chat.note_include')}</Button>
        {/if}
      </div>
    {/if}
    <Textarea
      bind:ref={input}
      bind:value={draft}
      rows={2}
      class="max-h-48 min-h-14 resize-none text-[13px]"
      placeholder={i18n.t('chat.placeholder')}
      aria-label={i18n.t('chat.placeholder')}
      onkeydown={onKeydown}
    />
    <div class="flex items-center gap-2">
      <Select aria-label={i18n.t('chat.model')} class="h-8 min-w-0 text-[12px] md:h-8" bind:value={model}>
        {#if defaultModel}<option value="">{i18n.t('chat.model_default', { label: defaultModel.label })}</option>{/if}
        {#each models as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
      </Select>
      <span class="flex-1"></span>
      {#if session.streaming}
        <Button size="sm" variant="secondary" onclick={() => session.stop()}
          ><Square size={12} />{i18n.t('chat.stop')}</Button
        >
      {:else}
        <Button size="sm" variant="primary" disabled={!draft.trim()} onclick={() => void send()}
          ><Send size={13} />{i18n.t('chat.send')}</Button
        >
      {/if}
    </div>
  </footer>
{/if}
