<script lang="ts">
  import { onMount } from 'svelte'
  import { bootDesktop } from '$lib/host/compose'

  let target = $state<HTMLDivElement>()
  let error = $state<unknown>(null)

  onMount(() => {
    if (!target) return
    let handle: Awaited<ReturnType<typeof bootDesktop>> | undefined
    let disposed = false
    void bootDesktop(target).then((mounted) => {
      if (disposed) void mounted.destroy()
      else handle = mounted
    }).catch((reason: unknown) => { error = reason })
    return () => {
      disposed = true
      void handle?.destroy()
    }
  })
</script>

<div bind:this={target} class="h-dvh min-h-0">
  {#if error}<p role="alert">Unable to load AutoNote.</p>{/if}
</div>
