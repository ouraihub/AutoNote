<script lang="ts">
  import { PanelLeftClose, X } from '@lucide/svelte'
  import { getBackend, getI18n, getUi } from '@app/root/context'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import Logo from '@app/components/primitives/Logo.svelte'

  let { narrow }: { narrow: boolean } = $props()
  const ui = getUi(),
    i18n = getI18n(),
    showBrand = getBackend().kind !== 'desktop'
</script>

<header
  class={[
    'flex h-11 shrink-0 items-center border-b ' +
      'border-[var(--border-subtle)] px-3',
    showBrand ? 'justify-between' : 'justify-end',
  ]}
>
  {#if showBrand}
    <div class="flex min-w-0 items-center gap-[9px] select-none">
      <Logo size={24} />
      <span
        class={'min-w-0 truncate font-serif text-[15.5px] font-semibold ' +
          'tracking-[0.02em] text-[var(--text-primary)]'}
        >{i18n.t('common.product_name')}</span
      >
    </div>
  {/if}
  <IconButton
    label={i18n.t(narrow ? 'common.close' : 'sidebar.collapse_navigation')}
    title={i18n.t(narrow ? 'common.close' : 'sidebar.collapse_navigation')}
    size="sm"
    onclick={() => (narrow ? ui.toggleNavDrawer(false) : ui.toggleNav())}
  >
    {#if narrow}<X size={15} />{:else}<PanelLeftClose size={15} />{/if}
  </IconButton>
</header>
