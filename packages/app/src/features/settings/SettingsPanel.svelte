<script lang="ts">
  import { onDestroy, type Component } from 'svelte'
  import type { MessageKey } from '@shared/locales/en-US'
  import * as Dialog from '@app/components/ui/dialog'
  import { getBackend, getExtensions, getI18n, getSession } from '@app/root/context'
  import { createSettingsResources, setSettingsResources } from './resources'
  import { sectionResources, settingsSections, type SettingsSectionId, type VisibleSettingsSection } from './sections'
  import AppearanceSettings from './AppearanceSettings.svelte'
  import UpdateSettings from './UpdateSettings.svelte'

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
  const resources = createSettingsResources(backend)
  setSettingsResources(resources)

  let selected = $state('appearance')
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
</script>

<Dialog.Root {open} onOpenChange={dismiss}>
  <Dialog.Content
    showCloseButton={false}
    class="flex h-[min(720px,calc(100dvh-2rem))] max-w-[880px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[880px] md:flex-row"
  >
    <Dialog.Title class="sr-only">{i18n.t('common.settings')}</Dialog.Title>
    <nav
      aria-label={i18n.t('common.settings')}
      class="flex shrink-0 gap-1 overflow-x-auto border-b p-2 md:w-44 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r"
    >
      {#each sections as section (section.id)}
        <button
          type="button"
          aria-current={active?.id === section.id ? 'page' : undefined}
          class="shrink-0 rounded-md px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring md:w-full"
          onclick={() => changeSection(section)}>{i18n.t(section.titleKey as MessageKey)}</button
        >
      {/each}
    </nav>
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <header class="flex items-center justify-between border-b p-3">
        <h2 class="font-semibold">{active ? i18n.t(active.titleKey as MessageKey) : i18n.t('common.settings')}</h2>
        <button
          type="button"
          aria-label={i18n.t('common.close')}
          class="rounded-md px-2 py-1 focus-visible:outline-2 focus-visible:outline-ring"
          onclick={onClose}>×</button
        >
      </header>
      <main class="min-h-0 flex-1 overflow-y-auto p-4" aria-busy={loading}>
        {#if !open || session.status !== 'authed'}
          <p role="status">{i18n.t('common.loading')}</p>
        {:else if failed}
          <div role="alert">
            <p>{i18n.t('app.section_unavailable')}</p>
            <button
              type="button"
              onclick={() => {
                resources.clear()
                retry++
              }}>{i18n.t('common.retry')}</button
            >
          </div>
        {:else if loading}
          <p role="status">{i18n.t('common.loading')}</p>
        {:else if active && Page}
          {#key `${session.epoch}:${active.id}`}<Page
            />{#if active.id === 'about' && backend.kind === 'web' && backend.capabilities.updateCheck && session.user?.role === 'owner'}<UpdateSettings
              />{/if}{/key}
        {/if}
      </main>
    </div>
  </Dialog.Content>
</Dialog.Root>
