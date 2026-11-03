<script lang="ts">
  import { AlertTriangle, RefreshCw, Sparkles, Trash2 } from '@lucide/svelte'
  import type { McpSettingsInfo } from '@shared/types'
  import { getI18n } from '@app/root/context'
  import Button from '@app/components/primitives/Button.svelte'
  import Switch from '@app/components/primitives/Switch.svelte'
  let {
    info,
    busy,
    aiSearch,
    changeIndex,
  }: {
    info: McpSettingsInfo
    busy: boolean
    aiSearch: (enabled: boolean) => Promise<void>
    changeIndex: (action: 'reindex' | 'clear') => Promise<void>
  } = $props()
  const i18n = getI18n()
  const sectionHeading =
    'text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]'
  const badge =
    'inline-flex items-center rounded-full px-[7px] py-[1px] ' +
    'text-[11px] font-medium tabular'
</script>

<section>
  <div class="mb-2 flex items-center justify-between gap-3 px-1">
    <div class="flex items-center gap-1.5">
      <Sparkles size={13} class="text-[var(--accent)]" />
      <h3 class={sectionHeading}>{i18n.t('settings.mcp_ai_search')}</h3>
      {#if info.aiSearch.available}
        <span
          class={[
            badge,
            info.aiSearch.enabled
              ? 'bg-[color-mix(in_oklab,var(--success)_15%,transparent)] ' +
                'text-[var(--success)]'
              : 'bg-[var(--bg-raised)] text-[var(--text-tertiary)]',
          ]}
        >
          {info.aiSearch.enabled
            ? i18n.t('settings.enabled')
            : i18n.t('settings.mcp_disabled')}
        </span>
      {:else}
        <span
          class={[
            badge,
            'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] ' +
              'text-[var(--warning)]',
          ]}>{i18n.t('settings.mcp_ai_search_unavailable')}</span
        >
      {/if}
    </div>
    <Switch
      checked={info.aiSearch.enabled}
      disabled={busy || !info.enabled || !info.aiSearch.available}
      label={i18n.t('settings.mcp_ai_search')}
      onChange={(enabled) => void aiSearch(enabled)}
    />
  </div>
  <div
    class="rounded-[var(--r-lg)] border border-[var(--border-subtle)]
      bg-[var(--bg-base)] p-3.5"
  >
    <p class="text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
      {i18n.t('settings.mcp_ai_search_desc')}
    </p>
    {#if info.aiSearch.available}
      <p class="mt-2 text-[10.5px] text-[var(--text-quaternary)]">
        {i18n.t('settings.mcp_ai_search_indexed', {
          count: info.aiSearch.indexedCount,
        })}{info.aiSearch.pendingCount > 0
          ? ` · ${i18n.t('settings.mcp_ai_search_pending', {
              count: info.aiSearch.pendingCount,
            })}`
          : ''}
      </p>
    {:else}
      <p
        class="mt-2 flex items-center gap-1.5 text-[10.5px]
          text-[var(--danger)]"
      >
        <AlertTriangle size={12} />{i18n.t(
          'settings.mcp_ai_search_unavailable_desc',
        )}
      </p>
    {/if}
    <div class="mt-3 flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={busy || !info.aiSearch.enabled}
        onclick={() => void changeIndex('reindex')}
        ><RefreshCw size={12} />{i18n.t(
          'settings.mcp_ai_search_reindex',
        )}</Button
      >
      <Button
        size="sm"
        variant="ghost"
        disabled={busy || !info.aiSearch.enabled}
        onclick={() => void changeIndex('clear')}
        ><Trash2 size={12} />{i18n.t('settings.mcp_ai_search_clear')}</Button
      >
    </div>
  </div>
</section>
