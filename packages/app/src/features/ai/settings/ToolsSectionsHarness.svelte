<script lang="ts">
  import { untrack } from 'svelte'
  import { createI18n, setKitContext } from '@ouraihub/aether-ui'
  import type { Backend } from '@app/backend'
  import type { I18nState } from '@app/i18n/runtime.svelte'
  import { setI18n } from '@app/root/context'
  import { aiHostExtensions } from '../index'

  let { backend, i18n, section }: { backend: Backend; i18n: I18nState; section: string } = $props()
  untrack(() => {
    setI18n(i18n)
    setKitContext({
      ports: backend.aiHost!.kit,
      i18n: createI18n('en'),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      notify: { toast() {}, confirm: async () => true },
    })
  })
  const selected = $derived(aiHostExtensions(backend).settingsSections.find((item) => item.id === section))
</script>

{#if selected}
  {@const Section = selected.component}
  <Section />
{/if}
