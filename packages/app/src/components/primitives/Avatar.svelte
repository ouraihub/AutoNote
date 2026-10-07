<script lang="ts">
  import { resolveAvatarSource } from '@app/lib/avatar'
  import { cn } from '@app/utils'

  let {
    src,
    name,
    size = 24,
    class: className,
  }: { src?: string | undefined; name: string; size?: number | undefined; class?: string | undefined } = $props()
  let failed = $state<string | null>(null)
  const seed = $derived(name.trim() || '?')
  const resolved = $derived(resolveAvatarSource(src, seed))
  const display = $derived(failed === resolved ? resolveAvatarSource(null, seed) : resolved)
</script>

<span
  class={cn(
    'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full',
    'bg-[var(--bg-raised)] text-[var(--text-secondary)] font-medium select-none',
    'ring-1 ring-[var(--border-subtle)]',
    className,
  )}
  style:width={`${size}px`}
  style:height={`${size}px`}
  style:font-size={`${size * 0.42}px`}
>
  <img src={display} alt="" width={size} height={size} onerror={() => (failed = resolved)} class="size-full object-cover" />
</span>
