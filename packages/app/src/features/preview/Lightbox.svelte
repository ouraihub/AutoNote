<script lang="ts">
  import * as Dialog from '../../components/ui/dialog'
  import { Button } from '../../components/ui/button'
  import { getI18n, getUi } from '../../root/context'
  interface Props {
    onCloseFocus?(): void
  }
  let { onCloseFocus }: Props = $props()
  const ui = getUi()
  const i18n = getI18n()
  const open = $derived(ui.lightbox !== null)
  let scale = $state(1)
  let failed = $state(false)
  $effect(() => {
    if (ui.lightbox !== null) {
      scale = 1
      failed = false
    }
  })
  function zoom(delta: number): void {
    scale = Math.max(0.3, Math.min(6, scale + delta))
  }
  function wheel(event: WheelEvent): void {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      zoom(-event.deltaY * 0.002)
    }
  }
</script>

<Dialog.Root
  {open}
  onOpenChange={(value) => {
    if (!value) ui.setLightbox(null)
  }}
>
  <Dialog.Content
    showCloseButton={false}
    class="flex max-h-[92vh] w-[92vw] flex-col sm:max-w-[92vw]"
    onCloseAutoFocus={(event) => {
      if (onCloseFocus) {
        event.preventDefault()
        onCloseFocus()
      }
    }}
  >
    <Dialog.Header><Dialog.Title>{i18n.t('preview.image_preview')}</Dialog.Title></Dialog.Header>
    <div class="flex items-center gap-2">
      <Button variant="ghost" size="sm" disabled={failed || scale <= 0.3} onclick={() => zoom(-0.25)}
        >{i18n.t('common.zoom_out')}</Button
      >
      <output aria-live="polite">{Math.round(scale * 100)}%</output>
      <Button variant="ghost" size="sm" disabled={failed || scale >= 6} onclick={() => zoom(0.25)}
        >{i18n.t('common.zoom_in')}</Button
      >
      {#if ui.lightbox}<Button
          variant="link"
          onclick={() => window.open(ui.lightbox?.src, '_blank', 'noopener,noreferrer')}
          >{i18n.t('preview.download_original_image')}</Button
        >{/if}
      <Button variant="ghost" size="sm" onclick={() => ui.setLightbox(null)}>{i18n.t('common.close')}</Button>
    </div>
    {#if ui.lightbox}
      <div class="image-viewport" role="region" aria-label={i18n.t('preview.image_preview')} onwheel={wheel}>
        {#if failed}<p role="status">{i18n.t('preview.could_not_load_image')}</p>
        {:else}<button
            type="button"
            class="image-button"
            aria-label={i18n.t(scale === 1 ? 'common.zoom_in' : 'common.zoom_out')}
            onclick={() => (scale = scale === 1 ? 2 : 1)}
            ><img
              src={ui.lightbox.src}
              alt={ui.lightbox.alt}
              onerror={() => (failed = true)}
              style:transform={`scale(${scale})`}
            /></button
          >{/if}
      </div>
      {#if ui.lightbox.alt}<Dialog.Description>{ui.lightbox.alt}</Dialog.Description>{/if}
    {/if}
  </Dialog.Content>
</Dialog.Root>

<style>
  /* Hallmark · component: image dialog · genre: editorial · theme: inherited tokens */
  .image-viewport {
    overflow: auto;
    min-height: 0;
    display: grid;
    place-items: center;
  }
  .image-button {
    min-width: 0;
    max-width: 100%;
    cursor: zoom-in;
  }
  .image-button:focus-visible {
    outline: 2px solid var(--accent);
  }
  img {
    max-height: 70vh;
    max-width: 100%;
    object-fit: contain;
    transform-origin: center;
    cursor: zoom-in;
  }
  output {
    font-size: 12px;
    color: var(--text-tertiary);
  }
</style>
