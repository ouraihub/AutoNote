<script lang="ts">
  import type { Component } from 'svelte'
  import type { Backend } from '@app/backend'
  import type { SessionState } from '@app/state/session.svelte'
  import type { SettingsState } from '@app/state/settings.svelte'
  import type { I18nState } from '@app/i18n/runtime.svelte'
  import type { Notifier } from '@app/platform/notifier'
  import { setBackend, setI18n, setNotifier, setSession, setSettings } from '@app/root/context'

  let { component: Dynamic, backend, session, i18n, notifier, settings }: {
    component: Component<Record<string, never>>
    backend: Backend
    session: SessionState
    i18n: I18nState
    notifier: Notifier
    settings?: SettingsState
  } = $props()
  function provide(): void {
    setBackend(backend)
    setSession(session)
    setI18n(i18n)
    setNotifier(notifier)
    if (settings) setSettings(settings)
  }
  provide()
</script>

<Dynamic />
