<script lang="ts">
  import SharedChatPanel from '@app/features/ai/chat/ChatPanel.svelte'
  import type { WorkspacePanelProps } from '@app/root/types'
  let props: WorkspacePanelProps = $props()
</script>

<SharedChatPanel {...props} />
