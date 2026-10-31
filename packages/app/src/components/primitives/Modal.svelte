<script lang="ts">
  import type { Snippet } from 'svelte'
  import { Dialog as DialogPrimitive } from 'bits-ui'
  import { X } from '@lucide/svelte'
  import DialogPortal from '@app/components/ui/dialog/dialog-portal.svelte'
  import { getI18n } from '@app/root/context'
  import { cn } from '@app/utils'
  import IconButton from './IconButton.svelte'

  interface Props {
    open: boolean
    onClose: () => void
    title?: string | undefined
    description?: string | undefined
    width?: number | undefined
    class?: string | undefined
    children: Snippet
    footer?: Snippet | undefined
  }

  let {
    open,
    onClose,
    title,
    description,
    width = 560,
    class: className,
    children,
    footer,
  }: Props = $props()
  const i18n = getI18n()
</script>

<DialogPrimitive.Root
  {open}
  onOpenChange={(next) => {
    if (!next) onClose()
  }}
>
  <DialogPortal>
    <!-- Only while open: this fixed full-viewport wrapper is outside bits-ui's presence and would eat every click when closed. -->
    {#if open}<div
        class="app-viewport-fixed fixed z-[250] flex items-end justify-center overflow-hidden md:items-start md:overflow-y-auto md:p-8"
      >
        <DialogPrimitive.Overlay
          class="anim-fade absolute inset-0 bg-[var(--scrim)] backdrop-blur-[3px]"
        />
        <DialogPrimitive.Content
          aria-label={title ? undefined : i18n.t('overlay.dialog')}
          class={cn(
            'anim-pop relative flex max-h-[calc(var(--app-viewport-height,100dvh)-env(safe-area-inset-top))] w-full flex-col rounded-t-[var(--r-2xl)] border border-b-0 border-[var(--border-default)]',
            'bg-[var(--bg-overlay)] text-[var(--text-primary)] shadow-[var(--shadow-modal)] outline-none md:my-auto md:rounded-[var(--r-2xl)] md:border-b',
            className,
          )}
          style={`max-width: ${width}px`}
        >
          {#if title || description}
            <div
              class="flex shrink-0 items-start justify-between gap-4 px-4 pt-4 pb-3 md:px-5"
            >
              <div class="min-w-0">
                {#if title}<DialogPrimitive.Title
                    class="text-[15px] font-semibold tracking-[-0.012em] text-[var(--text-primary)]"
                    >{title}</DialogPrimitive.Title
                  >{/if}
                {#if description}<DialogPrimitive.Description
                    class="mt-1 text-[12.5px] leading-relaxed text-[var(--text-tertiary)]"
                    >{description}</DialogPrimitive.Description
                  >{/if}
              </div>
              <IconButton
                label={i18n.t('common.close')}
                title={i18n.t('common.close')}
                size="sm"
                onclick={onClose}
                class="-mt-0.5 -mr-1"><X size={15} /></IconButton
              >
            </div>
          {/if}
          <div class="min-h-0 overflow-y-auto px-4 pb-4 md:px-5 md:pb-5">
            {@render children()}
          </div>
          {#if footer}<div
              class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] md:px-5 md:py-3"
            >
              {@render footer()}
            </div>{/if}
        </DialogPrimitive.Content>
      </div>{/if}
  </DialogPortal>
</DialogPrimitive.Root>
