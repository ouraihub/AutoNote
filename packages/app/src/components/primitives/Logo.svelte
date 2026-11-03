<script lang="ts">
  import { cn } from '@app/utils'

  let { size = 20, class: className }: { size?: number; class?: string } =
    $props()
</script>

<img
  src="/autonote-logo.png"
  alt=""
  width={size}
  height={size}
  draggable="false"
  class={cn('shrink-0 rounded-[22%] select-none', className)}
  aria-hidden="true"
/>
