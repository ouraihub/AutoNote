<script lang="ts">
  import type { I18nState } from '@app/i18n/runtime.svelte'
  import type { BackupTarget, TestConnectionResult } from '@shared/types'
  import type { MessageKey } from '@shared/locales/en-US'
  import { AlertCircle, CheckCircle2 } from '@lucide/svelte'
  import Button from '@app/components/primitives/Button.svelte'
  import FormField from '@app/components/primitives/FormField.svelte'
  import Modal from '@app/components/primitives/Modal.svelte'
  import Segmented from '@app/components/primitives/Segmented.svelte'
  import TextInput from '@app/components/primitives/TextInput.svelte'
  import { cn } from '@app/utils'

  let {
    open,
    editing,
    type = $bindable('webdav'),
    name = $bindable(''),
    endpoint = $bindable(''),
    region = $bindable('auto'),
    bucket = $bindable(''),
    prefix = $bindable('autonote'),
    username = $bindable(''),
    accessKeyId = $bindable(''),
    secretAccessKey = $bindable(''),
    password = $bindable(''),
    result,
    error,
    busy,
    i18n,
    onClose,
    onSave,
    onTest,
  }: {
    open: boolean
    editing: BackupTarget | null
    type?: 'webdav' | 's3'
    name?: string
    endpoint?: string
    region?: string
    bucket?: string
    prefix?: string
    username?: string
    accessKeyId?: string
    secretAccessKey?: string
    password?: string
    result: TestConnectionResult | null
    error: string
    busy: boolean
    i18n: I18nState
    onClose: () => void
    onSave: () => void
    onTest: () => void
  } = $props()
</script>

{#if open}
  {@const canKeepSecret = Boolean(editing?.hasSecret && type === editing.type)}
  <Modal
    open
    {onClose}
    title={editing
      ? i18n.t('settings.edit_backup_target')
      : i18n.t('settings.add_backup_target')}
    description={canKeepSecret
      ? i18n.t('settings.leave_the_key_blank_to_leave_it_unchanged')
      : undefined}
    width={520}
  >
    <form
      id="backup-target-form"
      onsubmit={(event) => {
        event.preventDefault()
        void onSave()
      }}
    >
      <fieldset
        disabled={busy}
        aria-busy={busy}
        class="min-w-0 space-y-3.5 border-0 p-0"
      >
        {#if editing && type !== editing.type}
          <div
            class="flex items-start gap-2 rounded-[var(--r-md)] border
border-[color-mix(in_oklab,var(--warning)_28%,var(--border-subtle))]
              bg-[var(--bg-inset)] px-3 py-2 text-[11.5px]
              text-[var(--warning)]"
          >
            <AlertCircle size={13} class="mt-0.5 shrink-0" />
            <span
              >{i18n.t(
                ('settings.enter_the_complete_credentials_for_the_' +
                  'new_backup_type_after_switching_t') as MessageKey,
              )}</span
            >
          </div>
        {/if}
        <div class="flex flex-col gap-1.5">
          <span
            class="block text-[12px] font-medium text-[var(--text-secondary)]"
            >{i18n.t('settings.type')}</span
          >
          <Segmented
            label={i18n.t('settings.type')}
            value={type}
            onChange={(next: 'webdav' | 's3') => (type = next)}
            options={[
              { value: 's3', label: i18n.t('settings.s3_compatible') },
              { value: 'webdav', label: i18n.t('settings.webdav_backup') },
            ]}
          />
        </div>
        <FormField label={i18n.t('settings.name')} for="backup-target-name">
          <TextInput
            id="backup-target-name"
            bind:value={name}
            required
            placeholder={i18n.t('settings.for_example_primary_r2_backup')}
          />
        </FormField>
        {#if type === 's3'}
          <FormField
            label={i18n.t('settings.endpoint')}
            for="backup-target-endpoint"
            hint={i18n.t(
              ('settings.leave_blank_unless_the_provider_requires_' +
                'it_for_r2_use_url') as MessageKey,
            )}
          >
            <TextInput
              id="backup-target-endpoint"
              type="url"
              bind:value={endpoint}
            />
          </FormField>
          <div class="grid grid-cols-2 gap-3">
            <FormField
              label={i18n.t('settings.bucket')}
              for="backup-target-bucket"
            >
              <TextInput
                id="backup-target-bucket"
                bind:value={bucket}
                required
              />
            </FormField>
            <FormField
              label={i18n.t('settings.region')}
              for="backup-target-region"
            >
              <TextInput
                id="backup-target-region"
                bind:value={region}
                required
              />
            </FormField>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <FormField
              label={i18n.t('settings.access_key_id')}
              for="backup-target-access-key"
            >
              <TextInput
                id="backup-target-access-key"
                bind:value={accessKeyId}
                autocomplete="off"
                placeholder={canKeepSecret
                  ? i18n.t('settings.unchanged')
                  : undefined}
              />
            </FormField>
            <FormField
              label={i18n.t('settings.secret_access_key')}
              for="backup-target-secret-key"
            >
              <TextInput
                id="backup-target-secret-key"
                type="password"
                bind:value={secretAccessKey}
                autocomplete="off"
                placeholder={canKeepSecret
                  ? i18n.t('settings.unchanged')
                  : undefined}
              />
            </FormField>
          </div>
        {:else}
          <FormField
            label={i18n.t('settings.webdav_address')}
            for="backup-target-url"
            hint={i18n.t(
              ('settings.https_only_redirects_within_the_same_site_' +
                'are_handled_automatically') as MessageKey,
            )}
          >
            <TextInput
              id="backup-target-url"
              type="url"
              bind:value={endpoint}
              required
            />
          </FormField>
          <div class="grid grid-cols-2 gap-3">
            <FormField
              label={i18n.t('common.username')}
              for="backup-target-username"
            >
              <TextInput
                id="backup-target-username"
                bind:value={username}
                autocomplete="off"
              />
            </FormField>
            <FormField
              label={i18n.t('common.password')}
              for="backup-target-password"
              hint={i18n.t(
                'settings.use_an_app_specific_password_when_possible',
              )}
            >
              <TextInput
                id="backup-target-password"
                type="password"
                bind:value={password}
                autocomplete="off"
                placeholder={canKeepSecret
                  ? i18n.t('settings.unchanged')
                  : undefined}
              />
            </FormField>
          </div>
        {/if}
        <FormField
          label={i18n.t('settings.subdirectory')}
          for="backup-target-prefix"
          hint={i18n.t(
            ('settings.store_backups_in_this_directory_or_leave_blank_' +
              'to_use_the_root_directory') as MessageKey,
          )}
        >
          <TextInput id="backup-target-prefix" bind:value={prefix} />
        </FormField>
        {#if result}
          <div
            role={result.ok ? 'status' : 'alert'}
            class={cn(
              'flex items-start gap-2 rounded-[var(--r-md)] px-3 py-2.5 ' +
                'text-[12px] leading-relaxed',
              result.ok
                ? 'bg-[color-mix(in_oklab,var(--success)_12%,transparent)] ' +
                    'text-[var(--success)]'
                : 'bg-[color-mix(in_oklab,var(--danger)_11%,transparent)] ' +
                    'text-[var(--danger)]',
            )}
          >
            {#if result.ok}<CheckCircle2
                size={13}
                class="mt-px shrink-0"
              />{:else}<AlertCircle size={13} class="mt-px shrink-0" />{/if}
            <span
              >{result.message}{result.latencyMs
                ? ` · ${result.latencyMs}ms`
                : ''}</span
            >
          </div>
        {/if}
        {#if error}<p role="alert" class="text-[12px] text-[var(--danger)]">
            {error}
          </p>{/if}
      </fieldset>
    </form>
    {#snippet footer()}
      <Button variant="ghost" onclick={onClose} disabled={busy}
        >{i18n.t('common.cancel')}</Button
      >
      <Button variant="secondary" disabled={busy} onclick={() => void onTest()}
        >{i18n.t('settings.test_connection')}</Button
      >
      <Button
        type="submit"
        form="backup-target-form"
        variant="primary"
        disabled={busy}>{i18n.t('common.save')}</Button
      >
    {/snippet}
  </Modal>
{/if}
