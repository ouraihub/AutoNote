<script lang="ts">
  import { untrack } from 'svelte'
  import type { Backend } from '@app/backend'
  import type { I18nState } from '@app/i18n/runtime.svelte'
  import type { SessionState } from '@app/state/session.svelte'
  import { setBackend, setI18n, setLogger, setSession } from '@app/root/context'
  import { createI18n, setKitContext } from '@ouraihub/aether-ui'
  import AiSection from './AiSection.svelte'

  let { backend, i18n }: { backend: Backend; i18n: I18nState } = $props()
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  untrack(() => {
    setBackend(backend)
    setI18n(i18n)
    setLogger(logger)
    setSession({ epoch: 1 } as SessionState)
    setKitContext({
      ports: backend.aiHost!.kit,
      i18n: createI18n('en'),
      logger,
      notify: { toast() {}, confirm: async () => true },
    })
  })
</script>

<AiSection />
