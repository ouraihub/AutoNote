<script lang="ts">
  import { untrack } from 'svelte'
  import {
    createI18n,
    setKitContext,
    type KitContext,
  } from '@ouraihub/aether-ui'
  import type { Backend } from '@app/backend'
  import type { PrefsStore } from '@app/platform/prefs'
  import type { I18nState } from '@app/i18n/runtime.svelte'
  import { EN_US_MESSAGES } from '@shared/locales/en-US'
  import { setBackend, setI18n, setPrefs } from '@app/root/context'
  import ChatPanel from './ChatPanel.svelte'

  let {
    backend,
    prefs,
    notify,
  }: { backend: Backend; prefs: PrefsStore; notify: KitContext['notify'] } =
    $props()
  untrack(() => {
    setBackend(backend)
    setPrefs(prefs)
    setI18n({
      locale: 'en-US',
      t: (key: keyof typeof EN_US_MESSAGES) => EN_US_MESSAGES[key],
    } as I18nState)
    setKitContext({
      ports: backend.aiHost!.kit,
      i18n: createI18n('en'),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      notify,
    })
  })
</script>

<ChatPanel
  note={null}
  insert={() => {}}
  saveNote={async () => {}}
  openSettings={() => {}}
  onClose={() => {}}
/>
