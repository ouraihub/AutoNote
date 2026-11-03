<script lang="ts">
  import { AlertCircle } from '@lucide/svelte'
  import type { MessageKey } from '@shared/locales/en-US'
  import { getI18n } from '@app/root/context'
  import Button from '@app/components/primitives/Button.svelte'
  import SettingsLoading from './SettingsLoading.svelte'
  import { formatBytes } from './format'
  let {
    stats,
    statsError,
    loadStats,
  }: {
    stats: Record<string, number> | null
    statsError: string | null
    loadStats: () => Promise<void>
  } = $props()
  const i18n = getI18n()
  const overview: { key: string; label: MessageKey }[] = [
    { key: 'notes', label: 'common.note' },
    { key: 'folders', label: 'navigation.folder' },
    { key: 'tags', label: 'navigation.tag' },
    { key: 'links', label: 'common.wiki_links' },
    { key: 'words', label: 'settings.total_words' },
    { key: 'versions', label: 'settings.version_history' },
    { key: 'attachments', label: 'settings.attachments' },
    { key: 'trashed', label: 'navigation.trash' },
  ]
</script>

<section>
  <h3
    class="mb-2 text-[11px] font-semibold tracking-[0.06em]
        text-[var(--text-quaternary)]"
  >
    {i18n.t('settings.overview')}
  </h3>
  {#if stats === null}
    {#if statsError}
      <div
        role="alert"
        class="flex items-start gap-2 rounded-[var(--r-md)] border
            border-[color-mix(in_oklab,var(--danger)_25%,var(--border-subtle))]
            bg-[var(--bg-base)] px-3 py-3"
      >
        <AlertCircle size={14} class="mt-0.5 shrink-0 text-[var(--danger)]" />
        <div class="min-w-0 flex-1">
          <div class="text-[12.5px] font-medium text-[var(--text-primary)]">
            {i18n.t('settings.could_not_load_data_overview')}
          </div>
          <p
            class="mt-0.5 break-words text-[11.5px]
                text-[var(--text-tertiary)]"
          >
            {statsError}
          </p>
        </div>
        <Button size="sm" variant="secondary" onclick={() => void loadStats()}
          >{i18n.t('common.retry')}</Button
        >
      </div>
    {:else}<SettingsLoading />{/if}
  {:else}
    {#if statsError}
      <div
        role="alert"
        class="mb-2 flex items-start gap-2 rounded-[var(--r-md)] border
            border-[color-mix(in_oklab,var(--danger)_25%,var(--border-subtle))]
            bg-[var(--bg-base)] px-3 py-2 text-[11.5px] text-[var(--danger)]"
      >
        <AlertCircle size={13} class="mt-0.5 shrink-0" />
        <span class="min-w-0 flex-1 break-words">{statsError}</span>
        <button
          type="button"
          class="shrink-0 font-medium underline underline-offset-2"
          onclick={() => void loadStats()}>{i18n.t('common.retry')}</button
        >
      </div>
    {/if}
    <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
      {#each overview as item (item.key)}
        <div
          class="rounded-[var(--r-md)] border border-[var(--border-subtle)]
              bg-[var(--bg-base)] px-3 py-2.5"
        >
          <div
            class="text-[17px] font-semibold tabular tracking-[-0.02em]
                text-[var(--text-primary)]"
          >
            {i18n.formatNumber(stats[item.key] ?? 0)}
          </div>
          <div class="mt-0.5 text-[11px] text-[var(--text-quaternary)]">
            {i18n.t(item.label as MessageKey)}
          </div>
        </div>
      {/each}
    </div>
    {#if stats.attachmentBytes}<p
        class="mt-2 text-[11.5px] text-[var(--text-quaternary)]"
      >
        {i18n.t('settings.attachment_storage')}
        {formatBytes(stats.attachmentBytes)}
      </p>{/if}
  {/if}
</section>
