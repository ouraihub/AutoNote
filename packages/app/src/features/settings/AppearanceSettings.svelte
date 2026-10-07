<script lang="ts">
  import { Check, Monitor, Moon, Sun } from '@lucide/svelte'
  import { ACCENTS } from '@shared/constants'
  import type { AccentName, AppearanceSettings as Appearance, BackgroundName } from '@shared/types'
  import type { MessageKey } from '@shared/locales/en-US'
  import { getI18n, getSettings } from '@app/root/context'
  import { messageKeyForError } from '@app/i18n/errors'
  import Segmented from '@app/components/primitives/Segmented.svelte'
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
  import Slider from '@app/components/primitives/Slider.svelte'

  const settings = getSettings()
  const i18n = getI18n()
  const labels: Record<AccentName, MessageKey> = {
    cinnabar: 'settings.accent.cinnabar',
    indigo: 'settings.accent.indigo',
    celadon: 'settings.accent.celadon',
    amber: 'settings.accent.amber',
    terracotta: 'settings.accent.terracotta',
    wisteria: 'settings.accent.wisteria',
    graphite: 'settings.accent.graphite',
  }
  const backgrounds: { name: BackgroundName; label: MessageKey; swatch: string }[] = [
    { name: 'paper', label: 'settings.background_paper', swatch: '#f7f5f1' },
    { name: 'white', label: 'settings.background_white', swatch: '#ffffff' },
  ]
  const appearance = $derived(settings.current.appearance)
  function update<K extends keyof Appearance>(key: K, value: Appearance[K]): void {
    settings.update({ appearance: { [key]: value } })
  }
</script>

<div>
  {#if settings.error}<p role="alert" class="mb-2 text-[11.5px] text-[var(--danger)]">
      {i18n.t(messageKeyForError(settings.error))}
    </p>{/if}
  <section>
    <SettingRow title={i18n.t('settings.interface_language')}>
      <Segmented
        label={i18n.t('settings.interface_language')}
        value={appearance.language}
        onChange={(language) => update('language', language)}
        options={[
          { value: 'zh-CN', label: i18n.t('settings.simplified_chinese') },
          { value: 'en-US', label: i18n.t('settings.english') },
        ]}
      />
    </SettingRow>

    <SettingRow title={i18n.t('settings.theme')}>
      <Segmented
        label={i18n.t('settings.theme')}
        value={appearance.theme}
        onChange={(theme) => update('theme', theme)}
        options={[
          { value: 'light', icon: Sun, title: i18n.t('settings.light') },
          { value: 'dark', icon: Moon, title: i18n.t('settings.dark') },
          { value: 'system', icon: Monitor, title: i18n.t('settings.system') },
        ]}
      />
    </SettingRow>

    <SettingRow title={i18n.t('settings.accent_color')}>
      <div role="group" aria-label={i18n.t('settings.accent_color')} class="flex items-center gap-1.5">
        {#each ACCENTS as accent (accent.name)}
          {@const selected = appearance.accent === accent.name}
          <button
            type="button"
            onclick={() => update('accent', accent.name)}
            aria-label={i18n.t(labels[accent.name])}
            title={i18n.t(labels[accent.name])}
            aria-pressed={selected}
            class={[
              'relative flex size-6 items-center justify-center rounded-full transition-transform duration-[var(--dur-fast)] ease-[var(--ease-spring)]',
              'hover:scale-110 active:scale-95',
              selected && 'ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--bg-overlay)]',
            ]}
            style:background={accent.swatch}
            style:color={accent.foreground}
          >
            {#if selected}<Check size={12} strokeWidth={3} class="drop-shadow-sm" />{/if}
          </button>
        {/each}
      </div>
    </SettingRow>

    <SettingRow title={i18n.t('settings.background_color')}>
      <div role="group" aria-label={i18n.t('settings.background_color')} class="flex items-center gap-2">
        {#each backgrounds as background (background.name)}
          {@const selected = appearance.background === background.name}
          <button
            type="button"
            onclick={() => update('background', background.name)}
            aria-pressed={selected}
            class={[
              'flex h-8 min-w-[84px] items-center gap-2 rounded-[var(--r-md)] border px-2.5 text-[11.5px] transition-[border-color,background-color,box-shadow] duration-[var(--dur-fast)]',
              selected
                ? 'border-[var(--accent)] bg-[var(--accent-softer)] shadow-[0_0_0_2px_var(--accent-ring)]'
                : 'border-[var(--border-default)] bg-[var(--bg-base)] hover:bg-[var(--bg-hover)]',
            ]}
          >
            <span
              aria-hidden="true"
              class="size-4 rounded-full border border-black/10 shadow-sm"
              style:background={background.swatch}
            ></span>
            <span>{i18n.t(background.label as MessageKey)}</span>
            {#if selected}<Check size={11} class="ml-auto text-[var(--accent)]" />{/if}
          </button>
        {/each}
      </div>
    </SettingRow>

    <SettingRow title={i18n.t('settings.interface_density')}>
      <Segmented
        label={i18n.t('settings.interface_density')}
        value={appearance.density}
        onChange={(density) => update('density', density)}
        options={[
          { value: 'comfortable', label: i18n.t('settings.comfortable') },
          { value: 'compact', label: i18n.t('settings.compact') },
        ]}
      />
    </SettingRow>
  </section>

  <section>
    <h3 class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
      {i18n.t('settings.preview_typography')}
    </h3>

    <SettingRow title={i18n.t('settings.body_font')}>
      <Segmented
        label={i18n.t('settings.body_font')}
        value={appearance.proseFont}
        onChange={(proseFont) => update('proseFont', proseFont)}
        options={[
          { value: 'sans', label: i18n.t('common.sans_serif') },
          { value: 'serif', label: i18n.t('settings.serif') },
        ]}
      />
    </SettingRow>

    <SettingRow title={i18n.t('settings.body_text_size')}>
      <Slider
        label={i18n.t('settings.body_text_size')}
        class="w-[200px]"
        value={appearance.proseSize}
        min={13}
        max={22}
        onChange={(proseSize) => update('proseSize', proseSize)}
        suffix="px"
      />
    </SettingRow>

    <SettingRow title={i18n.t('settings.line_height')}>
      <Slider
        label={i18n.t('settings.line_height')}
        class="w-[200px]"
        value={appearance.proseLineHeight}
        min={1.4}
        max={2.2}
        step={0.05}
        onChange={(proseLineHeight) => update('proseLineHeight', proseLineHeight)}
      />
    </SettingRow>

    <SettingRow title={i18n.t('settings.content_width')}>
      <Segmented
        label={i18n.t('settings.content_width')}
        value={appearance.proseWidth}
        onChange={(proseWidth) => update('proseWidth', proseWidth)}
        options={[
          { value: 'narrow', label: i18n.t('settings.narrow') },
          { value: 'normal', label: i18n.t('settings.standard') },
          { value: 'wide', label: i18n.t('settings.wide') },
          { value: 'full', label: i18n.t('settings.full') },
        ]}
      />
    </SettingRow>
  </section>

  <section>
    <h3 class="mb-2 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
      {i18n.t('settings.preview')}
    </h3>
    <div class="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-3">
      <div class="ink-prose" data-font={appearance.proseFont} style:max-width="none" style:padding-block="0">
        <h3 style:margin-top="0">{i18n.t('settings.q_a_in_the_mountains')}</h3>
        <p>
          {i18n.t('settings.asked_why_i_wanted_to_live_in_the_green_mountains_i_smiled_without_answe')}
          {i18n.t('settings.chinese_english_and')} <code>{i18n.t('common.inline_code')}</code>
          {i18n.t('settings.look_at_home_together')}
        </p>
      </div>
    </div>
  </section>
</div>
