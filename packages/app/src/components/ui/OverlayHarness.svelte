<script lang="ts">
  import * as Dialog from './dialog'
  import { Button } from './button'
  import OverlayProvider from './OverlayProvider.svelte'
  import { OverlayNotifier } from './overlay-notifier.svelte'

  let primaryOpen = $state(false)
  let nestedOpen = $state(false)
  const notifier = new OverlayNotifier((key) => key)

  function askFirst(): void {
    void notifier.confirm({ titleKey: 'First confirmation', bodyKey: 'First body' })
  }

  function askSecond(): void {
    void notifier.confirm({ titleKey: 'Second confirmation', bodyKey: 'Second body', danger: true })
  }
</script>

<Button onclick={() => (primaryOpen = true)}>Open primary</Button>
<Button onclick={askFirst}>Ask first</Button>
<Button onclick={askSecond}>Ask second</Button>

<Dialog.Root bind:open={primaryOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Primary dialog</Dialog.Title>
      <Dialog.Description>Primary dialog body</Dialog.Description>
    </Dialog.Header>
    <Button onclick={() => (nestedOpen = true)}>Open nested</Button>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={nestedOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Nested dialog</Dialog.Title>
      <Dialog.Description>Nested dialog body</Dialog.Description>
    </Dialog.Header>
  </Dialog.Content>
</Dialog.Root>

<OverlayProvider {notifier} resolveMessage={(key) => key === 'common.cancel' ? 'Cancel' : 'Confirm'} />
