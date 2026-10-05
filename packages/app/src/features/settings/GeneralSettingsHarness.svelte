<script lang="ts">
  import type { Backend } from '@app/backend'
  import type { I18nState } from '@app/i18n/runtime.svelte'
  import type { NotesState } from '@app/state/notes.svelte'
  import type { SessionState } from '@app/state/session.svelte'
  import type { SettingsState } from '@app/state/settings.svelte'
  import type { Notifier } from '@app/platform/notifier'
  import { setBackend, setExtensions, setI18n, setNotes, setNotifier, setSession, setSettings } from '@app/root/context'
  import AppearanceSettings from './AppearanceSettings.svelte'
  import EditorSettings from './EditorSettings.svelte'
  import SyncSettings from './SyncSettings.svelte'
  import DataSettings from './DataSettings.svelte'
  import AboutSettings from './AboutSettings.svelte'
  import AttachmentManager from './AttachmentManager.svelte'

  interface Props {
    section: 'appearance' | 'editor' | 'sync' | 'data' | 'about' | 'attachments'
    backend: Backend
    settings: SettingsState
    i18n: I18nState
    notes: NotesState
    session: SessionState
    notifier: Notifier
  }
  let { section, backend, settings, i18n, notes, session, notifier }: Props = $props()
  function provide(): void {
    setBackend(backend)
    setExtensions({ settingsSections: [], aboutPanels: [] })
    setSettings(settings)
    setI18n(i18n)
    setNotes(notes)
    setSession(session)
    setNotifier(notifier)
  }
  provide()
</script>

{#if section === 'appearance'}<AppearanceSettings />
{:else if section === 'editor'}<EditorSettings />
{:else if section === 'sync'}<SyncSettings />
{:else if section === 'data'}<DataSettings />
{:else if section === 'about'}<AboutSettings />
{:else}<AttachmentManager />{/if}
