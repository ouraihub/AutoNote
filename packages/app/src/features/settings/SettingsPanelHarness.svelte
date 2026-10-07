<script lang="ts">
  import type { Backend } from '@app/backend'
  import type { HostSettingsSection } from '@app/root/types'
  import type { I18nState } from '@app/i18n/runtime.svelte'
  import type { SessionState } from '@app/state/session.svelte'
  import type { NotesState } from '@app/state/notes.svelte'
  import type { SettingsState } from '@app/state/settings.svelte'
  import type { Notifier } from '@app/platform/notifier'
  import { setBackend, setExtensions, setI18n, setNotes, setNotifier, setSession, setSettings, setUi } from '@app/root/context'
  import type { UiState } from '@app/state/ui.svelte'
  import SettingsPanel from './SettingsPanel.svelte'

  interface Props {
    backend: Backend
    extensions: HostSettingsSection[]
    session: SessionState
    i18n: I18nState
    epoch?: number
    settings: SettingsState
    notes: NotesState
    notifier: Notifier
    onClose(): void
  }
  const props: Props = $props()
  function provide(): void {
    setBackend(props.backend)
    setExtensions({ settingsSections: props.extensions, aboutPanels: [] })
    setSession({ ...props.session, get epoch() { return props.epoch ?? props.session.epoch } } as SessionState)
    setI18n(props.i18n)
    setSettings(props.settings)
    setNotes(props.notes)
    setNotifier(props.notifier)
    setUi({ openPanel() {} } as unknown as UiState)
  }
  provide()
</script>

<SettingsPanel onClose={props.onClose} />
