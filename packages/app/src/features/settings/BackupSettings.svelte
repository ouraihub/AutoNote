<script lang="ts">
  import { onMount } from 'svelte'
  import { AlertCircle, CheckCircle2, CloudUpload, HardDrive, MoreHorizontal, Plus, Server, Trash2, Zap } from '@lucide/svelte'
  import type { BackupRun, BackupSchedule, BackupTarget, BackupTargetInput, TestConnectionResult } from '@shared/types'
  import { getBackend, getI18n, getNotifier, getSession, getSettings } from '@app/root/context'
  import Button from '@app/components/primitives/Button.svelte'
  import Empty from '@app/components/primitives/Empty.svelte'
  import FormField from '@app/components/primitives/FormField.svelte'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import Modal from '@app/components/primitives/Modal.svelte'
  import Segmented from '@app/components/primitives/Segmented.svelte'
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
  import TextInput from '@app/components/primitives/TextInput.svelte'
  import { cn } from '@app/utils'
  import { cloudError } from './accountCloud'

  const backend = getBackend()
  const session = getSession()
  const i18n = getI18n()
  const notifier = getNotifier()
  const settings = getSettings()
  const backup = backend.kind === 'web' && backend.capabilities.remoteBackup ? backend.backup : undefined
  let targets = $state<BackupTarget[] | null>(null)
  let runs = $state<BackupRun[]>([])
  let editing = $state<BackupTarget | null>(null)
  let type = $state<'webdav' | 's3'>('webdav')
  let name = $state('')
  let endpoint = $state('')
  let openForm = $state(false)
  let region = $state('auto')
  let bucket = $state('')
  let prefix = $state('autonote')
  let username = $state('')
  let accessKeyId = $state('')
  let secretAccessKey = $state('')
  let password = $state('')
  let result = $state<TestConnectionResult | null>(null)
  let error = $state('')
  let busy = $state(false)
  let running = $state(false)
  let active = true
  let openRun = $state<string | null>(null)
  const enabledCount = $derived(targets?.filter((item) => item.enabled).length ?? 0)
  const sectionHeading = 'text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]'
  const formatBytes = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`

  async function reload(): Promise<void> {
    if (!backup || busy) return
    busy = true
    error = ''
    try {
      const [nextTargets, nextRuns] = await Promise.all([backup.targets({ signal: session.epochSignal }), backup.runs({ signal: session.epochSignal })])
      if (active) { targets = nextTargets; runs = nextRuns }
    } catch (cause) {
      if (active && !session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally { busy = false }
  }

  function edit(target: BackupTarget | null): void {
    editing = target
    type = target?.type ?? 'webdav'
    name = target?.name ?? ''
    const config = target?.config
    endpoint = config && 'endpoint' in config ? config.endpoint : config && 'url' in config ? config.url : ''
    region = config && 'region' in config ? config.region : 'auto'
    bucket = config && 'bucket' in config ? config.bucket : ''
    prefix = config?.prefix ?? 'autonote'
    username = config && 'username' in config ? config.username : ''
    password = accessKeyId = secretAccessKey = error = ''
    result = null
  }

  function payload(): BackupTargetInput {
    return {
      type, name: name.trim(),
      config: type === 'webdav'
        ? { url: endpoint.trim(), username: username.trim(), prefix: prefix.trim(), mode: 'archive' }
        : { endpoint: endpoint.trim(), region: region.trim(), bucket: bucket.trim(), prefix: prefix.trim(), pathStyle: true, mode: 'archive' },
      ...(!editing || type !== editing.type || password.trim() || accessKeyId.trim() || secretAccessKey.trim()
        ? { secret: type === 'webdav' ? { password } : { accessKeyId, secretAccessKey } } : {}),
    }
  }

  async function save(): Promise<void> {
    if (!backup || busy) return
    error = ''
    result = null
    if (editing && type !== editing.type && !(type === 'webdav' ? password.trim() : accessKeyId.trim() && secretAccessKey.trim())) {
      error = i18n.t('settings.enter_the_complete_credentials_for_the_new_backup_type_after_switching_t')
      return
    }
    busy = true
    try {
      const input = payload()
      const saved = editing
        ? await backup.patch(editing.id, { ...input, expectedUpdatedAt: editing.updatedAt }, { signal: session.epochSignal })
        : await backup.create(input, { signal: session.epochSignal })
      if (active) {
        targets = editing ? targets?.map((item) => item.id === saved.id ? saved : item) ?? [saved] : [...(targets ?? []), saved]
        editing = null
        openForm = false
        password = accessKeyId = secretAccessKey = ''
      }
    } catch (cause) {
      if (active && !session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally { busy = false }
  }

  async function test(): Promise<void> {
    if (!backup || busy) return
    busy = true
    error = ''
    result = null
    try {
      const checked = editing
        ? await backup.test(editing.id, payload(), { signal: session.epochSignal })
        : await backup.testDraft(payload(), { signal: session.epochSignal })
      if (active) result = checked
    } catch (cause) {
      if (active && !session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally { busy = false }
  }

  async function remove(target: BackupTarget): Promise<void> {
    if (!backup || busy || !await notifier.confirm({ titleKey: 'settings.backup_target', bodyKey: 'settings.files_that_have_been_backed_up_there_will_not_be_deleted', danger: true })) return
    busy = true
    error = ''
    try {
      await backup.remove(target.id, { signal: session.epochSignal })
      if (active) targets = targets?.filter((item) => item.id !== target.id) ?? null
    } catch (cause) {
      if (active && !session.epochSignal.aborted) notifier.toast({ key: cloudError(cause), tone: 'error' })
    } finally { busy = false }
  }

  async function run(): Promise<void> {
    if (!backup || busy) return
    busy = running = true
    error = ''
    try {
      const next = await backup.run(undefined, { signal: session.epochSignal })
      if (active) {
        runs = [next, ...runs]
        notifier.toast({ key: next.status === 'success' ? 'settings.backup_completed_value0_targets' : 'settings.backup_failed', params: { value0: next.results.filter((item) => item.ok).length }, tone: next.status === 'success' ? 'success' : 'error' })
      }
    } catch (cause) {
      if (active && !session.epochSignal.aborted) notifier.toast({ key: cloudError(cause), tone: 'error' })
    } finally { busy = running = false }
  }

  function closeForm(): void {
    if (busy) return
    openForm = false
    password = accessKeyId = secretAccessKey = ''
  }

  onMount(() => { if (backup) void reload(); return () => { active = false } })
</script>

{#if backup && session.status === 'authed'}
  {#if targets === null && error && !openForm}
    <div class="rounded-[var(--r-lg)] border border-[color-mix(in_oklab,var(--danger)_28%,var(--border-subtle))] bg-[var(--bg-base)] p-4">
      <div class="flex items-start gap-3">
        <AlertCircle size={16} class="mt-0.5 shrink-0 text-[var(--danger)]" />
        <div class="min-w-0 flex-1">
          <div class="text-[13px] font-medium text-[var(--text-primary)]">{i18n.t('settings.could_not_load_backup_settings')}</div>
          <p role="alert" class="mt-1 break-words text-[11.5px] text-[var(--text-tertiary)]">{error}</p>
        </div>
        <Button size="sm" variant="secondary" disabled={busy} onclick={() => void reload()}>{i18n.t('common.retry')}</Button>
      </div>
    </div>
  {:else if targets === null}
    <p role="status" class="py-4 text-center text-[12px] text-[var(--text-tertiary)]">{i18n.t('settings.loading_backup_configuration')}</p>
  {:else}
    <div class="space-y-6">
      {#if error && !openForm}
        <div class="flex items-start gap-2 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--danger)_25%,var(--border-subtle))] bg-[var(--bg-base)] px-3 py-2 text-[11.5px] text-[var(--danger)]">
          <AlertCircle size={13} class="mt-0.5 shrink-0" />
          <span role="alert" class="min-w-0 flex-1 break-words">{error}</span>
          <button type="button" class="shrink-0 font-medium underline underline-offset-2" disabled={busy} onclick={() => void reload()}>{i18n.t('common.retry')}</button>
        </div>
      {/if}

      <section class="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
        <div class="flex items-start gap-3">
          <span class="mt-0.5 text-[var(--accent)]"><CloudUpload size={18} /></span>
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-medium text-[var(--text-primary)]">
              {enabledCount > 0 ? i18n.t('settings.value0_backup_targets_active', { value0: enabledCount }) : i18n.t('settings.no_backup_configured_yet')}
            </div>
            <p class="mt-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">{i18n.t('settings.each_backup_goes_independently_to_every_enabled_target_it_includes_notes')}</p>
          </div>
          <Button size="sm" variant="primary" loading={running} disabled={busy || !enabledCount} onclick={() => void run()}>
            {#if !running}<Zap size={13} />{/if}{i18n.t('settings.back_up_now')}
          </Button>
        </div>
      </section>

      <section>
        <div class="mb-2 flex items-center justify-between">
          <h3 class={sectionHeading}>{i18n.t('settings.backup_target')}</h3>
          <Button size="sm" variant="secondary" disabled={busy} onclick={() => { edit(null); openForm = true }}><Plus size={13} />{i18n.t('settings.add_target')}</Button>
        </div>
        {#if targets.length === 0}
          <div class="rounded-[var(--r-lg)] border border-dashed border-[var(--border-default)]">
            <Empty art="archive" compact title={i18n.t('settings.no_backup_target_yet')} description={i18n.t('settings.add_a_webdav_or_s3_compatible_target_or_choose_a_common_provider_preset')}>
              {#snippet action()}
                <Button size="sm" disabled={busy} onclick={() => { edit(null); openForm = true }}><Plus size={13} />{i18n.t('settings.add_first_target')}</Button>
              {/snippet}
            </Empty>
          </div>
        {:else}
          <div class="space-y-2">
            {#each targets as target (target.id)}
              {@const config = target.config}
              <div class={cn('rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 transition-colors', !target.enabled && 'opacity-60')}>
                <div class="flex items-start gap-3">
                  <span class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[var(--r-md)] bg-[var(--bg-raised)] text-[var(--text-tertiary)]">
                    {#if target.type === 's3'}<HardDrive size={15} />{:else}<Server size={15} />{/if}
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="truncate text-[13px] font-medium text-[var(--text-primary)]">{target.name}</span>
                      <span class="inline-flex items-center rounded-full bg-[var(--bg-raised)] px-[7px] py-[1px] text-[11px] font-medium tabular text-[var(--text-tertiary)]">
                        {target.type === 's3' ? i18n.t('settings.s3_backup') : i18n.t('settings.webdav_backup')}
                      </span>
                    </div>
                    <div class="mt-0.5 truncate text-[11.5px] text-[var(--text-quaternary)]">
                      {'bucket' in config ? `${config.bucket}${config.prefix ? `/${config.prefix}` : ''}` : config.url}
                    </div>
                    {#if target.lastRunAt}
                      <div class={cn('mt-1.5 flex items-center gap-1.5 text-[11px]', target.lastStatus === 'success' ? 'text-[var(--success)]' : 'text-[var(--danger)]')}>
                        {#if target.lastStatus === 'success'}<CheckCircle2 size={11} />{:else}<AlertCircle size={11} />{/if}
                        {target.lastStatus === 'success' ? i18n.t('settings.last_backup_succeeded') : i18n.t('settings.last_backup_failed')}
                        <span class="text-[var(--text-quaternary)]">· {new Date(target.lastRunAt).toLocaleString(i18n.locale)}</span>
                      </div>
                    {/if}
                  </div>
                  <div class="flex shrink-0 items-center gap-1">
                    <span class={['inline-flex items-center rounded-full px-[7px] py-[1px] text-[11px] font-medium tabular', target.enabled ? 'bg-[color-mix(in_oklab,var(--success)_15%,transparent)] text-[var(--success)]' : 'bg-[var(--bg-raised)] text-[var(--text-tertiary)]']}>
                      {target.enabled ? i18n.t('common.on') : i18n.t('common.off')}
                    </span>
                    <IconButton label={i18n.t('common.edit')} title={i18n.t('common.edit')} size="sm" disabled={busy} onclick={() => { edit(target); openForm = true }}>
                      <MoreHorizontal size={14} />
                    </IconButton>
                    <IconButton label={i18n.t('common.delete')} title={i18n.t('common.delete')} size="sm" disabled={busy} class="text-[var(--text-quaternary)] hover:text-[var(--danger)]" onclick={() => void remove(target)}>
                      <Trash2 size={13} />
                    </IconButton>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <section>
        <h3 class={['mb-1', sectionHeading]}>{i18n.t('settings.automatic_backups')}</h3>
        <SettingRow title={i18n.t('settings.frequency')} description={i18n.t('settings.runs_from_cloudflare_cron_the_page_does_not_need_to_stay_open')}>
          <Segmented
            label={i18n.t('settings.frequency')}
            value={settings.current.backup.schedule}
            onChange={(schedule: BackupSchedule) => settings.update({ backup: { schedule } })}
            options={[
              { value: 'off', label: i18n.t('common.off') },
              { value: 'hourly', label: i18n.t('settings.hourly') },
              { value: 'sixHourly', label: i18n.t('settings.every_6_hours') },
              { value: 'daily', label: i18n.t('settings.daily') },
            ]}
          />
        </SettingRow>
      </section>

      <section>
        <h3 class={['mb-2', sectionHeading]}>{i18n.t('settings.latest_backups')}</h3>
        {#if runs.length === 0}
          <p class="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-4 text-center text-[12px] text-[var(--text-quaternary)]">{i18n.t('settings.no_backup_record_yet')}</p>
        {:else}
          <ul class="space-y-1">
            {#each runs.slice(0, 12) as item (item.id)}
              {@const expanded = openRun === item.id}
              <li class="overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
                <button type="button" aria-expanded={expanded} onclick={() => (openRun = expanded ? null : item.id)} class="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]">
                  <span class={cn('size-1.5 shrink-0 rounded-full', item.status === 'success' ? 'bg-[var(--success)]' : item.status === 'partial' ? 'bg-[var(--warning)]' : 'bg-[var(--danger)]')}></span>
                  <span class="min-w-0 flex-1 truncate text-[12px] text-[var(--text-secondary)]">
                    {new Date(item.startedAt).toLocaleString(i18n.locale)} · {item.trigger === 'cron' ? i18n.t('settings.scheduled') : i18n.t('settings.manual')}
                  </span>
                  <span class="shrink-0 text-[11px] tabular text-[var(--text-quaternary)]">{item.noteCount}{i18n.t('settings.notes')}{formatBytes(item.bytes)}</span>
                </button>
                {#if expanded && item.results.length > 0}
                  <ul class="border-t border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2">
                    {#each item.results as entry, index (`${entry.targetId}-${index}`)}
                      <li class="flex items-start gap-2 py-1 text-[11.5px]">
                        {#if entry.ok}<CheckCircle2 size={11} class="mt-0.5 shrink-0 text-[var(--success)]" />{:else}<AlertCircle size={11} class="mt-0.5 shrink-0 text-[var(--danger)]" />{/if}
                        <span class="shrink-0 text-[var(--text-secondary)]">{entry.targetName}</span>
                        <span class="min-w-0 flex-1 text-[var(--text-quaternary)]">
                          {entry.ok ? i18n.t('settings.value0_files_value1_value2', { value0: entry.files, value1: formatBytes(entry.bytes), value2: `${(entry.ms / 1000).toFixed(1)}s` }) : i18n.t('settings.backup_failed')}
                        </span>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    </div>
  {/if}

  {#if openForm}
    {@const canKeepSecret = Boolean(editing?.hasSecret && type === editing.type)}
    <Modal
      open
      onClose={closeForm}
      title={editing ? i18n.t('settings.edit_backup_target') : i18n.t('settings.add_backup_target')}
      description={canKeepSecret ? i18n.t('settings.leave_the_key_blank_to_leave_it_unchanged') : undefined}
      width={520}
    >
      <form id="backup-target-form" onsubmit={(event) => { event.preventDefault(); void save() }}>
        <fieldset disabled={busy} aria-busy={busy} class="min-w-0 space-y-3.5 border-0 p-0">
          {#if editing && type !== editing.type}
            <div class="flex items-start gap-2 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--warning)_28%,var(--border-subtle))] bg-[var(--bg-inset)] px-3 py-2 text-[11.5px] text-[var(--warning)]">
              <AlertCircle size={13} class="mt-0.5 shrink-0" />
              <span>{i18n.t('settings.enter_the_complete_credentials_for_the_new_backup_type_after_switching_t')}</span>
            </div>
          {/if}
          <div class="flex flex-col gap-1.5">
            <span class="block text-[12px] font-medium text-[var(--text-secondary)]">{i18n.t('settings.type')}</span>
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
            <TextInput id="backup-target-name" bind:value={name} required placeholder={i18n.t('settings.for_example_primary_r2_backup')} />
          </FormField>
          {#if type === 's3'}
            <FormField label={i18n.t('settings.endpoint')} for="backup-target-endpoint" hint={i18n.t('settings.leave_blank_unless_the_provider_requires_it_for_r2_use_url')}>
              <TextInput id="backup-target-endpoint" type="url" bind:value={endpoint} />
            </FormField>
            <div class="grid grid-cols-2 gap-3">
              <FormField label={i18n.t('settings.bucket')} for="backup-target-bucket">
                <TextInput id="backup-target-bucket" bind:value={bucket} required />
              </FormField>
              <FormField label={i18n.t('settings.region')} for="backup-target-region">
                <TextInput id="backup-target-region" bind:value={region} required />
              </FormField>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <FormField label={i18n.t('settings.access_key_id')} for="backup-target-access-key">
                <TextInput id="backup-target-access-key" bind:value={accessKeyId} autocomplete="off" placeholder={canKeepSecret ? i18n.t('settings.unchanged') : undefined} />
              </FormField>
              <FormField label={i18n.t('settings.secret_access_key')} for="backup-target-secret-key">
                <TextInput id="backup-target-secret-key" type="password" bind:value={secretAccessKey} autocomplete="off" placeholder={canKeepSecret ? i18n.t('settings.unchanged') : undefined} />
              </FormField>
            </div>
          {:else}
            <FormField label={i18n.t('settings.webdav_address')} for="backup-target-url" hint={i18n.t('settings.https_only_redirects_within_the_same_site_are_handled_automatically')}>
              <TextInput id="backup-target-url" type="url" bind:value={endpoint} required />
            </FormField>
            <div class="grid grid-cols-2 gap-3">
              <FormField label={i18n.t('common.username')} for="backup-target-username">
                <TextInput id="backup-target-username" bind:value={username} autocomplete="off" />
              </FormField>
              <FormField label={i18n.t('common.password')} for="backup-target-password" hint={i18n.t('settings.use_an_app_specific_password_when_possible')}>
                <TextInput id="backup-target-password" type="password" bind:value={password} autocomplete="off" placeholder={canKeepSecret ? i18n.t('settings.unchanged') : undefined} />
              </FormField>
            </div>
          {/if}
          <FormField label={i18n.t('settings.subdirectory')} for="backup-target-prefix" hint={i18n.t('settings.store_backups_in_this_directory_or_leave_blank_to_use_the_root_directory')}>
            <TextInput id="backup-target-prefix" bind:value={prefix} />
          </FormField>
          {#if result}
            <div role={result.ok ? 'status' : 'alert'} class={cn('flex items-start gap-2 rounded-[var(--r-md)] px-3 py-2.5 text-[12px] leading-relaxed', result.ok ? 'bg-[color-mix(in_oklab,var(--success)_12%,transparent)] text-[var(--success)]' : 'bg-[color-mix(in_oklab,var(--danger)_11%,transparent)] text-[var(--danger)]')}>
              {#if result.ok}<CheckCircle2 size={13} class="mt-px shrink-0" />{:else}<AlertCircle size={13} class="mt-px shrink-0" />{/if}
              <span>{result.message}{result.latencyMs ? ` · ${result.latencyMs}ms` : ''}</span>
            </div>
          {/if}
          {#if error}<p role="alert" class="text-[12px] text-[var(--danger)]">{error}</p>{/if}
        </fieldset>
      </form>
      {#snippet footer()}
        <Button variant="ghost" onclick={closeForm} disabled={busy}>{i18n.t('common.cancel')}</Button>
        <Button variant="secondary" disabled={busy} onclick={() => void test()}>{i18n.t('settings.test_connection')}</Button>
        <Button type="submit" form="backup-target-form" variant="primary" disabled={busy}>{i18n.t('common.save')}</Button>
      {/snippet}
    </Modal>
  {/if}
{/if}
