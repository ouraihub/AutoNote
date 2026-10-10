<script lang="ts">
  import SharedWritingToolbar from '@app/features/ai/writing/WritingToolbar.svelte'
  import type { WritingToolbarProps } from '@app/root/types'
  let props: WritingToolbarProps = $props()
</script>

<SharedWritingToolbar {...props} />
