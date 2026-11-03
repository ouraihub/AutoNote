<script lang="ts">
  import BackupTargetModal from './BackupTargetModal.svelte'
  import BackupTargets from './BackupTargets.svelte'
  import BackupRuns from './BackupRuns.svelte'
  import { onMount } from 'svelte'
  import { AlertCircle, CloudUpload, Zap } from '@lucide/svelte'
  import type { MessageKey } from '@shared/locales/en-US'
  import type {
    BackupRun,
    BackupSchedule,
    BackupTarget,
    BackupTargetInput,
    TestConnectionResult,
  } from '@shared/types'
  import {
    getBackend,
    getI18n,
    getNotifier,
    getSession,
    getSettings,
  } from '@app/root/context'
  import Button from '@app/components/primitives/Button.svelte'
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
  import Segmented from '@app/components/primitives/Segmented.svelte'
  import { cloudError } from './accountCloud'

  const backend = getBackend()
  const session = getSession()
  const i18n = getI18n()
  const notifier = getNotifier()
  const settings = getSettings()
  const backup =
    backend.kind === 'web' && backend.capabilities.remoteBackup
      ? backend.backup
      : undefined
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
  const enabledCount = $derived(
    targets?.filter((item) => item.enabled).length ?? 0,
  )
  const sectionHeading =
    'text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]'

  async function reload(): Promise<void> {
    if (!backup || busy) return
    busy = true
    error = ''
    try {
      const [nextTargets, nextRuns] = await Promise.all([
        backup.targets({ signal: session.epochSignal }),
        backup.runs({ signal: session.epochSignal }),
      ])
      if (active) {
        targets = nextTargets
        runs = nextRuns
      }
    } catch (cause) {
      if (active && !session.epochSignal.aborted)
        error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }

  function edit(target: BackupTarget | null): void {
    editing = target
    type = target?.type ?? 'webdav'
    name = target?.name ?? ''
    const config = target?.config
    endpoint =
      config && 'endpoint' in config
        ? config.endpoint
        : config && 'url' in config
          ? config.url
          : ''
    region = config && 'region' in config ? config.region : 'auto'
    bucket = config && 'bucket' in config ? config.bucket : ''
    prefix = config?.prefix ?? 'autonote'
    username = config && 'username' in config ? config.username : ''
    password = accessKeyId = secretAccessKey = error = ''
    result = null
  }

  function payload(): BackupTargetInput {
    return {
      type,
      name: name.trim(),
      config:
        type === 'webdav'
          ? {
              url: endpoint.trim(),
              username: username.trim(),
              prefix: prefix.trim(),
              mode: 'archive',
            }
          : {
              endpoint: endpoint.trim(),
              region: region.trim(),
              bucket: bucket.trim(),
              prefix: prefix.trim(),
              pathStyle: true,
              mode: 'archive',
            },
      ...(!editing ||
      type !== editing.type ||
      password.trim() ||
      accessKeyId.trim() ||
      secretAccessKey.trim()
        ? {
            secret:
              type === 'webdav'
                ? { password }
                : { accessKeyId, secretAccessKey },
          }
        : {}),
    }
  }

  async function save(): Promise<void> {
    if (!backup || busy) return
    error = ''
    result = null
    if (
      editing &&
      type !== editing.type &&
      !(type === 'webdav'
        ? password.trim()
        : accessKeyId.trim() && secretAccessKey.trim())
    ) {
      error = i18n.t(
        ('settings.enter_the_complete_credentials_for_the_' +
          'new_backup_type_after_switching_t') as MessageKey,
      )
      return
    }
    busy = true
    try {
      const input = payload()
      const saved = editing
        ? await backup.patch(
            editing.id,
            { ...input, expectedUpdatedAt: editing.updatedAt },
            { signal: session.epochSignal },
          )
        : await backup.create(input, { signal: session.epochSignal })
      if (active) {
        targets = editing
          ? (targets?.map((item) => (item.id === saved.id ? saved : item)) ?? [
              saved,
            ])
          : [...(targets ?? []), saved]
        editing = null
        openForm = false
        password = accessKeyId = secretAccessKey = ''
      }
    } catch (cause) {
      if (active && !session.epochSignal.aborted)
        error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }

  async function test(): Promise<void> {
    if (!backup || busy) return
    busy = true
    error = ''
    result = null
    try {
      const checked = editing
        ? await backup.test(editing.id, payload(), {
            signal: session.epochSignal,
          })
        : await backup.testDraft(payload(), { signal: session.epochSignal })
      if (active) result = checked
    } catch (cause) {
      if (active && !session.epochSignal.aborted)
        error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }

  async function remove(target: BackupTarget): Promise<void> {
    if (
      !backup ||
      busy ||
      !(await notifier.confirm({
        titleKey: 'settings.backup_target',
        bodyKey:
          'settings.files_that_have_been_backed_up_there_will_not_be_deleted',
        danger: true,
      }))
    )
      return
    busy = true
    error = ''
    try {
      await backup.remove(target.id, { signal: session.epochSignal })
      if (active)
        targets = targets?.filter((item) => item.id !== target.id) ?? null
    } catch (cause) {
      if (active && !session.epochSignal.aborted)
        notifier.toast({ key: cloudError(cause), tone: 'error' })
    } finally {
      busy = false
    }
  }

  async function run(): Promise<void> {
    if (!backup || busy) return
    busy = running = true
    error = ''
    try {
      const next = await backup.run(undefined, { signal: session.epochSignal })
      if (active) {
        runs = [next, ...runs]
        notifier.toast({
          key:
            next.status === 'success'
              ? 'settings.backup_completed_value0_targets'
              : 'settings.backup_failed',
          params: { value0: next.results.filter((item) => item.ok).length },
          tone: next.status === 'success' ? 'success' : 'error',
        })
      }
    } catch (cause) {
      if (active && !session.epochSignal.aborted)
        notifier.toast({ key: cloudError(cause), tone: 'error' })
    } finally {
      busy = running = false
    }
  }

  function closeForm(): void {
    if (busy) return
    openForm = false
    password = accessKeyId = secretAccessKey = ''
  }

  onMount(() => {
    if (backup) void reload()
    return () => {
      active = false
    }
  })
</script>

{#if backup && session.status === 'authed'}
  {#if targets === null && error && !openForm}
    <div
      class="rounded-[var(--r-lg)] border
border-[color-mix(in_oklab,var(--danger)_28%,var(--border-subtle))]
        bg-[var(--bg-base)] p-4"
    >
      <div class="flex items-start gap-3">
        <AlertCircle size={16} class="mt-0.5 shrink-0 text-[var(--danger)]" />
        <div class="min-w-0 flex-1">
          <div class="text-[13px] font-medium text-[var(--text-primary)]">
            {i18n.t('settings.could_not_load_backup_settings')}
          </div>
          <p
            role="alert"
            class="mt-1 break-words text-[11.5px] text-[var(--text-tertiary)]"
          >
            {error}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onclick={() => void reload()}>{i18n.t('common.retry')}</Button
        >
      </div>
    </div>
  {:else if targets === null}
    <p
      role="status"
      class="py-4 text-center text-[12px] text-[var(--text-tertiary)]"
    >
      {i18n.t('settings.loading_backup_configuration')}
    </p>
  {:else}
    <div class="space-y-6">
      {#if error && !openForm}
        <div
          class="flex items-start gap-2 rounded-[var(--r-md)] border
border-[color-mix(in_oklab,var(--danger)_25%,var(--border-subtle))]
            bg-[var(--bg-base)] px-3 py-2 text-[11.5px] text-[var(--danger)]"
        >
          <AlertCircle size={13} class="mt-0.5 shrink-0" />
          <span role="alert" class="min-w-0 flex-1 break-words">{error}</span>
          <button
            type="button"
            class="shrink-0 font-medium underline underline-offset-2"
            disabled={busy}
            onclick={() => void reload()}>{i18n.t('common.retry')}</button
          >
        </div>
      {/if}

      <section
        class="rounded-[var(--r-lg)] border border-[var(--border-subtle)]
          bg-[var(--bg-base)] p-4"
      >
        <div class="flex items-start gap-3">
          <span class="mt-0.5 text-[var(--accent)]"
            ><CloudUpload size={18} /></span
          >
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-medium text-[var(--text-primary)]">
              {enabledCount > 0
                ? i18n.t('settings.value0_backup_targets_active', {
                    value0: enabledCount,
                  })
                : i18n.t('settings.no_backup_configured_yet')}
            </div>
            <p
              class="mt-1 text-[11.5px] leading-relaxed
                text-[var(--text-tertiary)]"
            >
              {i18n.t(
                ('settings.each_backup_goes_independently_to_every_' +
                  'enabled_target_it_includes_notes') as MessageKey,
              )}
            </p>
          </div>
          <Button
            size="sm"
            variant="primary"
            loading={running}
            disabled={busy || !enabledCount}
            onclick={() => void run()}
          >
            {#if !running}<Zap size={13} />{/if}{i18n.t('settings.back_up_now')}
          </Button>
        </div>
      </section>
      <BackupTargets
        {targets}
        {busy}
        onEdit={(target) => {
          edit(target)
          openForm = true
        }}
        onRemove={remove}
      />

      <section>
        <h3 class={['mb-1', sectionHeading]}>
          {i18n.t('settings.automatic_backups')}
        </h3>
        <SettingRow
          title={i18n.t('settings.frequency')}
          description={i18n.t(
            ('settings.runs_from_cloudflare_cron_the_page_' +
              'does_not_need_to_stay_open') as MessageKey,
          )}
        >
          <Segmented
            label={i18n.t('settings.frequency')}
            value={settings.current.backup.schedule}
            onChange={(schedule: BackupSchedule) =>
              settings.update({ backup: { schedule } })}
            options={[
              { value: 'off', label: i18n.t('common.off') },
              { value: 'hourly', label: i18n.t('settings.hourly') },
              { value: 'sixHourly', label: i18n.t('settings.every_6_hours') },
              { value: 'daily', label: i18n.t('settings.daily') },
            ]}
          />
        </SettingRow>
      </section>

      <BackupRuns {runs} />
    </div>
  {/if}
  <BackupTargetModal
    open={openForm}
    {editing}
    bind:type
    bind:name
    bind:endpoint
    bind:region
    bind:bucket
    bind:prefix
    bind:username
    bind:accessKeyId
    bind:secretAccessKey
    bind:password
    {result}
    {error}
    {busy}
    {i18n}
    onClose={closeForm}
    onSave={() => void save()}
    onTest={() => void test()}
  />
{/if}
