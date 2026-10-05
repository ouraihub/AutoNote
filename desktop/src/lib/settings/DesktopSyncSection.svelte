<script lang="ts">
  import { onMount } from 'svelte'
  import { getI18n, getNotifier } from '@app/root'
  import { listenSyncStatus } from '../ipc/transport'
  import {
    syncPort,
    type BindPreview,
    type BindStrategy,
    type SyncConflict,
    type SyncStatus,
  } from '../ipc/ports/remote-sync'

  const i18n = getI18n()
  const notifier = getNotifier()
  let status = $state<SyncStatus>()
  let preview = $state<BindPreview>()
  let origin = $state('')
  let username = $state('')
  let password = $state('')
  let loginId = $state<string>()
  let challengeToken = $state('')
  let totp = $state('')
  let strategy = $state<BindStrategy>('keep-local')
  let error = $state<string>()
  let busy = $state(false)

  onMount(() => {
    let active = true
    let unlisten: (() => void) | undefined
    void listenSyncStatus((value) => {
      if (active) status = value
    })
      .then((dispose) => {
        if (active) unlisten = dispose
        else dispose()
        return syncPort.status()
      })
      .then((value) => {
        if (active) status = value
      })
      .catch((reason: unknown) => {
        if (active) error = message(reason, i18n.locale === 'zh-CN' ? '无法读取同步状态' : 'Could not read sync status')
      })
    return () => {
      active = false
      unlisten?.()
    }
  })

  function message(
    reason: unknown,
    fallback = i18n.locale === 'zh-CN' ? '同步操作失败' : 'Sync operation failed',
  ): string {
    return reason instanceof Error ? reason.message : fallback
  }
  async function run(action: () => Promise<SyncStatus>): Promise<boolean> {
    if (busy) return false
    busy = true
    error = undefined
    try {
      status = await action()
      return true
    } catch (reason) {
      error = message(reason)
      return false
    } finally {
      busy = false
    }
  }
  async function login(): Promise<void> {
    if (busy || !origin.trim() || !username.trim() || !password) return
    busy = true
    error = undefined
    try {
      const reply = await syncPort.login(origin.trim(), username.trim(), password)
      password = ''
      loginId = reply.loginId
      if ('twoFactorRequired' in reply.result) challengeToken = reply.result.challengeToken
      else status = await syncPort.status()
    } catch (reason) {
      error = message(reason)
    } finally {
      busy = false
    }
  }
  async function completeTotp(): Promise<void> {
    if (busy || !loginId || !challengeToken || !totp.trim()) return
    busy = true
    error = undefined
    try {
      const reply = await syncPort.completeTotp(loginId, challengeToken, totp.trim())
      loginId = reply.loginId
      challengeToken = ''
      totp = ''
      status = await syncPort.status()
    } catch (reason) {
      error = message(reason)
    } finally {
      busy = false
    }
  }
  async function makePreview(): Promise<void> {
    if (busy || !loginId || challengeToken) return
    busy = true
    error = undefined
    try {
      preview = await syncPort.preview(loginId, strategy)
    } catch (reason) {
      error = message(reason)
    } finally {
      busy = false
    }
  }
  async function confirmPreview(): Promise<void> {
    const current = preview
    if (!current || busy) return
    if (await run(() => syncPort.confirm(current.previewId))) preview = undefined
  }
  function binding(): { bindingId: string; epoch: number } | null {
    if (
      status?.bindingId === null ||
      status?.bindingId === undefined ||
      status.epoch === null ||
      status.epoch === undefined
    )
      return null
    return { bindingId: status.bindingId, epoch: status.epoch }
  }
  function conflicts(): SyncConflict[] {
    return status?.conflictItems ?? []
  }
  async function unbind(): Promise<void> {
    const current = binding()
    if (
      !current ||
      busy ||
      !(await notifier.confirm({
        titleKey: i18n.locale === 'zh-CN' ? '解除同步绑定？' : 'Unbind synchronization?',
        bodyKey:
          i18n.locale === 'zh-CN'
            ? '未确认的更改将被隔离，不会删除本地笔记。'
            : 'Unconfirmed changes will be quarantined. Local notes will not be deleted.',
        danger: true,
      }))
    )
      return
    await run(() => syncPort.unbind(current.bindingId, current.epoch))
  }
  async function exportQuarantine(item: { bindingId: string; epoch: number }): Promise<void> {
    if (busy) return
    busy = true
    error = undefined
    try {
      const value = await syncPort.exportQuarantined(item.bindingId, item.epoch)
      const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
      const href = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = href
      link.download = `autonote-quarantine-${item.bindingId}.json`
      link.click()
      URL.revokeObjectURL(href)
    } catch (reason) {
      error = message(reason)
    } finally {
      busy = false
    }
  }
  async function discardQuarantine(item: { bindingId: string; epoch: number }): Promise<void> {
    if (
      busy ||
      !(await notifier.confirm({
        titleKey: i18n.locale === 'zh-CN' ? '丢弃隔离队列？' : 'Discard quarantined changes?',
        bodyKey:
          i18n.locale === 'zh-CN'
            ? '隔离队列将被永久丢弃。请先导出需要保留的更改。'
            : 'These quarantined changes will be permanently discarded. Export any changes you want to keep first.',
        danger: true,
      }))
    )
      return
    await run(() => syncPort.discardQuarantined(item.bindingId, item.epoch))
  }
</script>

<div class="flex flex-col gap-6">
  <section class="flex flex-col gap-3" aria-labelledby="sync-login-heading">
    <h3 id="sync-login-heading" class="font-medium">
      {i18n.locale === 'zh-CN' ? '远程同步绑定' : 'Remote sync binding'}
    </h3>
    <label class="flex flex-col gap-1 text-sm" for="sync-origin"
      >{i18n.locale === 'zh-CN' ? '站点地址' : 'Site origin'}<input
        id="sync-origin"
        class="rounded border px-2 py-1"
        type="url"
        bind:value={origin}
        placeholder="https://your-autonote.example"
        disabled={busy}
      /></label
    >
    <label class="flex flex-col gap-1 text-sm" for="sync-username"
      >{i18n.locale === 'zh-CN' ? '用户名' : 'Username'}<input
        id="sync-username"
        class="rounded border px-2 py-1"
        autocomplete="username"
        bind:value={username}
        disabled={busy}
      /></label
    >
    {#if !loginId}<label class="flex flex-col gap-1 text-sm" for="sync-password"
        >{i18n.locale === 'zh-CN' ? '密码' : 'Password'}<input
          id="sync-password"
          class="rounded border px-2 py-1"
          type="password"
          autocomplete="current-password"
          bind:value={password}
          disabled={busy}
        /></label
      ><button
        type="button"
        class="rounded border px-3 py-1 text-sm"
        disabled={busy || !origin || !username || !password}
        onclick={() => void login()}>{i18n.locale === 'zh-CN' ? '登录' : 'Sign in'}</button
      >{/if}
    {#if loginId && challengeToken}<label class="flex flex-col gap-1 text-sm" for="sync-totp"
        >{i18n.locale === 'zh-CN' ? '验证码或恢复码' : 'Authentication or recovery code'}<input
          id="sync-totp"
          class="rounded border px-2 py-1"
          inputmode="numeric"
          autocomplete="one-time-code"
          placeholder={i18n.locale === 'zh-CN' ? '验证码或恢复码' : 'Authentication or recovery code'}
          bind:value={totp}
          disabled={busy}
        /></label
      ><button
        type="button"
        class="rounded border px-3 py-1 text-sm"
        disabled={busy || !totp.trim()}
        onclick={() => void completeTotp()}>{i18n.locale === 'zh-CN' ? '验证' : 'Verify'}</button
      >{/if}
  </section>

  {#if status}
    {@const currentBinding = binding()}
    <section class="flex flex-col gap-3" aria-labelledby="sync-status-heading">
      <h3 id="sync-status-heading" class="font-medium">{i18n.locale === 'zh-CN' ? '同步状态' : 'Sync status'}</h3>
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt>{i18n.locale === 'zh-CN' ? '阶段' : 'Phase'}</dt>
        <dd>{status.phase}</dd>
        {#if status.siteOrigin}<dt>{i18n.locale === 'zh-CN' ? '站点' : 'Site'}</dt>
          <dd>{status.siteOrigin}</dd>{/if}
        {#if status.accountHint}<dt>{i18n.locale === 'zh-CN' ? '账户' : 'Account'}</dt>
          <dd>{status.accountHint}</dd>{/if}
        {#if status.bindingId}<dt>{i18n.locale === 'zh-CN' ? '绑定 ID' : 'Binding ID'}</dt>
          <dd>{status.bindingId}</dd>{/if}
        {#if status.epoch !== null}<dt>{i18n.locale === 'zh-CN' ? '绑定轮次' : 'Binding epoch'}</dt>
          <dd>{status.epoch}</dd>{/if}
        <dt>{i18n.locale === 'zh-CN' ? '本地游标' : 'Local cursor'}</dt>
        <dd>{status.localCursor}</dd>
        <dt>{i18n.locale === 'zh-CN' ? '远程游标' : 'Remote cursor'}</dt>
        <dd>{status.remoteCursor}</dd>
        <dt>{i18n.locale === 'zh-CN' ? '待发送' : 'Pending'}</dt>
        <dd>{status.pending}</dd>
        <dt>{i18n.locale === 'zh-CN' ? '已阻止' : 'Blocked'}</dt>
        <dd>{status.blocked}</dd>
        <dt>{i18n.locale === 'zh-CN' ? '冲突' : 'Conflicts'}</dt>
        <dd>{status.conflicts}</dd>
        <dt>{i18n.locale === 'zh-CN' ? '在线' : 'Online'}</dt>
        <dd>{status.online ? (i18n.locale === 'zh-CN' ? '是' : 'Yes') : i18n.locale === 'zh-CN' ? '否' : 'No'}</dd>
        {#if status.terminal}<dt>{i18n.locale === 'zh-CN' ? '已终止' : 'Terminal'}</dt>
          <dd>{i18n.locale === 'zh-CN' ? '是' : 'Yes'}</dd>{/if}
        {#if status.errorCode}<dt>{i18n.locale === 'zh-CN' ? '错误' : 'Error'}</dt>
          <dd>{status.errorCode}</dd>{/if}
      </dl>
      {#if status.metadataRisk}<p role="note">
          {i18n.locale === 'zh-CN'
            ? '文件夹和标签元数据更改可能影响其他笔记。请检查冲突后再继续。'
            : 'Folder and tag metadata changes may affect other notes. Review conflicts before continuing.'}
        </p>{/if}
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="rounded border px-3 py-1 text-sm"
          disabled={busy}
          onclick={() => void run(() => syncPort.start())}>{i18n.locale === 'zh-CN' ? '启动同步' : 'Start sync'}</button
        ><button
          type="button"
          class="rounded border px-3 py-1 text-sm"
          disabled={busy}
          onclick={() => void run(() => syncPort.stop())}>{i18n.locale === 'zh-CN' ? '停止同步' : 'Stop sync'}</button
        ><button
          type="button"
          class="rounded border px-3 py-1 text-sm"
          disabled={busy}
          onclick={() => void run(() => syncPort.now())}>{i18n.t('settings.sync_now')}</button
        >{#if currentBinding}<button
            type="button"
            class="rounded border px-3 py-1 text-sm"
            disabled={busy}
            onclick={() => void unbind()}>{i18n.locale === 'zh-CN' ? '解除绑定' : 'Unbind'}</button
          >{/if}
      </div>
    </section>
  {/if}

  {#if loginId && !challengeToken}
    <section class="flex flex-col gap-3" aria-labelledby="sync-strategy-heading">
      <h3 id="sync-strategy-heading" class="font-medium">
        {i18n.locale === 'zh-CN' ? '绑定策略' : 'Binding strategy'}
      </h3>
      <label class="flex gap-2 text-sm"
        ><input type="radio" bind:group={strategy} value="keep-local" />{i18n.locale === 'zh-CN'
          ? '保留本地并上传'
          : 'Keep local and upload'}</label
      >
      <label class="flex gap-2 text-sm"
        ><input type="radio" bind:group={strategy} value="import-remote" />{i18n.locale === 'zh-CN'
          ? '导入远程副本'
          : 'Import remote copies'}</label
      >
      <label class="flex gap-2 text-sm"
        ><input type="radio" bind:group={strategy} value="merge" />{i18n.locale === 'zh-CN'
          ? '合并本地与远程'
          : 'Merge local and remote'}</label
      >
      <button type="button" class="rounded border px-3 py-1 text-sm" disabled={busy} onclick={() => void makePreview()}
        >{i18n.locale === 'zh-CN' ? '预览绑定' : 'Preview binding'}</button
      >
      {#if preview}<p class="text-sm">
          {i18n.locale === 'zh-CN'
            ? `本地 ${preview.counts.local} · 远程 ${preview.counts.remote} · 匹配 ${preview.counts.matched} · 冲突 ${preview.counts.conflicts} · 附件 ${preview.counts.attachments} · 网络写入 ${preview.counts.networkWrites}`
            : `Local ${preview.counts.local} · Remote ${preview.counts.remote} · Matched ${preview.counts.matched} · Conflicts ${preview.counts.conflicts} · Attachments ${preview.counts.attachments} · Network writes ${preview.counts.networkWrites}`}
        </p>
        <button
          type="button"
          class="rounded border px-3 py-1 text-sm"
          disabled={busy}
          onclick={() => void confirmPreview()}>{i18n.locale === 'zh-CN' ? '确认绑定' : 'Confirm binding'}</button
        >{/if}
    </section>
  {/if}

  {#if conflicts().length}<section class="flex flex-col gap-2" aria-labelledby="sync-conflicts-heading">
      <h3 id="sync-conflicts-heading" class="font-medium">{i18n.locale === 'zh-CN' ? '同步冲突' : 'Sync conflicts'}</h3>
      {#each conflicts() as conflict (conflict.id)}{@const currentBinding = binding()}
        <div class="flex flex-wrap items-center gap-2 rounded border p-2 text-sm">
          <span>{`${conflict.entity}: ${conflict.reason}`}</span>{#if currentBinding}<button
              type="button"
              class="rounded border px-2 py-1"
              disabled={busy}
              onclick={() =>
                void run(() =>
                  syncPort.resolveConflict(conflict.id, 'local', currentBinding.bindingId, currentBinding.epoch),
                )}>{i18n.locale === 'zh-CN' ? '保留本地' : 'Keep local'}</button
            ><button
              type="button"
              class="rounded border px-2 py-1"
              disabled={busy}
              onclick={() =>
                void run(() =>
                  syncPort.resolveConflict(conflict.id, 'remote', currentBinding.bindingId, currentBinding.epoch),
                )}>{i18n.locale === 'zh-CN' ? '保留远程' : 'Keep remote'}</button
            ><button
              type="button"
              class="rounded border px-2 py-1"
              disabled={busy}
              onclick={() =>
                void run(() =>
                  syncPort.resolveConflict(conflict.id, 'keep-both', currentBinding.bindingId, currentBinding.epoch),
                )}>{i18n.locale === 'zh-CN' ? '保留两者' : 'Keep both'}</button
            >{/if}
        </div>{/each}
    </section>{/if}

  {#each status?.quarantined ?? [] as item (item.bindingId)}<section
      class="flex flex-wrap items-center gap-2 rounded border p-3 text-sm"
    >
      <span>{i18n.locale === 'zh-CN' ? '隔离队列' : 'Quarantined changes'} · {item.accountHint} ({item.pending})</span
      ><button
        type="button"
        class="rounded border px-2 py-1"
        disabled={busy}
        onclick={() => void exportQuarantine(item)}>{i18n.locale === 'zh-CN' ? '导出队列' : 'Export changes'}</button
      ><button
        type="button"
        class="rounded border px-2 py-1"
        disabled={busy}
        onclick={() => void discardQuarantine(item)}>{i18n.locale === 'zh-CN' ? '丢弃队列' : 'Discard changes'}</button
      >
    </section>{/each}
  {#if error}<p role="alert">{error}</p>{/if}
</div>
