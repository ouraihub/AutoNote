<script lang="ts">
  import { Button } from '../components/ui/button'
  import { Checkbox } from '../components/ui/checkbox'
  import * as Dialog from '../components/ui/dialog'
  import * as Drawer from '../components/ui/drawer'
  import * as Field from '../components/ui/field'
  import { Input } from '../components/ui/input'
  import OverlayProvider from '../components/ui/OverlayProvider.svelte'
  import { Segmented } from '../components/ui/segmented'
  import { Slider } from '../components/ui/slider'
  import { Switch } from '../components/ui/switch'
  import { Textarea } from '../components/ui/textarea'
  import { OverlayNotifier } from '../components/ui/overlay-notifier.svelte'
  import { EN_US_MESSAGES, type MessageKey } from '@shared/locales/en-US'

  let dialogOpen = $state(false)
  let drawerOpen = $state(false)
  let checked = $state(false)
  let enabled = $state(true)
  let layout = $state('split')
  let size = $state(14)
  const notifier = new OverlayNotifier(t)

  function t(key: string, params?: Readonly<Record<string, string | number>>): string {
    const template = EN_US_MESSAGES[key as MessageKey] ?? key
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => String(params?.[name] ?? whole))
  }

  function showFeedback(): void {
    notifier.toast({ key: 'gallery.feedback', tone: 'success' })
  }

  function askForConfirmation(): void {
    void notifier.confirm({ titleKey: t('gallery.confirmation_title'), bodyKey: t('gallery.confirmation_body'), danger: true })
  }
</script>

<svelte:head>
  <title>{t('gallery.title')}</title>
</svelte:head>

<main class="min-h-dvh bg-background p-6 text-foreground sm:p-10" data-testid="gallery">
  <div class="mx-auto flex max-w-3xl flex-col gap-8">
    <header class="flex flex-col gap-2">
      <p class="text-sm text-muted-foreground">{t('gallery.development_only')}</p>
      <h1 class="text-2xl font-semibold">{t('gallery.title')}</h1>
      <p class="text-sm text-muted-foreground">{t('gallery.description')}</p>
    </header>

    <section class="flex flex-col gap-4" aria-labelledby="gallery-actions">
      <h2 id="gallery-actions" class="text-lg font-medium">{t('gallery.actions')}</h2>
      <div class="flex flex-wrap gap-2">
        <Button onclick={showFeedback}>{t('gallery.show_notification')}</Button>
        <Button variant="outline" onclick={() => (dialogOpen = true)}>{t('gallery.open_dialog')}</Button>
        <Button variant="outline" onclick={() => (drawerOpen = true)}>{t('gallery.open_drawer')}</Button>
        <Button variant="destructive" onclick={askForConfirmation}>{t('gallery.ask_confirmation')}</Button>
        <Button disabled>{t('gallery.disabled_action')}</Button>
      </div>
    </section>

    <Field.Group class="max-w-xl" aria-label={t('gallery.controls')}>
      <Field.Field>
        <Field.Label for="gallery-title">{t('gallery.long_title')}</Field.Label>
        <Input id="gallery-title" value={t('gallery.long_title_value')} />
        <Field.Description>{t('gallery.input_help')}</Field.Description>
      </Field.Field>
      <Field.Field data-invalid>
        <Field.Label for="gallery-error">{t('gallery.validation')}</Field.Label>
        <Textarea id="gallery-error" aria-invalid value={t('gallery.validation_value')} />
        <Field.Error>{t('gallery.validation_message')}</Field.Error>
      </Field.Field>
      <Field.Field orientation="horizontal">
        <Switch id="gallery-switch" bind:checked={enabled} />
        <Field.Content>
          <Field.Label for="gallery-switch">{t('gallery.enable_preview')}</Field.Label>
          <Field.Description>{t('gallery.keyboard_help')}</Field.Description>
        </Field.Content>
      </Field.Field>
      <Field.Field orientation="horizontal">
        <Checkbox id="gallery-checkbox" bind:checked />
        <Field.Label for="gallery-checkbox">{t('gallery.completed_tasks')}</Field.Label>
      </Field.Field>
      <Field.Field>
        <Field.Label>{t('gallery.editor_layout')}</Field.Label>
        <Segmented
          ariaLabel={t('gallery.editor_layout')}
          options={[
            { value: 'live', label: t('gallery.live') },
            { value: 'split', label: t('gallery.split') },
            { value: 'preview', label: t('gallery.preview') },
          ]}
          bind:value={layout}
        />
      </Field.Field>
      <Field.Field>
        <Field.Label id="gallery-size-label" for="gallery-size">{t('gallery.editor_size', { size })}</Field.Label>
        <Slider id="gallery-size" aria-labelledby="gallery-size-label" type="single" bind:value={size} min={12} max={18} step={1} />
      </Field.Field>
    </Field.Group>
  </div>
</main>

<Dialog.Root bind:open={dialogOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>{t('gallery.dialog_title')}</Dialog.Title>
      <Dialog.Description>{t('gallery.dialog_description')}</Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Dialog.Close>{t('gallery.close_dialog')}</Dialog.Close>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Drawer.Root bind:open={drawerOpen}>
  <Drawer.Content>
    <Drawer.Header>
      <Drawer.Title>{t('gallery.drawer_title')}</Drawer.Title>
      <Drawer.Description>{t('gallery.drawer_description')}</Drawer.Description>
    </Drawer.Header>
    <Drawer.Footer>
      <Drawer.Close>{t('gallery.close_drawer')}</Drawer.Close>
    </Drawer.Footer>
  </Drawer.Content>
</Drawer.Root>

<OverlayProvider {notifier} resolveMessage={t} />
