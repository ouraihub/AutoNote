<script lang="ts">
  import type { Backend } from '@app/backend'
  import type { I18nState } from '@app/i18n/runtime.svelte'
  import type { Notifier } from '@app/platform/notifier'
  import { setBackend, setI18n, setNotes, setNotifier, setSession, setUi } from '@app/root/context'
  import type { NotesState } from '@app/state/notes.svelte'
  import type { SessionState } from '@app/state/session.svelte'
  import type { UiState } from '@app/state/ui.svelte'
  import SharePanel from './SharePanel.svelte'

  let { backend, notes, ui, session, i18n, notifier, onClose }: {
    backend: Backend
    notes: NotesState
    ui: UiState
    session: SessionState
    i18n: I18nState
    notifier: Notifier
    onClose: () => void
  } = $props()
  function provide(): void {
    setBackend(backend)
    setNotes(notes)
    setUi(ui)
    setSession(session)
    setI18n(i18n)
    setNotifier(notifier)
  }
  provide()
</script>

<SharePanel {onClose} />
