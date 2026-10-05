<script lang="ts">
  import { onMount } from 'svelte'
  import type { AppHandle } from '@app/root'
  import { Button } from '@app/components/ui/button'
  import { bootDesktop } from '$lib/host/compose'
  import { I18nState } from '@app/i18n/runtime.svelte'
  import { DesktopPrefs } from '$lib/prefs/local-prefs'
  const i18n = new I18nState({ prefs: new DesktopPrefs() })
  let target = $state<HTMLDivElement>()
  let error = $state(false)
  let loading = $state(false)
  let active = false
  let handle: AppHandle | undefined
  async function start(): Promise<void> {
    if (!target || loading || handle) return
    loading = true
    error = false
    try {
      const mounted = await bootDesktop(target)
      if (!active) await mounted.destroy()
      else handle = mounted
    } catch {
      if (active) error = true
    } finally {
      loading = false
    }
  }
  onMount(() => {
    active = true
    void i18n.init()
    void start()
    return () => {
      active = false
      void handle?.destroy().catch(() => {
        error = true
      })
    }
  })
</script>

<div class="h-dvh min-h-0">
  <div bind:this={target} class="h-full min-h-0"></div>
  {#if error}<section class="absolute inset-0 flex flex-col items-center justify-center gap-4" role="alert">
      <p>{i18n.t('desktop.startupFailed')}</p>
      <Button disabled={loading} onclick={() => void start()}>{i18n.t('desktop.retry')}</Button>
    </section>{/if}
</div>
