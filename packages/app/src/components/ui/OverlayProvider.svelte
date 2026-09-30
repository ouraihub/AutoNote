<script lang="ts">
  import { Toaster } from './sonner'
  import ConfirmationHost from './ConfirmationHost.svelte'
  import type { OverlayNotifier } from './overlay-notifier.svelte'

  interface Props {
    notifier: OverlayNotifier
    resolveMessage: (key: string) => string
  }

  let { notifier, resolveMessage }: Props = $props()
</script>

<Toaster />
<ConfirmationHost {notifier} {resolveMessage} />
