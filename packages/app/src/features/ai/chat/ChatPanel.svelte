<script lang="ts">
  import { ChatPanel } from '@ouraihub/aether-ui/chat'
  import {
    providersRevision,
    REASONING_EFFORTS,
  } from '@ouraihub/aether-ui/providers'
  import type {
    ModelRef,
    PermissionMode,
    ReasoningEffort,
  } from '@ouraihub/aether-ui/ports'
  import { getBackend, getI18n, getPrefs } from '@app/root/context'
  import type { WorkspacePanelProps } from '@app/root/types'

  let { note, insert, saveNote, openSettings, onClose }: WorkspacePanelProps =
    $props()
  const backend = getBackend()
  const aiHost = backend.aiHost
  const permissionModes: PermissionMode[] =
    backend.kind === 'desktop'
      ? ['default', 'plan', 'accept_edits', 'auto', 'full_access']
      : ['default']
  let permissionMode = $state<PermissionMode>('default')
  const prefs = getPrefs()
  const i18n = getI18n()
  const EFFORT_KEY = 'ai.chat.reasoningEffort'
  const saveEffort = (effort: ReasoningEffort) =>
    void (
      effort === 'default'
        ? prefs.remove(EFFORT_KEY)
        : prefs.save(EFFORT_KEY, effort)
    ).catch(() => {})
  const scope = $derived(note ? `note:${note.id}` : 'autonote')
  const context = $derived(
    note ? { kind: 'autonote-note', id: note.id, label: note.title } : null,
  )
  const ready = $derived.by(async () => {
    const key = `ai.chat.last:${scope}`
    const [roles, last, toolbar, effort] = await Promise.all([
      aiHost?.roles().catch(() => []) ?? [],
      prefs.load(key).catch(() => null),
      prefs.load('ai.chat.toolbar').catch(() => null),
      prefs.load(EFFORT_KEY).catch(() => null),
    ])
    const binding = roles.find((role) => role.role === 'chat')?.binding
    const model: ModelRef | null = binding
      ? { endpointId: binding.endpointId, modelId: binding.modelId }
      : null
    const painting = Boolean(
      roles.find((role) => role.role === 'painting')?.binding,
    )
    const pinned =
      Array.isArray(toolbar) && toolbar.every((id) => typeof id === 'string')
        ? toolbar
        : undefined
    const reasoningEffort = REASONING_EFFORTS.find((known) => known === effort)
    return {
      key,
      model,
      painting,
      toolbar: pinned,
      reasoningEffort,
      conversationId: typeof last === 'string' ? last : null,
    }
  })
  let paintingNow = $state<boolean | null>(null)
  $effect(() => {
    if (providersRevision.value === 0) return
    let alive = true
    void (aiHost?.roles().catch(() => []) ?? Promise.resolve([])).then(
      (roles) => {
        if (alive)
          paintingNow = Boolean(
            roles.find((role) => role.role === 'painting')?.binding,
          )
      },
    )
    return () => {
      alive = false
    }
  })
</script>

{#if aiHost}
  {#key scope}
    {#await ready then { key, model, painting, toolbar, reasoningEffort, conversationId }}
      <div class="flex min-h-0 flex-1 flex-col p-3">
        <ChatPanel
          {model}
          {scope}
          {context}
          {conversationId}
          {permissionModes}
          bind:permissionMode
          onInsert={insert}
          onSaveNote={saveNote}
          {...aiHost.exportMarkdown
            ? { onExportMarkdown: aiHost.exportMarkdown }
            : {}}
          onOpenSettings={() => openSettings('ai')}
          onConversationChange={(id) =>
            void (id ? prefs.save(key, id) : prefs.remove(key)).catch(() => {})}
          {onClose}
          paintingModel={paintingNow ?? painting}
          {...toolbar ? { toolbar } : {}}
          onToolbarChange={(ids) =>
            void prefs.save('ai.chat.toolbar', ids).catch(() => {})}
          {...reasoningEffort ? { reasoningEffort } : {}}
          onReasoningEffortChange={saveEffort}
        />
        {#if backend.kind === 'desktop' && aiHost.kit.skills}
          <p class="mt-2 shrink-0 text-[12px] text-[var(--warning)]">
            {i18n.t('ai.skills_runner_warning')}
          </p>
        {/if}
      </div>
    {/await}
  {/key}
{/if}
