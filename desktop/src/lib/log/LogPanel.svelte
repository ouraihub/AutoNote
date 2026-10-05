<script lang="ts">
  import { onMount } from 'svelte'
  import { Switch } from '@app/components/ui/switch'
  import { Button } from '@app/components/ui/button'
  import { LogsState } from './logs.svelte'
  import { getI18n } from '@app/root'
  import { call } from '../ipc/transport'

  const i18n = getI18n()
  const logs = new LogsState({
    readLogs: (limit) => call('app_logs_tail', { limit }),
    readAvailability: async () => (await call('desktop_prefs_get', undefined)).logAvailable,
  })
  onMount(() => {
    logs.start()
    return () => logs.stop()
  })
</script>

<section class="log-panel" aria-labelledby="log-heading">
  <header>
    <div>
      <h2 id="log-heading">{i18n.t('desktop.logsTitle')}</h2>
      <p aria-live="polite">{i18n.t('desktop.logsRecent', { count: logs.entries.length })}</p>
    </div>
    <div class="actions">
      <div class="flex items-center gap-2">
        <Switch id="only-log-problems" bind:checked={logs.onlyProblems} />
        <label for="only-log-problems">{i18n.t('desktop.logsOnlyProblems')}</label>
      </div>
      <Button variant="outline" size="sm" disabled={logs.loading} onclick={() => void logs.refresh()}>
        {i18n.t(logs.loading ? 'common.loading' : 'desktop.logsRefresh')}
      </Button>
    </div>
  </header>
  {#if logs.error}<p class="error" role="alert">{i18n.t('desktop.logsReadFailed')}</p>{/if}
  {#if !logs.available}<p class="error" role="status">{i18n.t('desktop.logUnavailable')}</p>{/if}
  {#if !logs.loading && logs.visible.length === 0}
    <p class="empty">{i18n.t(logs.onlyProblems ? 'desktop.logsNoProblems' : 'desktop.logsEmpty')}</p>
  {:else}
    <div class="log-rows" role="region" aria-label={i18n.t('desktop.logsRecords')}>
      {#each logs.visible as entry (entry.seq)}
        <div class="log-row" class:problem={entry.level === 'ERROR'} class:warning={entry.level === 'WARN'}>
          <time datetime={entry.time || undefined}>{entry.time.slice(11, 19) || '—'}</time>
          <strong>{entry.level}</strong>
          <span class="target" title={entry.target}>{entry.target.split('::').at(-1)}</span>
          <span class="message">{entry.message}</span>
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  /* Hallmark · component: log reader · theme: existing AutoNote tokens
   * pre-emit critique: P5 H4 E4 S5 R5 V4 */
  .log-panel {
    border: 1px solid var(--border-default);
    border-radius: var(--r-sm);
    min-width: 0;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 16px;
    padding: 16px;
    border-bottom: 1px solid var(--border-default);
  }
  h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  p {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 16px;
  }
  label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    white-space: nowrap;
  }
  .log-rows {
    max-height: 65vh;
    overflow: auto;
    padding: 8px;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .log-row {
    display: flex;
    gap: 12px;
    padding: 4px 8px;
    width: max-content;
    min-width: 100%;
    line-height: 1.6;
  }
  .log-row:hover {
    background: var(--bg-hover);
  }
  time,
  .target {
    color: var(--text-secondary);
  }
  time {
    width: 8ch;
  }
  strong {
    width: 5ch;
  }
  .message {
    white-space: pre;
  }
  .problem strong,
  .error {
    color: var(--danger);
  }
  .warning strong {
    color: var(--warning);
  }
  .empty,
  .error {
    padding: 16px;
    margin: 0;
  }
</style>
