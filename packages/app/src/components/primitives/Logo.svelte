<script lang="ts">
  import { cn } from '@app/utils'

  let { size = 20, class: className }: { size?: number; class?: string } = $props()
</script>

<svg viewBox="0 0 32 32" width={size} height={size} class={cn('ink-logo', className)} aria-hidden="true">
  <rect x="2.5" y="2.5" width="27" height="27" rx="8.5" class="fill-[var(--text-primary)]" />
  <path
    d="M16 8.2c2.7 3.5 5.4 6.3 5.4 9.3a5.4 5.4 0 1 1-10.8 0c0-3 2.7-5.8 5.4-9.3z"
    class="fill-[var(--brand-accent)]"
  />
</svg>
