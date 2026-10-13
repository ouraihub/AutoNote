<script lang="ts">
  import { onMount, setContext, untrack } from 'svelte'
  import type { MessageKey } from '@shared/locales/en-US'
  import { OverlayNotifier } from '../components/ui/overlay-notifier.svelte'
  import OverlayProvider from '../components/ui/OverlayProvider.svelte'
  import AppShell from '../features/shell/AppShell.svelte'
  import LoginPage from '../features/auth/LoginPage.svelte'
  import type { I18nState } from '../i18n/runtime.svelte'
  import type { NotesState } from '../state/notes.svelte'
  import type { SessionState } from '../state/session.svelte'
  import type { UiState } from '../state/ui.svelte'
  import type { OrganizeActions } from '../state/mutations'
  import type { SettingsState } from '../state/settings.svelte'
  import type { Notifier } from '../platform/notifier'
  import type { AppDeps } from './types'
  import { ThemeController } from '../theme/apply'
  import { provideKitContext } from '../features/ai/kit'
  import {
    setBackend,
    setClock,
    setExtensions,
    setI18n,
    setLogger,
    setNotes,
    setNotifier,
    setOrganize,
    setPrefs,
    setSession,
    setSettings,
    setUi,
    setRegisterFlush,
  } from './context'
  interface Props {
    deps: AppDeps
    i18n: I18nState
    notes: NotesState
    session: SessionState
    settings: SettingsState
    ui: UiState
    organize: OrganizeActions
    notifier: Notifier
    overlay: OverlayNotifier
    registerFlush(flush: () => Promise<void>): () => void
    onReadyChange(ready: boolean): void
  }

  let { deps, i18n, notes, session, settings, ui, organize, notifier, overlay, registerFlush, onReadyChange }: Props =
    $props()
  let surface = $state<HTMLDivElement>()
  setContext('autonote-surface', () => surface)
  setRegisterFlush((flush) => registerFlush(flush))
  let ready = $state(false)
  let loadFailed = $state(false)
  let retry = $state(0)
  const owner = $derived(session.status === 'authed' ? (session.user?.id ?? null) : null)
  let theme: ThemeController | undefined
  function provideContexts(read: () => Props): void {
    const value = read()
    setBackend(value.deps.backend)
    setClock(value.deps.clock)
    setLogger(value.deps.logger)
    setPrefs(value.deps.prefs)
    setNotifier(value.notifier)
    setExtensions(value.deps.extensions)
    setI18n(value.i18n)
    setNotes(value.notes)
    setSession(value.session)
    setSettings(value.settings)
    setUi(value.ui)
    setOrganize(value.organize)
    const aiHost = value.deps.backend.aiHost
    if (aiHost) provideKitContext(aiHost, value.i18n, value.notifier, value.deps.logger)
  }
  provideContexts(() => ({
    deps,
    i18n,
    notes,
    session,
    settings,
    ui,
    organize,
    notifier,
    overlay,
    registerFlush,
    onReadyChange,
  }))

  onMount(() => {
    let active = true
    if (surface && typeof matchMedia === 'function') {
      theme = new ThemeController(
        { documentElement: surface },
        ui.appearance,
        matchMedia('(prefers-color-scheme: dark)'),
        matchMedia('(prefers-reduced-motion: reduce)'),
      )
    }
    const unsubscribeNotes = notes.watch()
    const unsubscribeSession = session.watch(deps.backend.changes)
    void i18n
      .init()
      .then(() => {
        if (active) return session.load()
      })
      .catch((error: unknown) => {
        deps.logger.error('root.session.load_failed', { name: error instanceof Error ? error.name : 'unknown' })
      })
    return () => {
      active = false
      theme?.dispose()
      unsubscribeNotes()
      unsubscribeSession()
    }
  })

  $effect(() => {
    const account = owner
    void retry
    if (untrack(() => session.status) === 'loading') return
    let cancelled = false
    ready = false
    onReadyChange(false)
    loadFailed = false
    void untrack(async () => {
      try {
        await notes.reset()
        if (cancelled || !account) return
        await ui.load(account)
        if (cancelled) return
        await notes.bootstrap()
        if (cancelled) return
        for (const pane of ['primary', 'secondary'] as const) {
          const id = ui.panes[pane].noteId
          if (id !== null) await notes.open(id, pane)
        }
        if (!cancelled) {
          ready = notes.hydrated
          onReadyChange(ready)
          loadFailed = !ready
        }
      } catch (error) {
        if (!cancelled) {
          loadFailed = true
          deps.logger.error('root.library.load_failed', { name: error instanceof Error ? error.name : 'unknown' })
        }
      }
    })
    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    if (session.status !== 'authed') return
    const appearance = settings.current.appearance
    untrack(() => {
      ui.applyAppearance(appearance)
      ui.setDensity(appearance.density)
      theme?.setAppearance(appearance)
      void i18n.setLocale(appearance.language).catch((error: unknown) => {
        deps.logger.error('root.locale.load_failed', { name: error instanceof Error ? error.name : 'unknown' })
      })
    })
  })
</script>

<div bind:this={surface} class="h-full min-h-0 bg-[var(--bg-base)] text-[var(--text-primary)]" data-app-root>
  <OverlayProvider notifier={overlay} resolveMessage={(key, params) => i18n.t(key as MessageKey, params)} />
  {#if session.status === 'loading'}
    <p role="status">{i18n.t('common.loading')}</p>
  {:else if session.status === 'anonymous' && deps.backend.capabilities.accounts}
    <LoginPage {session} {i18n} defaults={deps.authDefaults} />
  {:else if session.status === 'authed'}
    <svelte:boundary
      onerror={(error) =>
        deps.logger.error('root.ui.render_failed', { name: error instanceof Error ? error.name : 'unknown' })}
    >
      {#if ready}<AppShell />
      {:else if loadFailed}<p role="alert">{i18n.t('common.action_failed')}</p>
        <button type="button" onclick={() => retry++}>{i18n.t('common.retry')}</button>
      {:else}<p role="status">{i18n.t('common.loading')}</p>{/if}
      {#snippet failed()}
        <p role="alert">{i18n.t('app.something_went_wrong')}</p>
      {/snippet}
    </svelte:boundary>
  {/if}
</div>
