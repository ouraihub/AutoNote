<script lang="ts">
  import { ChatPanel } from '@ouraihub/aether-ui/chat'
  import type { ModelRef } from '@ouraihub/aether-ui/ports'
  import { getBackend, getPrefs } from '@app/root/context'
  import type { WorkspacePanelProps } from '@app/root/types'

  let { note, insert, saveNote, openSettings, onClose }: WorkspacePanelProps = $props()
  const aiHost = getBackend().aiHost
  const prefs = getPrefs()
  const scope = $derived(note ? `note:${note.id}` : 'autonote')
  const context = $derived(note ? { kind: 'autonote-note', id: note.id, label: note.title } : null)
  const ready = $derived.by(async () => {
    const key = `ai.chat.last:${scope}`
    const [roles, last] = await Promise.all([aiHost?.roles().catch(() => []) ?? [], prefs.load(key).catch(() => null)])
    const binding = roles.find((role) => role.role === 'chat')?.binding
    const model: ModelRef | null = binding ? { endpointId: binding.endpointId, modelId: binding.modelId } : null
    return { key, model, conversationId: typeof last === 'string' ? last : null }
  })
</script>

{#if aiHost}
  {#key scope}
    {#await ready then { key, model, conversationId }}
      <div class="flex min-h-0 flex-1 flex-col p-3">
        <ChatPanel
          {model}
          {scope}
          {context}
          {conversationId}
          onInsert={insert}
          onSaveNote={saveNote}
          {...aiHost.exportMarkdown ? { onExportMarkdown: aiHost.exportMarkdown } : {}}
          onOpenSettings={() => openSettings('ai')}
          onConversationChange={(id) => void (id ? prefs.save(key, id) : prefs.remove(key)).catch(() => {})}
          {onClose}
        />
      </div>
    {/await}
  {/key}
{/if}
