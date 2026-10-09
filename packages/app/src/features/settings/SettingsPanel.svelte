<script lang="ts">
  import { onDestroy, type Component } from 'svelte'
  import { Dialog as DialogPrimitive } from 'bits-ui'
  import { BrainCircuit, Cloud, Database, Info, Keyboard, Link2, Palette, RefreshCw, Type, UserRound, X } from '@lucide/svelte'
  import type { MessageKey } from '@shared/locales/en-US'
  import DialogPortal from '@app/components/ui/dialog/dialog-portal.svelte'
  import Button from '@app/components/primitives/Button.svelte'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import { getBackend, getExtensions, getI18n, getSession, getUi } from '@app/root/context'
  import { createSettingsResources, setSettingsResources } from './resources'
  import { sectionResources, settingsSections, type SettingsSectionId, type VisibleSettingsSection } from './sections'
  import AppearanceSettings from './AppearanceSettings.svelte'
  import SettingsLoading from './SettingsLoading.svelte'
  import UpdateSettings from './UpdateSettings.svelte'

  const icons: Record<SettingsSectionId, Component<{ size?: number }>> = {
    appearance: Palette,
    editor: Type,
    backup: Cloud,
    sync: RefreshCw,
    mcp: BrainCircuit,
    account: UserRound,
    data: Database,
    shares: Link2,
    about: Info,
  }

  const loaders: Record<Exclude<SettingsSectionId, 'appearance'>, () => Promise<Component>> = {
    editor: () => import('./EditorSettings.svelte').then((module) => module.default),
    backup: () => import('./BackupSettings.svelte').then((module) => module.default),
    sync: () => import('./SyncSettings.svelte').then((module) => module.default),
    mcp: () => import('./McpSettings.svelte').then((module) => module.default),
    account: () => import('./AccountSettings.svelte').then((module) => module.default),
    data: () => import('./DataSettings.svelte').then((module) => module.default),
    shares: () => import('./SharedNotes.svelte').then((module) => module.default),
    about: () => import('./AboutSettings.svelte').then((module) => module.default),
  }

  interface Props {
    open?: boolean
    onClose(): void
  }

  let { open = true, onClose }: Props = $props()
  const backend = getBackend()
  const extensions = getExtensions()
  const session = getSession()
  const i18n = getI18n()
  const ui = getUi()
  const resources = createSettingsResources(backend)
  setSettingsResources(resources)

  let selected = $state(ui.settingsSection ?? 'appearance')
  ui.settingsSection = null
  let loading = $state(false)
  let failed = $state(false)
  let retry = $state(0)
  let Page = $state<Component | undefined>()
  let sequence = 0
  let scope: number | undefined
  const sections = $derived(settingsSections(backend, extensions.settingsSections))
  const active = $derived(sections.find((section) => section.id === selected) ?? sections[0])
  $effect(() => {
    const epoch = session.epoch
    const status = session.status
    const visible = open
    const section = active
    void retry
    const current = ++sequence
    if (scope !== epoch) {
      resources.clear()
      scope = epoch
      if (selected !== 'appearance') {
        selected = 'appearance'
        return
      }
    }
    resources.cancel()
    Page = undefined
    loading = false
    failed = false
    if (!visible || status !== 'authed' || !section) return
    const required = sectionResources(section, backend.capabilities)
    const page =
      'component' in section
        ? Promise.resolve(section.component)
        : section.id === 'appearance'
          ? Promise.resolve(AppearanceSettings)
          : loaders[section.id]()
    loading = true
    void Promise.all([page, ...required.map((id) => resources.load(id, epoch))])
      .then(([loaded]) => {
        if (current === sequence) {
          Page = loaded as Component
          loading = false
        }
      })
      .catch(() => {
        if (current === sequence) {
          loading = false
          failed = true
        }
      })
  })
  onDestroy(() => {
    sequence++
    resources.clear()
  })

  function changeSection(section: VisibleSettingsSection): void {
    if (section.id === selected) return
    selected = section.id
  }

  function dismiss(isOpen: boolean): void {
    if (!isOpen) onClose()
  }

  function openShortcuts(): void {
    onClose()
    ui.openPanel('shortcuts')
  }
</script>

<DialogPrimitive.Root {open} onOpenChange={dismiss}>
  <DialogPortal>
    <div class="app-viewport-fixed fixed z-[210] flex items-center justify-center md:p-8">
      <DialogPrimitive.Overlay class="anim-fade absolute inset-0 bg-[var(--scrim)]" />
      <DialogPrimitive.Content
        class="anim-pop relative flex h-full w-full max-w-[880px] flex-col overflow-hidden bg-[var(--bg-overlay)] pt-[env(safe-area-inset-top)] shadow-[var(--shadow-modal)] outline-none md:max-h-[720px] md:flex-row md:rounded-[var(--r-2xl)] md:border md:border-[var(--border-default)] md:pt-0"
      >
        <nav
          class="flex w-full shrink-0 flex-col border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2 md:w-[172px] md:border-r md:border-b-0"
        >
          <DialogPrimitive.Title class="px-2 py-1.5 text-[13.5px] font-semibold tracking-[-0.012em] md:py-2.5"
            >{i18n.t('common.settings')}</DialogPrimitive.Title
          >
          <div class="flex gap-1 overflow-x-auto pb-1 md:block md:space-y-px md:overflow-visible md:pb-0">
            {#each sections as section (section.id)}
              {@const current = active?.id === section.id}
              {@const Icon = 'icon' in section ? section.icon : icons[section.id as SettingsSectionId]}
              <button
                type="button"
                aria-current={current ? 'page' : undefined}
                onclick={() => changeSection(section)}
                class={[
                  'flex h-10 shrink-0 items-center gap-2 rounded-[var(--r-md)] px-2.5 text-left text-[12.5px] md:h-[30px] md:w-full md:gap-2.5 md:px-2',
                  'transition-colors duration-[var(--dur-fast)]',
                  current
                    ? 'bg-[var(--accent-soft)] font-medium text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                ]}
              >
                {#if Icon}<span
                    aria-hidden="true"
                    class={['shrink-0', current ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]']}
                    ><Icon size={14} /></span
                  >{/if}
                {i18n.t(section.titleKey as MessageKey)}
              </button>
            {/each}
            <button
              type="button"
              onclick={openShortcuts}
              class="flex h-10 shrink-0 items-center gap-2.5 rounded-[var(--r-md)] px-2.5 text-left text-[12.5px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] md:hidden"
            >
              <Keyboard size={14} />{i18n.t('settings.keyboard_shortcuts')}
            </button>
          </div>

          <div class="flex-1"></div>
          <button
            type="button"
            onclick={openShortcuts}
            class="hidden h-[30px] w-full items-center gap-2.5 rounded-[var(--r-md)] px-2 text-left text-[12.5px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] md:flex"
          >
            <Keyboard size={14} />{i18n.t('settings.keyboard_shortcuts')}
          </button>
        </nav>

        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
          <header
            class="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-4 md:px-5"
          >
            <h2 class="text-[14px] font-semibold tracking-[-0.012em]">
              {active ? i18n.t(active.titleKey as MessageKey) : i18n.t('common.settings')}
            </h2>
            <IconButton label={i18n.t('common.close')} title={i18n.t('common.close')} size="sm" onclick={onClose}
              ><X size={15} /></IconButton
            >
          </header>
          <div
            class="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-[calc(16px+env(safe-area-inset-bottom))] md:px-5 md:py-4"
            aria-busy={loading}
          >
            {#if !open || session.status !== 'authed' || loading}
              <SettingsLoading />
            {:else if failed}
              <div role="alert" class="space-y-3 py-4 text-[12.5px] text-[var(--text-secondary)]">
                <p>{i18n.t('app.section_unavailable')}</p>
                <Button
                  size="sm"
                  onclick={() => {
                    resources.clear()
                    retry++
                  }}>{i18n.t('common.retry')}</Button
                >
              </div>
            {:else if active && Page}
              {#key `${session.epoch}:${active.id}`}<Page
                />{#if active.id === 'about' && backend.kind === 'web' && backend.capabilities.updateCheck && session.user?.role === 'owner'}<UpdateSettings
                  />{/if}{/key}
            {/if}
          </div>
        </div>
      </DialogPrimitive.Content>
    </div>
  </DialogPortal>
</DialogPrimitive.Root>
