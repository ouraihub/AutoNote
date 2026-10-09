<script lang="ts">
  import type { Backend } from '@app/backend'
  import type { I18nState } from '@app/i18n/runtime.svelte'
  import type { Notifier } from '@app/platform/notifier'
  import { setBackend, setI18n, setNotifier } from '@app/root/context'
  import AiSection from './AiSection.svelte'

  let { backend, i18n, notifier }: { backend: Backend; i18n: I18nState; notifier: Notifier } = $props()
  function provide(): void {
    setBackend(backend)
    setI18n(i18n)
    setNotifier(notifier)
  }
  provide()
</script>

<AiSection />
