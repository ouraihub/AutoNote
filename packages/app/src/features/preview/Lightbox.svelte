<script lang="ts">
  import { Dialog } from 'bits-ui'
  import { Download, ImageOff, X, ZoomIn, ZoomOut } from '@lucide/svelte'
  import IconButton from '../../components/primitives/IconButton.svelte'
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
  const close = (): void => ui.setLightbox(null)
  const control = 'text-white/70 hover:bg-white/10 hover:text-white'
</script>

<Dialog.Root
  {open}
  onOpenChange={(value) => {
    if (!value) close()
  }}
>
  <Dialog.Portal>
    <Dialog.Content
      aria-label={i18n.t('preview.image_preview')}
      class="app-viewport-fixed anim-fade fixed inset-0 z-[260] flex items-center justify-center bg-[oklch(0%_0_0/78%)] backdrop-blur-[2px] outline-none"
      onclick={close}
      onwheel={wheel}
      onCloseAutoFocus={(event) => {
        if (onCloseFocus) {
          event.preventDefault()
          onCloseFocus()
        }
      }}
    >
      <Dialog.Title class="sr-only">{i18n.t('preview.image_preview')}</Dialog.Title>
      <div role="presentation" class="absolute top-[calc(12px+env(safe-area-inset-top))] right-2 flex items-center gap-1 md:top-4 md:right-4" onclick={(event) => event.stopPropagation()}>
        <IconButton label={i18n.t('common.zoom_out')} title={i18n.t('common.zoom_out')} disabled={failed || scale <= 0.3} onclick={() => zoom(-0.25)} class={control}><ZoomOut size={16} /></IconButton>
        <span aria-live="polite" class="tabular w-11 text-center text-[11.5px] text-white/60">{Math.round(scale * 100)}%</span>
        <IconButton label={i18n.t('common.zoom_in')} title={i18n.t('common.zoom_in')} disabled={failed || scale >= 6} onclick={() => zoom(0.25)} class={control}><ZoomIn size={16} /></IconButton>
        {#if ui.lightbox}
          <a href={ui.lightbox.src} download target="_blank" rel="external noopener noreferrer" aria-label={i18n.t('preview.download_original_image')} title={i18n.t('preview.download_original_image')} class="inline-flex size-9 items-center justify-center rounded-[var(--r-md)] text-white/70 transition-colors hover:bg-white/10 hover:text-white md:size-7"><Download size={16} /></a>
        {/if}
        <IconButton label={i18n.t('common.close')} title={i18n.t('common.close')} onclick={close} class={control}><X size={17} /></IconButton>
      </div>
      {#if ui.lightbox}
        {#if failed}
          <div role="status" class="flex max-w-[80vw] flex-col items-center gap-2 rounded-[var(--r-lg)] bg-black/35 px-5 py-4 text-center text-[12px] text-white/75">
            <ImageOff size={24} />
            {i18n.t('preview.could_not_load_image')}
          </div>
        {:else}
          <button type="button" class="contents" aria-label={i18n.t(scale === 1 ? 'common.zoom_in' : 'common.zoom_out')} onclick={(event) => { event.stopPropagation(); scale = scale === 1 ? 2 : 1 }}>
            <img src={ui.lightbox.src} alt={ui.lightbox.alt} onerror={() => (failed = true)} style:transform={`scale(${scale})`} class={['max-h-[86vh] max-w-[92vw] rounded-[var(--r-md)] object-contain transition-transform duration-200 ease-[var(--ease-out)]', scale === 1 ? 'cursor-zoom-in' : 'cursor-zoom-out']} />
          </button>
        {/if}
        {#if ui.lightbox.alt}
          <Dialog.Description class="absolute bottom-[calc(16px+env(safe-area-inset-bottom))] left-1/2 max-w-[82vw] -translate-x-1/2 truncate rounded-full bg-black/50 px-3 py-1.5 text-[12px] text-white/80 md:bottom-6 md:max-w-[70vw]">{ui.lightbox.alt}</Dialog.Description>
        {/if}
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
