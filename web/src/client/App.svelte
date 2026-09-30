<script lang="ts">
  import type { SessionInfo } from '@shared/types'
  import { CLIENT_HEADER } from '@shared/constants'
  import { APP_VERSION } from '../release'

  let health = $state<'checking' | 'ok' | 'error'>('checking')
  let session = $state<SessionInfo | null>(null)

  $effect(() => {
    const controller = new AbortController()
    Promise.all([
      fetch('/api/health', { signal: controller.signal }),
      fetch('/api/auth/session', { signal: controller.signal, headers: { [CLIENT_HEADER]: '1' } }),
    ])
      .then(async ([healthRes, sessionRes]) => {
        health = healthRes.ok ? 'ok' : 'error'
        session = sessionRes.ok ? ((await sessionRes.json()) as SessionInfo) : null
      })
      .catch(() => {
        if (!controller.signal.aborted) health = 'error'
      })
    return () => controller.abort()
  })
</script>

<main class="grid min-h-dvh place-items-center bg-[var(--bg-base)] text-[var(--text-primary)]">
  <section class="flex flex-col items-center gap-4 text-center">
    <img src="/autonote-logo.png" alt="AutoNote" width="96" height="96" class="rounded-2xl" />
    <h1 class="text-2xl font-semibold">AutoNote</h1>
    <p class="text-sm opacity-70">v{APP_VERSION}</p>
    <dl class="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-sm">
      <dt class="opacity-70">API</dt>
      <dd data-testid="health">{health}</dd>
      <dt class="opacity-70">Site</dt>
      <dd data-testid="site">{session?.site?.name ?? '-'}</dd>
    </dl>
  </section>
</main>
