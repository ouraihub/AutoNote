<script lang="ts">
  import { prettyCombo } from '@app/lib/hotkeys'

  let { combo, keys }: { combo?: string; keys?: string[] } = $props()
  const parts = $derived(keys ?? (combo ? prettyCombo(combo) : []))
</script>

<span class="inline-flex shrink-0 items-center gap-[3px]">
  {#each parts as key, index (`${key}-${index}`)}
    <kbd
      class="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-[var(--border-default)] bg-[var(--bg-raised)] px-[5px] text-[10.5px] font-medium text-[var(--text-tertiary)]"
      >{key}</kbd
    >
  {/each}
</span>
