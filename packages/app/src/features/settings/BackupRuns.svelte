<script lang="ts">
  import { AlertCircle, CheckCircle2 } from '@lucide/svelte'
  import type { BackupRun } from '@shared/types'
  import { getI18n } from '@app/root/context'
  import { cn } from '@app/utils'

  let { runs }: { runs: BackupRun[] } = $props()
  const i18n = getI18n()
  let openRun = $state<string | null>(null)
  const sectionHeading =
    'text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]'
  const formatBytes = (bytes: number) =>
    bytes >= 1024 * 1024
      ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.ceil(bytes / 1024)} KB`
  const fullTime = (value: number) =>
    new Date(value).toLocaleString(i18n.locale)
  const key = (targetId: string, index: number) => `${targetId}-${index}`
</script>

<section>
  <h3 class={['mb-2', sectionHeading]}>
    {i18n.t('settings.latest_backups')}
  </h3>
  {#if runs.length === 0}
    <p
      class="rounded-[var(--r-md)] border border-[var(--border-subtle)]
        bg-[var(--bg-inset)] px-3 py-4 text-center text-[12px]
        text-[var(--text-quaternary)]"
    >
      {i18n.t('settings.no_backup_record_yet')}
    </p>
  {:else}
    <ul class="space-y-1">
      {#each runs.slice(0, 12) as item (item.id)}
        {@const expanded = openRun === item.id}
        <li
          class="overflow-hidden rounded-[var(--r-md)] border
            border-[var(--border-subtle)] bg-[var(--bg-base)]"
        >
          <button
            type="button"
            aria-expanded={expanded}
            onclick={() => (openRun = expanded ? null : item.id)}
            class="flex w-full items-center gap-2.5 px-3 py-2 text-left
              transition-colors hover:bg-[var(--bg-hover)]"
          >
            <span
              class={cn(
                'size-1.5 shrink-0 rounded-full',
                item.status === 'success'
                  ? 'bg-[var(--success)]'
                  : item.status === 'partial'
                    ? 'bg-[var(--warning)]'
                    : 'bg-[var(--danger)]',
              )}
            ></span>
            <span
              class="min-w-0 flex-1 truncate text-[12px]
                text-[var(--text-secondary)]"
            >
              {fullTime(item.startedAt)} · {item.trigger === 'cron'
                ? i18n.t('settings.scheduled')
                : i18n.t('settings.manual')}
            </span>
            <span
              class="shrink-0 text-[11px] tabular text-[var(--text-quaternary)]"
              >{item.noteCount}{i18n.t('settings.notes')}{formatBytes(
                item.bytes,
              )}</span
            >
          </button>
          {#if expanded && item.results.length > 0}
            <ul
              class="border-t border-[var(--border-subtle)]
                bg-[var(--bg-inset)] px-3 py-2"
            >
              {#each item.results as entry, index (key(entry.targetId, index))}
                <li class="flex items-start gap-2 py-1 text-[11.5px]">
                  {#if entry.ok}<CheckCircle2
                      size={11}
                      class="mt-0.5 shrink-0 text-[var(--success)]"
                    />{:else}<AlertCircle
                      size={11}
                      class="mt-0.5 shrink-0 text-[var(--danger)]"
                    />{/if}
                  <span class="shrink-0 text-[var(--text-secondary)]"
                    >{entry.targetName}</span
                  >
                  <span class="min-w-0 flex-1 text-[var(--text-quaternary)]">
                    {entry.ok
                      ? i18n.t('settings.value0_files_value1_value2', {
                          value0: entry.files,
                          value1: formatBytes(entry.bytes),
                          value2: `${(entry.ms / 1000).toFixed(1)}s`,
                        })
                      : i18n.t('settings.backup_failed')}
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
