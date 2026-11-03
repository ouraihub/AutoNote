<script lang="ts">
  import { Check, Copy, KeyRound, Trash2 } from '@lucide/svelte'
  import type { RelayKey } from '@app/backend'
  import { getI18n } from '@app/root/context'
  import Button from '@app/components/primitives/Button.svelte'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import TextInput from '@app/components/primitives/TextInput.svelte'
  let {
    keys,
    busy,
    copied,
    token = $bindable(),
    keyName = $bindable(),
    copy,
    create,
    revoke,
  }: {
    keys: RelayKey[]
    busy: boolean
    copied: string | null
    token: string | null
    keyName: string
    copy: (id: string, value: string) => Promise<void>
    create: () => void
    revoke: (key: RelayKey) => Promise<void>
  } = $props()
  const i18n = getI18n()
  const sectionHeading =
    'text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]'
  const fullTime = (value: number) =>
    new Date(value).toLocaleString(i18n.locale)
</script>

<section>
  <h3 class={['mb-2 px-1', sectionHeading]}>
    {i18n.t('settings.relay_keys')}
  </h3>
  <p
    class="mb-3 px-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]"
  >
    {i18n.t('settings.relay_keys_desc')}
  </p>

  {#if token}
    {@const created = token}
    <div
      class="mb-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)]
        bg-[var(--bg-inset)] p-3"
    >
      <div
        class="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium
          text-[var(--text-primary)]"
      >
        <KeyRound size={12} class="text-[var(--accent)]" />
        {i18n.t('settings.mcp_api_key_copy_warning')}
      </div>
      <div class="flex items-center gap-2">
        <code
          class="min-w-0 flex-1 break-all rounded-[var(--r-sm)]
            bg-[var(--bg-base)] px-2.5 py-2 font-mono text-[11px]
            text-[var(--text-secondary)] select-all">{created}</code
        >
        <Button
          size="sm"
          variant="secondary"
          onclick={() => void copy('new-token', created)}
        >
          {#if copied === 'new-token'}<Check size={12} />{:else}<Copy
              size={12}
            />{/if}{copied === 'new-token'
            ? i18n.t('common.copied')
            : i18n.t('common.copy')}
        </Button>
        <Button size="sm" variant="ghost" onclick={() => (token = null)}
          >{i18n.t('common.close')}</Button
        >
      </div>
      <p class="mt-1.5 text-[10.5px] text-[var(--text-quaternary)]">
        {i18n.t('settings.mcp_api_key_show_once')}
      </p>
    </div>
  {/if}

  <form
    class="mb-2 flex items-center gap-2"
    onsubmit={(event) => {
      event.preventDefault()
      create()
    }}
  >
    <TextInput
      bind:value={keyName}
      disabled={busy || !!token}
      aria-label={i18n.t('settings.relay_key_name')}
      maxlength={80}
      autocomplete="off"
      placeholder={i18n.t('settings.relay_key_name_placeholder')}
      required
    />
    <Button type="submit" variant="secondary" disabled={busy || !!token}>
      <KeyRound size={13} />{i18n.t('settings.mcp_api_key_create')}
    </Button>
  </form>

  {#if keys.length}
    <div
      class="overflow-hidden rounded-[var(--r-lg)] border
        border-[var(--border-subtle)] bg-[var(--bg-base)]"
    >
      {#each keys as key (key.id)}
        <div
          class="flex items-center gap-3 border-b
            border-[var(--border-subtle)] p-3.5 last:border-b-0"
        >
          <span
            class="rounded-[var(--r-sm)] bg-[var(--bg-raised)] p-2
              text-[var(--text-tertiary)]"><KeyRound size={15} /></span
          >
          <div class="min-w-0 flex-1">
            <div
              class="truncate text-[12.5px] font-medium
                text-[var(--text-primary)]"
            >
              {key.name}
            </div>
            <div
              class="mt-0.5 truncate text-[10.5px]
                text-[var(--text-quaternary)]"
            >
              {[
                key.lastUsedAt
                  ? i18n.t('settings.relay_key_last_used', {
                      time: fullTime(key.lastUsedAt),
                    })
                  : i18n.t('settings.mcp_api_key_unused'),
                i18n.t('settings.relay_key_today', {
                  count: key.todayRequests,
                }),
                key.expiresAt
                  ? i18n.t('settings.relay_key_expires', {
                      time: fullTime(key.expiresAt),
                    })
                  : i18n.t('settings.relay_key_never_expires'),
              ].join(' · ')}
            </div>
          </div>
          <IconButton
            label={i18n.t('settings.mcp_api_key_revoke')}
            title={i18n.t('settings.mcp_api_key_revoke')}
            size="sm"
            disabled={busy}
            onclick={() => void revoke(key)}
          >
            <Trash2 size={14} />
          </IconButton>
        </div>
      {/each}
    </div>
  {:else}
    <div
      class="rounded-[var(--r-lg)] border border-dashed
        border-[var(--border-default)] p-5 text-center text-[11.5px]
        text-[var(--text-quaternary)]"
    >
      {i18n.t('settings.relay_keys_empty')}
    </div>
  {/if}
</section>
