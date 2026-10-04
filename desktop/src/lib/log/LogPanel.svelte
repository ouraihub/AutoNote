<script lang="ts">
  import { onMount } from 'svelte'
  import { Switch } from '@app/components/ui/switch'
  import { Button } from '@app/components/ui/button'
  import { LogsState } from './logs.svelte'

  const logs = new LogsState()
  onMount(() => {
    logs.start()
    return () => logs.stop()
  })
</script>

<section class="log-panel" aria-labelledby="log-heading">
  <header>
    <div>
      <h2 id="log-heading">后台日志</h2>
      <p aria-live="polite">最近 {logs.entries.length} 条 · 每 2 秒刷新</p>
    </div>
    <div class="actions">
      <div class="flex items-center gap-2">
        <Switch id="only-log-problems" bind:checked={logs.onlyProblems} />
        <label for="only-log-problems">只看问题</label>
      </div>
      <Button variant="outline" size="sm" disabled={logs.loading} onclick={() => void logs.refresh()}>
        {logs.loading ? '读取中…' : '刷新'}
      </Button>
    </div>
  </header>
  {#if logs.error}<p class="error" role="alert">{logs.error}</p>{/if}
  {#if !logs.loading && logs.visible.length === 0}
    <p class="empty">{logs.onlyProblems ? '没有警告或错误。' : '暂无日志。'}</p>
  {:else}
    <div class="log-rows" role="region" aria-label="日志记录">
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
  .log-panel { border: 1px solid var(--border-default); border-radius: var(--r-sm); min-width: 0; }
  header { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 16px; padding: 16px; border-bottom: 1px solid var(--border-default); }
  h2 { margin: 0; font-size: 14px; font-weight: 600; }
  p { margin: 4px 0 0; font-size: 12px; color: var(--text-secondary); }
  .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 16px; }
  label { display: flex; align-items: center; gap: 8px; font-size: 12px; white-space: nowrap; }
  .log-rows { max-height: 65vh; overflow: auto; padding: 8px; font-family: var(--font-mono); font-size: 12px; }
  .log-row { display: flex; gap: 12px; padding: 4px 8px; width: max-content; min-width: 100%; line-height: 1.6; }
  .log-row:hover { background: var(--bg-hover); }
  time, .target { color: var(--text-secondary); }
  time { width: 8ch; }
  strong { width: 5ch; }
  .message { white-space: pre; }
  .problem strong, .error { color: var(--danger); }
  .warning strong { color: var(--warning); }
  .empty, .error { padding: 16px; margin: 0; }
</style>
