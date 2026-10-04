<script lang="ts">
  import { onMount } from 'svelte'
  import type { BackupRun, BackupSchedule, BackupTarget, BackupTargetInput } from '@shared/types'
  import { getBackend, getI18n, getNotifier, getSession, getSettings } from '@app/root/context'
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
  let result = $state('')
  let error = $state('')
  let busy = $state(false)
  let active = true

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
    password = accessKeyId = secretAccessKey = result = error = ''
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
    error = result = ''
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
    error = result = ''
    try {
      const checked = editing
        ? await backup.test(editing.id, payload(), { signal: session.epochSignal })
        : await backup.testDraft(payload(), { signal: session.epochSignal })
      if (active) result = `${checked.ok ? '✓' : '✗'} ${checked.message}`
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
      if (active && !session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally { busy = false }
  }

  async function run(): Promise<void> {
    if (!backup || busy) return
    busy = true
    error = ''
    try {
      const next = await backup.run(undefined, { signal: session.epochSignal })
      if (active) { runs = [next, ...runs]; result = i18n.t(next.status === 'success' ? 'settings.backup_completed_value0_targets' : 'settings.backup_failed', { value0: next.results.filter((item) => item.ok).length }) }
    } catch (cause) {
      if (active && !session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally { busy = false }
  }

  onMount(() => { if (backup) void reload(); return () => { active = false } })
</script>

{#if backup && session.status === 'authed'}
  <section class="space-y-4">
    <button class="rounded border px-2 py-1" type="button" disabled={busy} onclick={() => void reload()}>{i18n.t('common.retry')}</button>
    {#if error}<p role="alert">{error}</p>{/if}
    {#if result}<p role="status">{result}</p>{/if}
    {#if targets === null && !error}<p role="status">{i18n.t('common.loading')}</p>{/if}
    {#if targets}
      <button class="rounded border px-2 py-1" type="button" disabled={busy || !targets.some((item) => item.enabled)} onclick={() => void run()}>{i18n.t('settings.back_up_now')}</button>
      <ul class="divide-y rounded border">{#each targets as target (target.id)}
        <li class="flex flex-wrap items-center justify-between gap-2 p-2"><span>{target.name} · {target.type === 's3' ? i18n.t('settings.s3_backup') : i18n.t('settings.webdav_backup')} · {target.enabled ? i18n.t('common.on') : i18n.t('common.off')}</span>
          <span class="flex gap-2"><button class="rounded border px-2 py-1" disabled={busy} onclick={() => { edit(target); openForm = true }}>{i18n.t('common.edit')}</button><button class="rounded border px-2 py-1" disabled={busy} onclick={() => void remove(target)}>{i18n.t('common.delete')}</button></span></li>
      {/each}</ul>
      <button class="rounded border px-2 py-1" disabled={busy} onclick={() => { edit(null); openForm = true }}>{i18n.t('settings.add_target')}</button>
      <label class="block">{i18n.t('settings.frequency')}
        <select class="rounded border bg-background" value={settings.current.backup.schedule} onchange={(event) => settings.update({ backup: { schedule: event.currentTarget.value as BackupSchedule } })}>
          <option value="off">{i18n.t('common.off')}</option><option value="hourly">{i18n.t('settings.hourly')}</option><option value="sixHourly">{i18n.t('settings.every_6_hours')}</option><option value="daily">{i18n.t('settings.daily')}</option>
        </select>
      </label>
      <h3 class="font-semibold">{i18n.t('settings.latest_backups')}</h3>
      {#if runs.length}<ul>{#each runs as item (item.id)}<li>{item.status} · {new Date(item.startedAt).toLocaleString(i18n.locale)}</li>{/each}</ul>{:else}<p>{i18n.t('settings.no_backup_record_yet')}</p>{/if}
    {/if}
    {#if openForm}
      <form class="space-y-2 rounded border p-3" onsubmit={(event) => { event.preventDefault(); void save() }}>
        <label class="block">{i18n.t('settings.type')} <select class="rounded border bg-background" bind:value={type} disabled={busy}><option value="webdav">{i18n.t('settings.webdav_backup')}</option><option value="s3">{i18n.t('settings.s3_backup')}</option></select></label>
        <label class="block">{i18n.t('settings.name')} <input class="rounded border bg-background" bind:value={name} required disabled={busy} /></label>
        <label class="block">{type === 'webdav' ? i18n.t('settings.webdav_address') : i18n.t('settings.endpoint')} <input class="rounded border bg-background" type="url" bind:value={endpoint} required={type === 'webdav'} disabled={busy} /></label>
        {#if type === 's3'}
          <label class="block">{i18n.t('settings.region')} <input class="rounded border bg-background" bind:value={region} required disabled={busy} /></label>
          <label class="block">{i18n.t('settings.bucket')} <input class="rounded border bg-background" bind:value={bucket} required disabled={busy} /></label>
          <label class="block">{i18n.t('settings.access_key_id')} <input class="rounded border bg-background" autocomplete="off" bind:value={accessKeyId} disabled={busy} /></label>
          <label class="block">{i18n.t('settings.secret_access_key')} <input class="rounded border bg-background" type="password" autocomplete="off" bind:value={secretAccessKey} disabled={busy} /></label>
        {:else}
          <label class="block">{i18n.t('common.username')} <input class="rounded border bg-background" bind:value={username} disabled={busy} /></label>
          <label class="block">{i18n.t('common.password')} <input class="rounded border bg-background" type="password" autocomplete="off" bind:value={password} disabled={busy} /></label>
        {/if}
        <label class="block">{i18n.t('settings.subdirectory')} <input class="rounded border bg-background" bind:value={prefix} disabled={busy} /></label>
        <button class="rounded border px-2 py-1" type="submit" disabled={busy}>{i18n.t('common.save')}</button>
        <button class="rounded border px-2 py-1" type="button" disabled={busy} onclick={() => void test()}>{i18n.t('settings.test_connection')}</button>
        <button class="rounded border px-2 py-1" type="button" disabled={busy} onclick={() => { openForm = false; password = accessKeyId = secretAccessKey = '' }}>{i18n.t('common.cancel')}</button>
      </form>
    {/if}
  </section>
{/if}
