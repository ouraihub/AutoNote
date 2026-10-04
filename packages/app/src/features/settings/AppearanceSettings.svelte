<script lang="ts">
  import { ACCENTS } from '@shared/constants'
  import type { AccentName, AppearanceSettings as Appearance, BackgroundName, ProseWidth, ThemePref, UiDensity, ProseFont, AppLocale } from '@shared/types'
  import { getI18n, getSettings } from '@app/root/context'
  import { messageKeyForError } from '@app/i18n/errors'
  import type { MessageKey } from '@shared/locales/en-US'

  const settings = getSettings()
  const i18n = getI18n()
  const labels: Record<AccentName, MessageKey> = {
    cinnabar: 'settings.accent.cinnabar', indigo: 'settings.accent.indigo',
    celadon: 'settings.accent.celadon', amber: 'settings.accent.amber',
    terracotta: 'settings.accent.terracotta', wisteria: 'settings.accent.wisteria',
    graphite: 'settings.accent.graphite',
  }
  const options: { label: MessageKey; key: 'language' | 'theme' | 'background' | 'density' | 'proseFont' | 'proseWidth'; values: readonly string[]; names: readonly MessageKey[] }[] = [
    { label: 'settings.interface_language', key: 'language', values: ['zh-CN', 'en-US'] satisfies AppLocale[], names: ['settings.simplified_chinese', 'settings.english'] },
    { label: 'settings.theme', key: 'theme', values: ['light', 'dark', 'system'] satisfies ThemePref[], names: ['settings.light', 'settings.dark', 'settings.system'] },
    { label: 'settings.background_color', key: 'background', values: ['paper', 'white'] satisfies BackgroundName[], names: ['settings.background_paper', 'settings.background_white'] },
    { label: 'settings.interface_density', key: 'density', values: ['comfortable', 'compact'] satisfies UiDensity[], names: ['settings.comfortable', 'settings.compact'] },
    { label: 'settings.body_font', key: 'proseFont', values: ['sans', 'serif'] satisfies ProseFont[], names: ['common.sans_serif', 'settings.serif'] },
    { label: 'settings.content_width', key: 'proseWidth', values: ['narrow', 'normal', 'wide', 'full'] satisfies ProseWidth[], names: ['settings.narrow', 'settings.standard', 'settings.wide', 'settings.full'] },
  ]
  const scales = [
    { key: 'proseSize', label: 'settings.body_text_size', min: 13, max: 22, step: 1 },
    { key: 'proseLineHeight', label: 'settings.line_height', min: 1.4, max: 2.2, step: 0.05 },
  ] as const
  function update<K extends keyof Appearance>(key: K, value: Appearance[K]): void {
    settings.update({ appearance: { [key]: value } })
  }
</script>

<div class="space-y-5">
  {#if settings.error}<p role="alert">{i18n.t(messageKeyForError(settings.error))}</p>{/if}
  {#each options as option (option.key)}
    <fieldset class="space-y-2">
      <legend class="text-sm font-medium">{i18n.t(option.label)}</legend>
      <div class="flex flex-wrap gap-2">
        {#each option.values as value, index (value)}
          <button type="button" aria-pressed={settings.current.appearance[option.key] === value}
            class="rounded border px-2 py-1 text-sm aria-pressed:border-primary aria-pressed:bg-accent"
            onclick={() => update(option.key, value as Appearance[typeof option.key])}>{i18n.t(option.names[index] ?? option.label)}</button>
        {/each}
      </div>
    </fieldset>
  {/each}
  <fieldset class="space-y-2">
    <legend class="text-sm font-medium">{i18n.t('settings.accent_color')}</legend>
    <div class="flex flex-wrap gap-2">
      {#each ACCENTS as accent (accent.name)}
        <button type="button" aria-label={i18n.t(labels[accent.name])} aria-pressed={settings.current.appearance.accent === accent.name}
          class="size-8 rounded-full border-2 aria-pressed:border-foreground" style={`background:${accent.swatch}`}
          onclick={() => update('accent', accent.name)}></button>
      {/each}
    </div>
  </fieldset>
  {#each scales as scale (scale.key)}
    <label class="flex items-center gap-3 text-sm">
      <span>{i18n.t(scale.label)}</span>
      <input type="range" min={scale.min} max={scale.max} step={scale.step}
        value={settings.current.appearance[scale.key]}
        oninput={(event) => update(scale.key, Number(event.currentTarget.value))} />
      <output>{settings.current.appearance[scale.key]}</output>
    </label>
  {/each}
</div>
