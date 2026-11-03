<script lang="ts">
  import type { HostAccountAction } from '@app/root/types'
  import { onMount } from 'svelte'
  import {
    Camera,
    LogIn,
    LogOut,
    Moon,
    Settings,
    Sun,
    Waypoints,
  } from '@lucide/svelte'
  import type { MessageKey } from '@shared/locales/en-US'
  import {
    getExtensions,
    getI18n,
    getSession,
    getSettings,
    getUi,
  } from '@app/root/context'
  import Avatar from '@app/components/primitives/Avatar.svelte'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import AvatarPicker from '@app/features/settings/AvatarPicker.svelte'
  import * as DropdownMenu from '@app/components/ui/dropdown-menu'
  let { rail, isDark }: { rail: boolean; isDark: boolean } = $props()
  const extensions = getExtensions(),
    i18n = getI18n(),
    session = getSession(),
    settings = getSettings(),
    ui = getUi()
  const user = $derived(session.user),
    displayName = $derived(user ? user.name || user.username : '')
  let avatarOpen = $state(false),
    accountAction = $state<HostAccountAction | null>(null)
  onMount(() =>
    extensions.subscribeAccountAction?.((action) => (accountAction = action)),
  )
  function runAccountAction(action: HostAccountAction) {
    if (typeof action.run === 'function') void action.run()
    else ui.openSettings(action.run.settingsSection)
  }
</script>

{#if true}
  {#if user}
    <DropdownMenu.Root>
      {#if rail}
        <DropdownMenu.Trigger
          aria-label={i18n.t('sidebar.account_and_settings')}
          title={`${i18n.t('sidebar.account_and_settings')} · ${displayName}`}
          class={'rounded-full transition-transform ' +
            'duration-[var(--dur-fast)] hover:scale-105 active:scale-95'}
          ><Avatar
            src={user.avatarUrl}
            name={displayName}
            size={28}
          /></DropdownMenu.Trigger
        >
      {:else}
        <div
          class={'group flex h-11 w-full items-center ' +
            'rounded-[var(--r-md)] transition-colors ' +
            'hover:bg-[var(--bg-hover)]'}
        >
          <DropdownMenu.Trigger
            aria-label={i18n.t('sidebar.account_and_settings')}
            class={'flex h-full min-w-0 flex-1 items-center gap-2.5 ' +
              'rounded-l-[var(--r-md)] pl-2 text-left'}
          >
            <Avatar src={user.avatarUrl} name={displayName} size={28} />
            <span class="min-w-0 flex-1">
              <span
                class={'block truncate text-[12.5px] font-semibold ' +
                  'text-[var(--text-primary)]'}>{displayName}</span
              >
              <span
                class={'block truncate text-[10.5px] ' +
                  'text-[var(--text-quaternary)]'}>@{user.username}</span
              >
            </span>
          </DropdownMenu.Trigger>
          <IconButton
            label={i18n.t('common.settings')}
            title={i18n.t('common.settings')}
            size="sm"
            onclick={() => ui.openPanel('settings')}
            class={'mr-1 shrink-0 text-[var(--text-quaternary)] ' +
              'group-hover:text-[var(--text-tertiary)]'}
            ><Settings size={14} /></IconButton
          >
        </div>
      {/if}
      <DropdownMenu.Content class="w-[252px]">
        <DropdownMenu.Group>
          <DropdownMenu.Item onclick={() => (avatarOpen = true)}
            ><Camera size={13} />{i18n.t(
              'settings.change_avatar',
            )}</DropdownMenu.Item
          >
          <DropdownMenu.Item onclick={() => ui.openPanel('settings')}
            ><Settings size={13} />{i18n.t(
              'common.settings',
            )}</DropdownMenu.Item
          >
          <DropdownMenu.Item
            onclick={() => {
              ui.toggleNavDrawer(false)
              ui.openPanel('graph')
            }}
            ><Waypoints size={13} />{i18n.t('common.graph')}</DropdownMenu.Item
          >
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.Group>
          <DropdownMenu.Item
            onclick={() =>
              settings.update({
                appearance: { theme: isDark ? 'light' : 'dark' },
              })}
            >{#if isDark}<Sun size={13} />{:else}<Moon size={13} />{/if}{i18n.t(
              isDark ? 'sidebar.switch_to_light' : 'sidebar.switch_to_dark',
            )}</DropdownMenu.Item
          >
        </DropdownMenu.Group>
        {#if accountAction || session.canSignIn}
          <DropdownMenu.Separator />
          <DropdownMenu.Group>
            {#if accountAction}
              {@const action = accountAction}
              <DropdownMenu.Item
                variant={action.destructive ? 'destructive' : 'default'}
                onclick={() => runAccountAction(action)}
                >{#if action.destructive}<LogOut size={13} />{:else}<LogIn
                    size={13}
                  />{/if}{i18n.t(
                  action.labelKey as MessageKey,
                )}</DropdownMenu.Item
              >
            {:else}
              <DropdownMenu.Item
                variant="destructive"
                onclick={() => void session.logout()}
                ><LogOut size={13} />{i18n.t(
                  'sidebar.log_out',
                )}</DropdownMenu.Item
              >
            {/if}
          </DropdownMenu.Group>
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
    {#if avatarOpen}<AvatarPicker onClose={() => (avatarOpen = false)} />{/if}
  {/if}
{/if}
