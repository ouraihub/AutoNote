<script lang="ts">
  import { Check, Copy, TriangleAlert } from '@lucide/svelte'
  import type { Snippet } from 'svelte'
  import type { MessageKey } from '@shared/locales/en-US'
  import { getI18n } from '@app/root/context'
  import Button from '@app/components/primitives/Button.svelte'
  let {
    recovery,
    copy,
    reset,
    inlineError,
  }: {
    recovery: string[]
    copy: (value: string, key: MessageKey) => Promise<void>
    reset: () => void
    inlineError: Snippet
  } = $props()
  const i18n = getI18n()
</script>

<div class="space-y-4 border-t border-[var(--border-subtle)] px-4 py-4">
  <div
    class="flex items-start gap-2.5 rounded-[var(--r-md)] border
      border-[color-mix(in_oklab,var(--warning)_35%,transparent)]
      bg-[color-mix(in_oklab,var(--warning)_8%,transparent)] p-3"
  >
    <TriangleAlert size={15} class="mt-0.5 shrink-0 text-[var(--warning)]" />
    <div>
      <p class="text-[12.5px] font-semibold text-[var(--text-primary)]">
        {i18n.t('settings.totp_save_recovery_codes')}
      </p>
      <p class="mt-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
        {i18n.t('settings.totp_recovery_codes_once')}
      </p>
    </div>
  </div>
  <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
    {#each recovery as item, index (item)}
      <code
        class="select-all rounded-[var(--r-md)] border
          border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2
          text-center font-mono text-[12px] tracking-[0.04em]
          text-[var(--text-primary)]"
      >
        <span class="mr-2 text-[var(--text-quaternary)]">{index + 1}.</span
        >{item}
      </code>
    {/each}
  </div>
  {@render inlineError()}
  <div class="flex flex-wrap justify-end gap-2">
    <Button
      size="sm"
      variant="secondary"
      onclick={() =>
        void copy(recovery.join('\n'), 'settings.totp_recovery_codes_copied')}
      ><Copy size={12} />{i18n.t('settings.totp_copy_all')}</Button
    >
    <Button size="sm" variant="primary" onclick={() => reset()}
      ><Check size={12} />{i18n.t('settings.totp_saved_codes')}</Button
    >
  </div>
</div>
