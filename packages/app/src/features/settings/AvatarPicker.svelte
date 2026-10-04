<script lang="ts">
  import { generatedAvatarPreference, GENERATED_AVATAR_SEED_LENGTH } from '@shared/avatar'
  import { getBackend, getI18n, getSession } from '@app/root/context'
  import { cloudError } from './accountCloud'

  let { onClose }: { onClose(): void } = $props()
  const backend = getBackend()
  const session = getSession()
  const i18n = getI18n()
  const account = backend.kind === 'web' && backend.capabilities.accounts ? backend.session.account : undefined
  let selected = $state(session.user?.avatarUrl ?? '')
  let busy = $state(false)
  let error = $state('')

  function randomAvatar(): void {
    const bytes = crypto.getRandomValues(new Uint8Array(GENERATED_AVATAR_SEED_LENGTH / 2))
    selected = generatedAvatarPreference(Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''))
  }

  async function save(): Promise<void> {
    if (!account || !session.user || busy) return
    if (selected === session.user.avatarUrl) { onClose(); return }
    busy = true
    error = ''
    try {
      await account.updateProfile({ avatarUrl: selected }, { signal: session.epochSignal })
      await session.load({ signal: session.epochSignal })
      if (!session.epochSignal.aborted) onClose()
    } catch (cause) {
      if (!session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }
</script>

{#if account && session.status === 'authed'}
  <div class="space-y-2 rounded border p-3" role="group" aria-label={i18n.t('settings.change_avatar')}>
    <p>{i18n.t('settings.selected_avatar')}: {selected ? selected.startsWith('dicebear:') ? i18n.t('settings.random_avatar') : i18n.t('settings.uploaded_avatar') : i18n.t('settings.name_based_avatar')}</p>
    {#if selected && !selected.startsWith('dicebear:')}<img src={selected} alt={i18n.t('settings.selected_avatar')} class="size-16 rounded-full object-cover" />{/if}
    <button class="rounded border px-2 py-1" type="button" disabled={busy} onclick={randomAvatar}>{i18n.t('settings.random_avatars')}</button>
    <button class="rounded border px-2 py-1" type="button" disabled={busy} onclick={() => selected = ''}>{i18n.t('settings.use_name_avatar')}</button>
    <button class="rounded border px-2 py-1" type="button" disabled={busy} onclick={() => void save()}>{i18n.t('common.save')}</button>
    <button class="rounded border px-2 py-1" type="button" disabled={busy} onclick={onClose}>{i18n.t('common.cancel')}</button>
    {#if error}<p role="alert">{error}</p>{/if}
  </div>
{/if}
