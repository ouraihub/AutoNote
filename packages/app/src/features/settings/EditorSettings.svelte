<script lang="ts">
  import type { EditorSettings as Editor, PreviewSettings as Preview } from '@shared/types'
  import type { MessageKey } from '@shared/locales/en-US'
  import { getI18n, getSettings } from '@app/root/context'
  import { messageKeyForError } from '@app/i18n/errors'
  import Segmented from '@app/components/primitives/Segmented.svelte'
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
  import Slider from '@app/components/primitives/Slider.svelte'
  import Switch from '@app/components/primitives/Switch.svelte'

  type EditorSwitch = 'lineNumbers' | 'showToolbar' | 'spellcheck' | 'typewriter' | 'focusMode'
  type PreviewSwitch = 'syncScroll' | 'math' | 'mermaid' | 'codeBlockCollapse' | 'showToc'
  const i18n = getI18n()
  const settings = getSettings()
  const basics: { key: EditorSwitch; title: MessageKey }[] = [
    { key: 'lineNumbers', title: 'settings.show_line_numbers' },
    { key: 'showToolbar', title: 'settings.show_toolbar' },
    { key: 'spellcheck', title: 'settings.spellcheck' },
  ]
  const writing: { key: EditorSwitch; title: MessageKey; description: MessageKey }[] = [
    { key: 'typewriter', title: 'settings.typewriter_mode', description: 'settings.keep_the_cursor_line_centered_on_screen' },
    { key: 'focusMode', title: 'settings.focus_mode', description: 'settings.fade_content_outside_the_current_paragraph' },
  ]
  const previews: { key: PreviewSwitch; title: MessageKey; description?: MessageKey }[] = [
    { key: 'syncScroll', title: 'settings.scroll_sync', description: 'settings.keep_the_editor_and_preview_scrolled_together' },
    { key: 'math', title: 'settings.math', description: 'settings.render_and_using_katex' },
    { key: 'mermaid', title: 'settings.diagram', description: 'settings.render_mermaid_code_blocks_into_flowcharts' },
    { key: 'codeBlockCollapse', title: 'settings.collapse_long_code_blocks', description: 'settings.collapse_long_code_blocks_description' },
  ]
  const editorValues = $derived(settings.current.editor)
  const previewValues = $derived(settings.current.preview)
  function editor<K extends keyof Editor>(key: K, value: Editor[K]): void {
    settings.update({ editor: { [key]: value } })
  }
  function preview<K extends keyof Preview>(key: K, value: Preview[K]): void {
    settings.update({ preview: { [key]: value } })
  }
</script>

{#snippet toggle(title: MessageKey, checked: boolean, onChange: (next: boolean) => void, description?: MessageKey)}
  <SettingRow title={i18n.t(title as MessageKey)} description={description ? i18n.t(description as MessageKey) : undefined}>
    <Switch {checked} {onChange} label={i18n.t(title as MessageKey)} />
  </SettingRow>
{/snippet}

<div class="space-y-6">
  {#if settings.error}<p role="alert" class="text-[11.5px] text-[var(--danger)]">
      {i18n.t(messageKeyForError(settings.error))}
    </p>{/if}
  <section>
    <SettingRow title={i18n.t('settings.editor_font')}>
      <Segmented
        label={i18n.t('settings.editor_font')}
        value={editorValues.fontFamily}
        onChange={(fontFamily) => editor('fontFamily', fontFamily)}
        options={[
          { value: 'mono', label: i18n.t('settings.monospace') },
          { value: 'sans', label: i18n.t('common.sans_serif') },
        ]}
      />
    </SettingRow>

    <SettingRow title={i18n.t('settings.editor_font_size')}>
      <Slider
        label={i18n.t('settings.editor_font_size')}
        class="w-[200px]"
        value={editorValues.fontSize}
        min={12}
        max={22}
        onChange={(fontSize) => editor('fontSize', fontSize)}
        suffix="px"
      />
    </SettingRow>

    {#each basics as item (item.key)}
      {@render toggle(item.title, Boolean(editorValues[item.key]), (next) => editor(item.key, next))}
    {/each}
  </section>

  <section>
    <h3 class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
      {i18n.t('settings.writing_mode')}
    </h3>
    {#each writing as item (item.key)}
      {@render toggle(item.title, Boolean(editorValues[item.key]), (next) => editor(item.key, next), item.description)}
    {/each}
  </section>

  <section>
    <h3 class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
      {i18n.t('common.preview')}
    </h3>
    {#each previews as item (item.key)}
      {@render toggle(item.title, Boolean(previewValues[item.key]), (next) => preview(item.key, next), item.description)}
    {/each}

    {#if previewValues.codeBlockCollapse}
      <SettingRow title={i18n.t('settings.code_block_collapse_after')}>
        <Slider
          label={i18n.t('settings.code_block_collapse_after')}
          class="w-[200px]"
          value={previewValues.codeBlockCollapseLines}
          min={8}
          max={100}
          step={1}
          onChange={(lines) => preview('codeBlockCollapseLines', lines)}
          suffix={i18n.t('settings.lines')}
        />
      </SettingRow>
    {/if}

    {@render toggle('settings.show_outline_by_default', Boolean(previewValues.showToc), (next) => preview('showToc', next))}
  </section>

  <section>
    <SettingRow
      title={i18n.t('settings.autosave_delay')}
      description={i18n.t('settings.delay_before_uploading_after_you_stop_typing_shorter_makes_more_requests')}
    >
      <Slider
        label={i18n.t('settings.autosave_delay')}
        class="w-[200px]"
        value={editorValues.autoSaveDelay}
        min={200}
        max={3000}
        step={100}
        onChange={(autoSaveDelay) => editor('autoSaveDelay', autoSaveDelay)}
        suffix="ms"
      />
    </SettingRow>

    <SettingRow title={i18n.t('settings.indent_width')}>
      <Segmented
        label={i18n.t('settings.indent_width')}
        value={String(editorValues.tabSize)}
        onChange={(value) => editor('tabSize', Number(value) as Editor['tabSize'])}
        options={[
          { value: '2', label: '2' },
          { value: '4', label: '4' },
        ]}
      />
    </SettingRow>
  </section>
</div>
