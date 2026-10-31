<script lang="ts">
  import * as Dialog from './dialog'
  import { Button } from './button'
  import type { OverlayNotifier } from './overlay-notifier.svelte'
  import type { MessageResolver } from './overlay-notifier.svelte'

  interface Props {
    notifier: OverlayNotifier
    resolveMessage: MessageResolver
  }

  let { notifier, resolveMessage }: Props = $props()

  function closeFromOpenChange(open: boolean): void {
    if (!open) notifier.dismiss()
  }
</script>

<Dialog.Root bind:open={notifier.open} onOpenChange={closeFromOpenChange}>
  <Dialog.Content showCloseButton={false}>
    <Dialog.Header>
      <Dialog.Title
        >{notifier.active
          ? resolveMessage(
              notifier.active.request.titleKey,
              notifier.active.request.params,
            )
          : ''}</Dialog.Title
      >
      <Dialog.Description
        >{notifier.active
          ? resolveMessage(
              notifier.active.request.bodyKey,
              notifier.active.request.params,
            )
          : ''}</Dialog.Description
      >
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => notifier.settle(false)}
        >{resolveMessage('common.cancel')}</Button
      >
      <Button
        variant={notifier.active?.request.danger ? 'destructive' : 'default'}
        onclick={() => notifier.settle(true)}
      >
        {resolveMessage('overlay.confirm')}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
