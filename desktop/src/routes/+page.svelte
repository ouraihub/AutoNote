<script lang="ts">
  import AppBrand from '@app/foundation/AppBrand.svelte'
  import { AppState } from '$lib/state/app.svelte'

  const app = new AppState()

  $effect(() => {
    void app.load()
  })
</script>

<main class="grid min-h-dvh place-items-center bg-base text-ink">
  <section class="flex flex-col items-center gap-4 text-center">
    <AppBrand />
    {#if app.loading}
      <p class="text-sm text-ink-2">…</p>
    {:else if app.error}
      <p class="text-sm text-ink-2" data-testid="error">{app.error}</p>
    {:else if app.info}
      <dl class="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-left text-sm">
        <dt class="text-ink-2">Version</dt>
        <dd data-testid="version">{app.info.version}</dd>
        <dt class="text-ink-2">Schema</dt>
        <dd data-testid="schema">{app.info.schemaVersion}</dd>
        <dt class="text-ink-2">Data</dt>
        <dd class="break-all" data-testid="data-dir">{app.info.dataDir}</dd>
      </dl>
    {/if}
  </section>
</main>
