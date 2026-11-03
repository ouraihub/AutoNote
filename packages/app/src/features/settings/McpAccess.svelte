<script lang="ts">
  import { Bot, Check, Copy } from '@lucide/svelte'
  import type { McpSettingsInfo } from '@shared/types'
  import { getI18n } from '@app/root/context'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
  import Switch from '@app/components/primitives/Switch.svelte'

  let {
    info,
    busy,
    copied,
    copy,
    toggle,
    changePreference,
  }: {
    info: McpSettingsInfo
    busy: boolean
    copied: string | null
    copy: (id: string, value: string) => Promise<void>
    toggle: () => Promise<void>
    changePreference: (patch: {
      writeEnabled?: boolean
      trashEnabled?: boolean
    }) => Promise<void>
  } = $props()
  const i18n = getI18n()
  const sectionHeading =
    'text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]'
  const badge =
    'inline-flex items-center rounded-full px-[7px] py-[1px] ' +
    'text-[11px] font-medium tabular'
</script>

<section
  class="overflow-hidden rounded-[var(--r-lg)] border
    border-[var(--border-subtle)] bg-[var(--bg-base)]"
>
  <div class="flex items-start gap-3 p-4">
    <span
      class="mt-0.5 rounded-[var(--r-md)] bg-[var(--accent-soft)] p-2
        text-[var(--accent)]"><Bot size={18} /></span
    >
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="text-[13.5px] font-semibold text-[var(--text-primary)]">
          {i18n.t('settings.mcp_private_knowledge')}
        </h3>
        <span
          class={[
            badge,
            info.enabled
              ? 'bg-[color-mix(in_oklab,var(--success)_15%,transparent)] ' +
                'text-[var(--success)]'
              : 'bg-[var(--bg-raised)] text-[var(--text-tertiary)]',
          ]}
        >
          {info.enabled
            ? i18n.t('settings.enabled')
            : i18n.t('settings.mcp_disabled')}
        </span>
      </div>
      <p class="mt-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
        {i18n.t('settings.mcp_intro')}
      </p>
    </div>
  </div>
  <div class="border-t border-[var(--border-subtle)] px-4 py-3">
    <div class="mb-1 text-[11px] font-medium text-[var(--text-tertiary)]">
      {i18n.t('settings.mcp_endpoint')}
    </div>
    <div class="flex min-w-0 items-center gap-2">
      <code
        class="min-w-0 flex-1 overflow-x-auto rounded-[var(--r-sm)]
          bg-[var(--bg-inset)] px-2.5 py-2 text-[11.5px]
          text-[var(--text-secondary)]">{info.endpoint}</code
      >
      <IconButton
        label={i18n.t('settings.mcp_copy')}
        title={i18n.t('settings.mcp_copy')}
        size="sm"
        onclick={() => void copy('endpoint', info!.endpoint)}
      >
        {#if copied === 'endpoint'}<Check size={14} />{:else}<Copy
            size={14}
          />{/if}
      </IconButton>
    </div>
    <p class="mt-2 text-[10.5px] leading-relaxed text-[var(--text-quaternary)]">
      {i18n.t('settings.mcp_endpoint_desc')}
    </p>
  </div>
</section>

<section>
  <h3 class={['mb-1 px-1', sectionHeading]}>
    {i18n.t('settings.mcp_permissions')}
  </h3>
  {#if info.canManageGlobal}
    <SettingRow
      title={i18n.t('settings.mcp_enable')}
      description={i18n.t('settings.mcp_enable_desc')}
    >
      <Switch
        checked={info.enabled}
        disabled={busy}
        label={i18n.t('settings.mcp_enable')}
        onChange={() => void toggle()}
      />
    </SettingRow>
  {/if}
  <SettingRow
    title={i18n.t('settings.mcp_write_access')}
    description={i18n.t('settings.mcp_write_access_desc')}
  >
    <Switch
      checked={info.preferences.writeEnabled}
      disabled={busy || !info.enabled}
      label={i18n.t('settings.mcp_write_access')}
      onChange={(writeEnabled) => void changePreference({ writeEnabled })}
    />
  </SettingRow>
  <SettingRow
    title={i18n.t('settings.mcp_trash_access')}
    description={i18n.t('settings.mcp_trash_access_desc')}
  >
    <Switch
      checked={info.preferences.trashEnabled}
      disabled={busy || !info.enabled}
      label={i18n.t('settings.mcp_trash_access')}
      onChange={(trashEnabled) => void changePreference({ trashEnabled })}
    />
  </SettingRow>
</section>
