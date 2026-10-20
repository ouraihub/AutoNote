<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { mountApp } from '@app/root'
  import type { AppHandle } from '@app/root'
  import { BackendError } from '@app/backend'
  import { createWebRuntime, CLIENT_ID, IS_DEMO_MODE } from './runtime'
  import type { WebServices } from './runtime'
  import { parseRoute } from './router'
  import { PwaState, PwaPanel } from './pwa'
  import { SharePage } from './share'
  import OverlayProvider from '@app/components/ui/OverlayProvider.svelte'
  import DownloadPage from './DownloadPage.svelte'
  import { setI18n, setNotifier } from '@app/root'
  import type { MessageKey } from '@shared/locales/en-US'

  let { services }: { services: WebServices } = $props()
  // svelte-ignore state_referenced_locally
  setI18n(services.language)
  // svelte-ignore state_referenced_locally
  setNotifier(services.notifier)
  let target = $state<HTMLDivElement>()
  let route = $state(parseRoute(location.pathname, import.meta.env.DEV))
  let error = $state(false)
  let app: AppHandle | null = null
  let pwa: PwaState | null = null
  let active = true
  let navigating = false
  let path = location.pathname
  let navigation: Promise<void> = Promise.resolve()

  function report(cause: unknown): void {
    error = true
    services.logger.error('host.lifecycle.failed', { code: cause instanceof BackendError ? cause.code : 'internal' })
  }
  async function boot(): Promise<void> {
    if (!active || route.kind !== 'app' || !target || app) return
    const deps = createWebRuntime(services)
    const nextPwa = new PwaState({
      logger: services.logger,
      flush: async () => {
        if (!app) throw new Error('Application is not mounted')
        return app.flush()
      },
    })
    deps.extensions = {
      ...deps.extensions,
      onNoteOpened: (id) => {
        if (navigating || !active) return
        const next = `/n/${encodeURIComponent(id)}`
        if (location.pathname !== next) history.pushState(null, '', next)
        path = next
      },
      aboutPanels: [
        ...deps.extensions.aboutPanels,
        { id: 'pwa', order: 90, titleKey: 'pwa.app_installation', component: PwaPanel, props: { state: nextPwa } },
      ],
    }
    try {
      app = mountApp(target, deps)
      pwa = nextPwa
      pwa.start()
      pwa.requestOfflineWarmup()
      const initial = route
      if (initial.kind === 'app' && initial.noteId) {
        navigating = true
        try {
          await app.openNote(initial.noteId)
        } finally {
          navigating = false
        }
      }
    } catch (cause) {
      nextPwa.dispose()
      if (!app) await deps.backend.dispose()
      throw cause
    }
  }
  async function leave(): Promise<void> {
    if (app) {
      await app.destroy()
      app = null
    }
    pwa?.dispose()
    pwa = null
  }
  async function navigate(): Promise<void> {
    const destination = location.pathname
    const next = parseRoute(destination, import.meta.env.DEV)
    navigating = true
    error = false
    try {
      if (app && next.kind === 'app') {
        const saved = await app.flush()
        if (saved.failed) throw new BackendError('internal', 0, 'Local save failed')
        await app.openNote(next.noteId)
      } else {
        await leave()
        route = next
        await tick()
        await boot()
      }
      path = destination
    } catch (cause) {
      history.replaceState(null, '', path)
      report(cause)
    } finally {
      navigating = false
    }
  }
  onMount(() => {
    services.logger.info('host.lifecycle.started', {
      mode: IS_DEMO_MODE ? 'demo' : import.meta.env.DEV ? 'development' : 'production',
    })
    void boot().catch(report)
    const popstate = (): void => {
      navigation = navigation.then(navigate).catch(report)
    }
    const pagehide = (): void => {
      if (app) void app.flush().catch(report)
    }
    window.addEventListener('popstate', popstate)
    window.addEventListener('pagehide', pagehide)
    return () => {
      active = false
      window.removeEventListener('popstate', popstate)
      window.removeEventListener('pagehide', pagehide)
      void navigation
        .then(leave)
        .then(() => {
          services.dispose()
          services.logger.info('host.lifecycle.disposed')
        })
        .catch(report)
    }
  })
</script>

{#if IS_DEMO_MODE}<div
    role="status"
    class="border-b border-[var(--border-default)] bg-[var(--bg-surface)] px-4 py-2 text-sm text-[var(--text-secondary)]"
  >
    {services.language.t('host.demo_notice')}
    {services.language.t('host.demo_credentials')}
  </div>{/if}
{#if error}
  <section
    role="alert"
    class="border-b border-[var(--border-default)] bg-[var(--bg-base)] p-4 text-[var(--text-primary)]"
  >
    <p>{services.language.t('common.action_failed')}</p>
    <button
      type="button"
      onclick={() => {
        error = false
        void navigate().catch(report)
      }}>{services.language.t('common.retry')}</button
    >
  </section>
{/if}
{#if route.kind === 'app'}
  <div bind:this={target} class="h-dvh min-h-0" data-web-host></div>
{:else if route.kind === 'download'}
  <DownloadPage language={services.language} />
{:else if route.kind === 'share'}
  {#key route.slug}
    <SharePage
      slug={route.slug}
      fetch={services.fetch}
      logger={services.logger}
      language={services.language}
      notifier={services.notifier}
      clientId={CLIENT_ID}
      {...services.resolveFileUrl ? { resolveFileUrl: services.resolveFileUrl } : {}}
    />
  {/key}
  <OverlayProvider
    notifier={services.notifier}
    resolveMessage={(key, params) => services.language.t(key as MessageKey, params)}
  />
{:else}
  <p role="alert" class="p-4">{services.language.t('api.error.not_found')}</p>
{/if}
