<script lang="ts">
  import { Toaster } from './sonner'
  import ConfirmationHost from './ConfirmationHost.svelte'
  import type { OverlayNotifier, MessageResolver } from './overlay-notifier.svelte'

  interface Props {
    notifier: OverlayNotifier
    resolveMessage: MessageResolver
  }

  let { notifier, resolveMessage }: Props = $props()
</script>

<Toaster />
<ConfirmationHost {notifier} {resolveMessage} />
