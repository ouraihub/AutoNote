<script lang="ts">
  import type { EditorSettings as Editor, PreviewSettings as Preview } from '@shared/types'
  import type { MessageKey } from '@shared/locales/en-US'
  import { getI18n, getSettings } from '@app/root/context'
  import { messageKeyForError } from '@app/i18n/errors'

  const i18n = getI18n()
  const settings = getSettings()
  const editorSwitches: { key: 'lineNumbers' | 'showToolbar' | 'spellcheck' | 'typewriter' | 'focusMode'; label: MessageKey }[] = [
    { key: 'lineNumbers', label: 'settings.show_line_numbers' },
    { key: 'showToolbar', label: 'settings.show_toolbar' },
    { key: 'spellcheck', label: 'settings.spellcheck' },
    { key: 'typewriter', label: 'settings.typewriter_mode' },
    { key: 'focusMode', label: 'settings.focus_mode' },
  ]
  const previewSwitches: { key: 'syncScroll' | 'math' | 'mermaid' | 'codeBlockCollapse' | 'showToc'; label: MessageKey }[] = [
    { key: 'syncScroll', label: 'settings.scroll_sync' },
    { key: 'math', label: 'settings.math' },
    { key: 'mermaid', label: 'settings.diagram' },
    { key: 'codeBlockCollapse', label: 'settings.collapse_long_code_blocks' },
    { key: 'showToc', label: 'settings.show_outline_by_default' },
  ]
  const editorSliders = [
    { key: 'fontSize', label: 'settings.editor_font_size', min: 12, max: 22, step: 1 },
    { key: 'autoSaveDelay', label: 'settings.autosave_delay', min: 200, max: 3000, step: 100 },
  ] as const
  function editor<K extends keyof Editor>(key: K, value: Editor[K]): void {
    settings.update({ editor: { [key]: value } })
  }
  function preview<K extends keyof Preview>(key: K, value: Preview[K]): void {
    settings.update({ preview: { [key]: value } })
  }
</script>

<div class="space-y-4">
  {#if settings.error}<p role="alert">{i18n.t(messageKeyForError(settings.error))}</p>{/if}
  <label class="flex items-center gap-2 text-sm">{i18n.t('settings.editor_font')}
    <select class="rounded border p-1" value={settings.current.editor.fontFamily}
      onchange={(event) => editor('fontFamily', event.currentTarget.value as Editor['fontFamily'])}>
      <option value="mono">{i18n.t('settings.monospace')}</option>
      <option value="sans">{i18n.t('common.sans_serif')}</option>
    </select>
  </label>
  {#each editorSliders as slider (slider.key)}
    <label class="flex items-center gap-2 text-sm">{i18n.t(slider.label)}
      <input type="range" min={slider.min} max={slider.max} step={slider.step} value={settings.current.editor[slider.key]}
        oninput={(event) => editor(slider.key, Number(event.currentTarget.value))} />
      <output>{settings.current.editor[slider.key]}</output>
    </label>
  {/each}
  <label class="flex items-center gap-2 text-sm">{i18n.t('settings.indent_width')}
    <select class="rounded border p-1" value={settings.current.editor.tabSize}
      onchange={(event) => editor('tabSize', Number(event.currentTarget.value))}>
      <option value="2">2</option><option value="4">4</option>
    </select>
  </label>
  {#each editorSwitches as item (item.key)}
    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={Boolean(settings.current.editor[item.key])}
        onchange={(event) => editor(item.key, event.currentTarget.checked)} />{i18n.t(item.label)}
    </label>
  {/each}
  <h3 class="font-medium">{i18n.t('common.preview')}</h3>
  {#each previewSwitches as item (item.key)}
    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={Boolean(settings.current.preview[item.key])}
        onchange={(event) => preview(item.key, event.currentTarget.checked)} />{i18n.t(item.label)}
    </label>
  {/each}
  {#if settings.current.preview.codeBlockCollapse}
    <label class="flex items-center gap-2 text-sm">{i18n.t('settings.code_block_collapse_after')}
      <input type="range" min="8" max="100" step="1" value={settings.current.preview.codeBlockCollapseLines}
        oninput={(event) => preview('codeBlockCollapseLines', Number(event.currentTarget.value))} />
      <output>{settings.current.preview.codeBlockCollapseLines}</output>
    </label>
  {/if}
</div>
