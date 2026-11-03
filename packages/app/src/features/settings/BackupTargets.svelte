<script lang="ts">
  import {
    AlertCircle,
    CheckCircle2,
    HardDrive,
    MoreHorizontal,
    Plus,
    Server,
    Trash2,
  } from '@lucide/svelte'
  import type { BackupTarget } from '@shared/types'
  import type { MessageKey } from '@shared/locales/en-US'
  import { getI18n } from '@app/root/context'
  import Button from '@app/components/primitives/Button.svelte'
  import Empty from '@app/components/primitives/Empty.svelte'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import { cn } from '@app/utils'

  let {
    targets,
    busy,
    onEdit,
    onRemove,
  }: {
    targets: BackupTarget[]
    busy: boolean
    onEdit: (target: BackupTarget | null) => void
    onRemove: (target: BackupTarget) => Promise<void>
  } = $props()
  const i18n = getI18n()
  const sectionHeading =
    'text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]'
  const enabledBadge =
    'bg-[color-mix(in_oklab,var(--success)_15%,transparent)] ' +
    'text-[var(--success)]'
</script>

<section>
  <div class="mb-2 flex items-center justify-between">
    <h3 class={sectionHeading}>{i18n.t('settings.backup_target')}</h3>
    <Button
      size="sm"
      variant="secondary"
      disabled={busy}
      onclick={() => {
        onEdit(null)
      }}><Plus size={13} />{i18n.t('settings.add_target')}</Button
    >
  </div>
  {#if targets.length === 0}
    <div
      class="rounded-[var(--r-lg)] border border-dashed
        border-[var(--border-default)]"
    >
      <Empty
        art="archive"
        compact
        title={i18n.t('settings.no_backup_target_yet')}
        description={i18n.t(
          ('settings.add_a_webdav_or_s3_compatible_target_' +
            'or_choose_a_common_provider_preset') as MessageKey,
        )}
      >
        {#snippet action()}
          <Button
            size="sm"
            disabled={busy}
            onclick={() => {
              onEdit(null)
            }}><Plus size={13} />{i18n.t('settings.add_first_target')}</Button
          >
        {/snippet}
      </Empty>
    </div>
  {:else}
    <div class="space-y-2">
      {#each targets as target (target.id)}
        {@const config = target.config}
        <div
          class={cn(
            'rounded-[var(--r-lg)] border border-[var(--border-subtle)] ' +
              'bg-[var(--bg-base)] p-3 transition-colors',
            !target.enabled && 'opacity-60',
          )}
        >
          <div class="flex items-start gap-3">
            <span
              class="mt-0.5 flex size-8 shrink-0 items-center justify-center
                rounded-[var(--r-md)] bg-[var(--bg-raised)]
                text-[var(--text-tertiary)]"
            >
              {#if target.type === 's3'}<HardDrive size={15} />{:else}<Server
                  size={15}
                />{/if}
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span
                  class="truncate text-[13px] font-medium
                    text-[var(--text-primary)]">{target.name}</span
                >
                <span
                  class="inline-flex items-center rounded-full
                    bg-[var(--bg-raised)] px-[7px] py-[1px] text-[11px]
                    font-medium tabular text-[var(--text-tertiary)]"
                >
                  {target.type === 's3'
                    ? i18n.t('settings.s3_backup')
                    : i18n.t('settings.webdav_backup')}
                </span>
              </div>
              <div
                class="mt-0.5 truncate text-[11.5px]
                  text-[var(--text-quaternary)]"
              >
                {'bucket' in config
                  ? config.bucket + (config.prefix ? `/${config.prefix}` : '')
                  : config.url}
              </div>
              {#if target.lastRunAt}
                <div
                  class={cn(
                    'mt-1.5 flex items-center gap-1.5 text-[11px]',
                    target.lastStatus === 'success'
                      ? 'text-[var(--success)]'
                      : 'text-[var(--danger)]',
                  )}
                >
                  {#if target.lastStatus === 'success'}<CheckCircle2
                      size={11}
                    />{:else}<AlertCircle size={11} />{/if}
                  {target.lastStatus === 'success'
                    ? i18n.t('settings.last_backup_succeeded')
                    : i18n.t('settings.last_backup_failed')}
                  <span class="text-[var(--text-quaternary)]"
                    >· {new Date(target.lastRunAt).toLocaleString(
                      i18n.locale,
                    )}</span
                  >
                </div>
              {/if}
            </div>
            <div class="flex shrink-0 items-center gap-1">
              <span
                class={[
                  'inline-flex items-center rounded-full px-[7px] py-[1px] ' +
                    'text-[11px] font-medium tabular',
                  target.enabled
                    ? enabledBadge
                    : 'bg-[var(--bg-raised)] text-[var(--text-tertiary)]',
                ]}
              >
                {target.enabled ? i18n.t('common.on') : i18n.t('common.off')}
              </span>
              <IconButton
                label={i18n.t('common.edit')}
                title={i18n.t('common.edit')}
                size="sm"
                disabled={busy}
                onclick={() => {
                  onEdit(target)
                }}
              >
                <MoreHorizontal size={14} />
              </IconButton>
              <IconButton
                label={i18n.t('common.delete')}
                title={i18n.t('common.delete')}
                size="sm"
                disabled={busy}
                class="text-[var(--text-quaternary)] hover:text-[var(--danger)]"
                onclick={() => void onRemove(target)}
              >
                <Trash2 size={13} />
              </IconButton>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>
