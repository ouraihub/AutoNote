<script lang="ts">
  import type { Backend } from '@app/backend'
  import type { I18nState } from '@app/i18n/runtime.svelte'
  import type { Notifier } from '@app/platform/notifier'
  import type { PrefsStore } from '@app/platform/prefs'
  import { setBackend, setI18n, setNotifier, setPrefs, setUi } from '@app/root/context'
  import type { UiState } from '@app/state/ui.svelte'
  import type { WorkspacePanelProps } from '@app/root/types'
  import ChatPanel from './ChatPanel.svelte'

  let {
    backend,
    i18n,
    notifier,
    prefs,
    ui = { panel: null } as UiState,
    ...panel
  }: WorkspacePanelProps & {
    backend: Backend
    i18n: I18nState
    notifier: Notifier
    prefs: PrefsStore
    ui?: UiState
  } = $props()
  function provide(): void {
    setBackend(backend)
    setI18n(i18n)
    setNotifier(notifier)
    setPrefs(prefs)
    // ChatPanel only reads `panel` (reload models once settings closes).
    setUi(ui)
  }
  provide()
</script>

<ChatPanel {...panel} />
