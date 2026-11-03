<script lang="ts">
  import { ShieldCheck, Unplug } from '@lucide/svelte'
  import type { McpGrant } from '@shared/types'
  import { getI18n } from '@app/root/context'
  import Button from '@app/components/primitives/Button.svelte'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  let {
    grants,
    busy,
    scopeSummary,
    revokeGrant,
    revokeAll,
  }: {
    grants: McpGrant[]
    busy: boolean
    scopeSummary: (scopes: string[]) => string
    revokeGrant: (grant: McpGrant) => Promise<void>
    revokeAll: () => Promise<void>
  } = $props()
  const i18n = getI18n()
  const sectionHeading =
    'text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]'
  const fullTime = (value: number) =>
    new Date(value).toLocaleString(i18n.locale)
</script>

<section>
  <div class="mb-2 flex items-center justify-between gap-3 px-1">
    <h3 class={sectionHeading}>
      {i18n.t('settings.mcp_connected_clients')}
    </h3>
    {#if grants.length > 1}<Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onclick={() => void revokeAll()}
        >{i18n.t('settings.mcp_revoke_all')}</Button
      >{/if}
  </div>
  {#if grants.length}
    <div
      class="overflow-hidden rounded-[var(--r-lg)] border
        border-[var(--border-subtle)] bg-[var(--bg-base)]"
    >
      {#each grants as grant (grant.id)}
        <div
          class="flex items-center gap-3 border-b
            border-[var(--border-subtle)] p-3.5 last:border-b-0"
        >
          <span
            class="rounded-[var(--r-sm)] bg-[var(--bg-raised)] p-2
              text-[var(--text-tertiary)]"><ShieldCheck size={15} /></span
          >
          <div class="min-w-0 flex-1">
            <div
              class="truncate text-[12.5px] font-medium
                text-[var(--text-primary)]"
            >
              {grant.clientName}
            </div>
            <div
              class="mt-0.5 truncate text-[10.5px]
                text-[var(--text-quaternary)]"
            >
              {scopeSummary(grant.scopes)} · {i18n.t(
                'settings.mcp_granted_at',
                { time: fullTime(grant.createdAt) },
              )}
            </div>
          </div>
          <IconButton
            label={i18n.t('settings.mcp_revoke')}
            title={i18n.t('settings.mcp_revoke')}
            size="sm"
            disabled={busy}
            onclick={() => void revokeGrant(grant)}
          >
            <Unplug size={14} />
          </IconButton>
        </div>
      {/each}
    </div>
  {:else}
    <div
      class="rounded-[var(--r-lg)] border border-dashed
        border-[var(--border-default)] p-5 text-center text-[11.5px]
        text-[var(--text-quaternary)]"
    >
      {i18n.t('settings.mcp_no_clients')}
    </div>
  {/if}
</section>
