<script lang="ts">
  import { Camera, KeyRound, ShieldCheck, UserRound } from '@lucide/svelte'
  import { LIMITS } from '@shared/constants'
  import { PROFILE_NAME_MAX_LENGTH } from '@shared/avatar'
  import {
    getBackend,
    getI18n,
    getNotifier,
    getSession,
  } from '@app/root/context'
  import Avatar from '@app/components/primitives/Avatar.svelte'
  import Button from '@app/components/primitives/Button.svelte'
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
  import Switch from '@app/components/primitives/Switch.svelte'
  import TextInput from '@app/components/primitives/TextInput.svelte'
  import { cloudError } from './accountCloud'
  import AvatarPicker from './AvatarPicker.svelte'
  import TotpSettings from './TotpSettings.svelte'

  type Section = 'profile' | 'password' | 'registration'
  const backend = getBackend()
  const session = getSession()
  const i18n = getI18n()
  const notifier = getNotifier()
  const account =
    backend.kind === 'web' && backend.capabilities.accounts
      ? backend.session.account
      : undefined
  let name = $state(session.user?.name ?? '')
  let currentPassword = $state('')
  let newPassword = $state('')
  let confirmation = $state('')
  let registrationPassword = $state('')
  let passwordOpen = $state(false)
  let confirmingRegistration = $state(false)
  let avatarOpen = $state(false)
  let busy = $state(false)
  let error = $state<{ at: Section; text: string } | null>(null)
  const normalizedName = $derived(name.trim().replace(/\s+/gu, ' '))
  const validName = $derived(
    Boolean(normalizedName) &&
      [...normalizedName].length <= PROFILE_NAME_MAX_LENGTH,
  )
  const sectionHeading =
    'mb-2 px-1 text-[12px] font-semibold text-[var(--text-secondary)]'
  const card =
    'rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)]'
  const fieldLabel = 'mb-1 block text-[11.5px] text-[var(--text-tertiary)]'

  function fail(at: Section, cause: unknown): void {
    if (!session.epochSignal.aborted)
      error = { at, text: i18n.t(cloudError(cause)) }
  }

  async function saveProfile(): Promise<void> {
    if (!account || busy) return
    if (!validName) {
      error = {
        at: 'profile',
        text: i18n.t('settings.display_name_length', {
          max: PROFILE_NAME_MAX_LENGTH,
        }),
      }
      return
    }
    busy = true
    error = null
    try {
      const user = await backend.session.updateProfile(
        { name: normalizedName },
        { signal: session.epochSignal },
      )
      if (session.user?.id !== user.id) return
      name = user.name
      notifier.toast({ key: 'settings.display_name_saved', tone: 'success' })
      await session.load({ signal: session.epochSignal })
    } catch (cause) {
      fail('profile', cause)
    } finally {
      busy = false
    }
  }

  function resetPassword(): void {
    currentPassword = newPassword = confirmation = ''
    error = null
  }

  async function savePassword(): Promise<void> {
    if (!account || busy) return
    if (!currentPassword) {
      error = {
        at: 'password',
        text: i18n.t('settings.enter_your_current_password'),
      }
      return
    }
    if (
      newPassword.length < 8 ||
      newPassword.length > LIMITS.passwordMaxLength
    ) {
      error = {
        at: 'password',
        text: i18n.t('settings.new_password_must_be_at_least_8_characters'),
      }
      return
    }
    if (newPassword !== confirmation) {
      error = {
        at: 'password',
        text: i18n.t('common.the_passwords_do_not_match'),
      }
      return
    }
    busy = true
    error = null
    try {
      await account.setPassword(
        { currentPassword, newPassword },
        { signal: session.epochSignal },
      )
      resetPassword()
      passwordOpen = false
      notifier.toast({ key: 'settings.password_updated', tone: 'success' })
    } catch (cause) {
      fail('password', cause)
    } finally {
      busy = false
    }
  }

  function cancelRegistration(): void {
    confirmingRegistration = false
    registrationPassword = ''
    error = null
  }

  async function toggleRegistration(): Promise<void> {
    if (!account || busy || !session.site || session.user?.role !== 'owner')
      return
    if (!registrationPassword) {
      error = {
        at: 'registration',
        text: i18n.t('settings.enter_your_current_password'),
      }
      return
    }
    busy = true
    error = null
    try {
      const changed = await account.updateRegistration(
        !session.site.registrationOpen,
        registrationPassword,
        { signal: session.epochSignal },
      )
      registrationPassword = ''
      confirmingRegistration = false
      notifier.toast({
        key: changed.registrationOpen
          ? 'settings.registration_open'
          : 'settings.registration_closed',
        tone: 'success',
      })
      await session.load({ signal: session.epochSignal })
    } catch (cause) {
      fail('registration', cause)
    } finally {
      busy = false
    }
  }
</script>

{#snippet inlineError(at: Section, className = '')}
  {#if error?.at === at}<p
      role="alert"
      class={['text-[12px] text-[var(--danger)]', className]}
    >
      {error.text}
    </p>{/if}
{/snippet}

{#if account && session.status === 'authed' && session.user}
  {@const user = session.user}
  <div class="space-y-6">
    <section>
      <h3 class={sectionHeading}>{i18n.t('settings.personal_profile')}</h3>
      <div class={['overflow-hidden', card]}>
        <div class="flex items-center gap-3 p-4">
          <button
            type="button"
            aria-label={i18n.t('settings.change_avatar')}
            onclick={() => (avatarOpen = true)}
            class="group relative shrink-0 rounded-full outline-none ring-offset-2 ring-offset-[var(--bg-base)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <Avatar src={user.avatarUrl} name={user.name} size={52} />
            <span
              class="absolute inset-0 flex items-center justify-center rounded-full bg-black/0 text-white opacity-0 transition-[background-color,opacity] group-hover:bg-black/40 group-hover:opacity-100 group-focus-visible:bg-black/40 group-focus-visible:opacity-100"
            >
              <Camera size={16} />
            </span>
          </button>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span
                class="truncate text-[14px] font-semibold text-[var(--text-primary)]"
                >{user.name}</span
              >
              {#if user.role === 'owner'}<span
                  class="inline-flex items-center rounded-full bg-[var(--accent-soft)] px-[7px] py-[1px] text-[11px] font-medium tabular text-[var(--accent)]"
                  >{i18n.t('common.owner')}</span
                >{/if}
            </div>
            <div
              class="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-[var(--text-tertiary)]"
            >
              <UserRound size={11} />@{user.username}
            </div>
            <p class="mt-1 text-[10.5px] text-[var(--text-quaternary)]">
              {i18n.t('settings.username_is_sign_in_id')}
            </p>
          </div>
        </div>

        <form
          class="border-t border-[var(--border-subtle)] px-4 py-3.5"
          onsubmit={(event) => {
            event.preventDefault()
            void saveProfile()
          }}
        >
          <label
            for="profile-display-name"
            class="block text-[11.5px] font-medium text-[var(--text-secondary)]"
            >{i18n.t('settings.display_name')}</label
          >
          <div class="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <TextInput
              id="profile-display-name"
              bind:value={name}
              maxlength={PROFILE_NAME_MAX_LENGTH * 2}
              oninput={() => (error = null)}
              disabled={busy}
              autocomplete="name"
              class="flex-1"
            />
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={busy}
              disabled={normalizedName === user.name || !validName}
            >
              {i18n.t('common.save')}
            </Button>
          </div>
          {@render inlineError('profile', 'mt-1.5')}
        </form>
      </div>
    </section>

    <section>
      <h3 class={sectionHeading}>{i18n.t('settings.sign_in_security')}</h3>
      <div class="space-y-2">
        <div class={card}>
          <SettingRow
            class="px-4"
            title={i18n.t('settings.login_password')}
            description={i18n.t(
              'settings.username_value0_changing_the_password_signs_out_other_devices',
              { value0: user.username },
            )}
          >
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onclick={() => {
                passwordOpen = !passwordOpen
                resetPassword()
              }}
            >
              <KeyRound size={12} />{passwordOpen
                ? i18n.t('common.collapse')
                : i18n.t('settings.change_password')}
            </Button>
          </SettingRow>
          {#if passwordOpen}
            <form
              class="space-y-2.5 border-t border-[var(--border-subtle)] px-4 py-3.5"
              onsubmit={(event) => {
                event.preventDefault()
                void savePassword()
              }}
            >
              <label class="block">
                <span class={fieldLabel}
                  >{i18n.t('settings.current_password')}</span
                >
                <TextInput
                  type="password"
                  bind:value={currentPassword}
                  maxlength={LIMITS.passwordMaxLength}
                  disabled={busy}
                  autocomplete="current-password"
                  required
                />
              </label>
              <div class="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                <label class="block">
                  <span class={fieldLabel}
                    >{i18n.t('settings.new_password')}</span
                  >
                  <TextInput
                    type="password"
                    bind:value={newPassword}
                    minlength={8}
                    maxlength={LIMITS.passwordMaxLength}
                    disabled={busy}
                    autocomplete="new-password"
                    required
                  />
                </label>
                <label class="block">
                  <span class={fieldLabel}
                    >{i18n.t('settings.confirm_new_password')}</span
                  >
                  <TextInput
                    type="password"
                    bind:value={confirmation}
                    maxlength={LIMITS.passwordMaxLength}
                    disabled={busy}
                    autocomplete="new-password"
                    required
                  />
                </label>
              </div>
              {@render inlineError('password')}
              <div class="flex justify-end">
                <Button type="submit" variant="primary" size="sm" loading={busy}
                  >{i18n.t('common.save')}</Button
                >
              </div>
            </form>
          {/if}
        </div>
        {#if backend.capabilities.totp}<TotpSettings />{/if}
      </div>
    </section>

    {#if user.role === 'owner' && session.site}
      {@const enabled = session.site.registrationOpen}
      <section>
        <h3 class={sectionHeading}>{i18n.t('common.access_control')}</h3>
        <div class={card}>
          <SettingRow
            class="px-4"
            title={i18n.t('common.open_registration')}
            description={`${enabled ? i18n.t('settings.open_anyone_can_register_with_a_username_and_password') : i18n.t('settings.off_default_only_existing_accounts_can_log_in')} ${i18n.t('settings.changing_this_requires_your_current_password_and_takes_effect_immediatel')}`}
          >
            <Switch
              checked={enabled}
              disabled={busy}
              label={i18n.t('common.open_registration')}
              onChange={() => {
                registrationPassword = ''
                error = null
                confirmingRegistration = true
              }}
            />
          </SettingRow>
          {#if confirmingRegistration}
            <form
              class="space-y-2.5 border-t border-[var(--border-subtle)] px-4 py-3.5"
              onsubmit={(event) => {
                event.preventDefault()
                void toggleRegistration()
              }}
            >
              <label class="block">
                <span
                  class="mb-1 flex items-center gap-1.5 text-[11.5px] text-[var(--text-tertiary)]"
                >
                  <ShieldCheck size={12} />
                  {enabled
                    ? i18n.t(
                        'settings.close_registration_requires_password_verification',
                      )
                    : i18n.t(
                        'settings.open_registration_requires_password_verification',
                      )}
                </span>
                <TextInput
                  type="password"
                  bind:value={registrationPassword}
                  maxlength={LIMITS.passwordMaxLength}
                  disabled={busy}
                  autocomplete="current-password"
                  required
                />
              </label>
              {@render inlineError('registration')}
              <div class="flex justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onclick={cancelRegistration}>{i18n.t('common.cancel')}</Button
                >
                <Button
                  type="submit"
                  size="sm"
                  variant={enabled ? 'primary' : 'danger'}
                  loading={busy}
                >
                  {enabled
                    ? i18n.t('settings.confirm_closing_registration')
                    : i18n.t('settings.confirm_opening_registration')}
                </Button>
              </div>
            </form>
          {/if}
        </div>
      </section>
    {/if}
    {#if avatarOpen}<AvatarPicker onClose={() => (avatarOpen = false)} />{/if}
  </div>
{/if}
