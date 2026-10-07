<script lang="ts">
  import { untrack, type ComponentProps } from 'svelte'
  import type { I18nState } from '@app/i18n/runtime.svelte'
  import { setI18n } from '@app/root/context'
  import VersionsPanel from './VersionsPanel.svelte'

  let props: ComponentProps<typeof VersionsPanel> = $props()
  setI18n(untrack(() => props.i18n) as I18nState)
</script>

<VersionsPanel {...props} />
