<script lang="ts">
  import { getI18n } from '@app/root/context'

  const i18n = getI18n()
  let { label = i18n.t('common.loading'), rows = 4 }: { label?: string; rows?: number } = $props()
</script>

<div role="status" aria-live="polite" aria-label={label} class="space-y-4 py-3">
  <span class="sr-only">{label}</span>
  <div aria-hidden="true" class="space-y-4 motion-safe:animate-pulse">
    {#each { length: rows }, row (row)}
      <div class="flex min-h-16 items-center justify-between gap-6 border-b border-[var(--border-subtle)] pb-4">
        <div class="flex-1 space-y-2">
          <div class="h-3 w-24 rounded bg-[var(--bg-hover)]"></div>
          <div class="h-2.5 w-3/4 rounded bg-[var(--bg-hover)]"></div>
        </div>
        <div class="h-8 w-20 rounded-[var(--r-md)] bg-[var(--bg-hover)]"></div>
      </div>
    {/each}
  </div>
</div>
