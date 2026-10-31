<script lang="ts">
  import type { MessageKey } from '@shared/locales/en-US'
  import type { Hotkeys } from '@app/lib/hotkeys'
  import { hotkeyText } from '@app/lib/hotkeys'
  import Kbd from '@app/components/primitives/Kbd.svelte'
  import Modal from '@app/components/primitives/Modal.svelte'

  interface I18n {
    t(key: MessageKey): string
  }
  interface Props {
    open?: boolean
    hotkeys: Hotkeys
    i18n: I18n
    onOpenChange(open: boolean): void
  }
  let { open = true, hotkeys, i18n, onOpenChange }: Props = $props()

  const editorShortcuts: readonly [string, MessageKey][] = [
    ['mod+b', 'common.bold'],
    ['mod+i', 'common.italic'],
    ['mod+e', 'common.inline_code'],
    ['mod+shift+x', 'common.strikethrough'],
    ['mod+shift+h', 'common.highlight'],
    ['mod+1', 'command.heading_1_same_pattern_for_2_6'],
    ['mod+shift+8', 'common.unordered_list'],
    ['mod+shift+7', 'common.ordered_list'],
    ['mod+shift+9', 'common.task_list'],
    ['mod+shift+.', 'common.quote'],
    ['mod+shift+enter', 'command.check_uncheck_tasks'],
    ['alt+arrowup', 'command.move_line_up'],
    ['alt+arrowdown', 'command.move_line_down'],
    ['mod+shift+k', 'command.delete_line'],
    ['mod+f', 'command.find_and_replace_in_this_note'],
    ['mod+z', 'common.undo'],
    ['mod+shift+z', 'command.redo'],
  ]
  const inputHints: readonly [string[], MessageKey][] = [
    [['[', '['], 'command.link_to_another_note_autocomplete'],
    [['#'], 'command.insert_tag_autocomplete'],
    [['`', '`', '`'], 'command.code_block_language_autocomplete'],
    [
      ['↵'],
      'command.continue_lists_automatically_press_enter_on_an_empty_item_to_exit',
    ],
    [['Tab'], 'command.jump_to_the_next_cell_in_the_table'],
  ]
  const groups = $derived.by(() => {
    const grouped: Record<string, { combo: string; description: string }[]> = {}
    for (const hotkey of hotkeys.listHotkeys()) {
      const group = hotkeyText(hotkey.group)
      ;(grouped[group] ??= []).push({
        combo: hotkey.combo,
        description: hotkeyText(hotkey.description),
      })
    }
    const edit = i18n.t('common.edit')
    ;(grouped[edit] ??= []).push(
      ...editorShortcuts.map(([combo, key]) => ({
        combo,
        description: i18n.t(key),
      })),
    )
    return Object.entries(grouped)
  })
  const rowClass =
    'flex min-h-10 items-center justify-between gap-4 rounded-[var(--r-sm)] px-1.5 py-[5px] transition-colors hover:bg-[var(--bg-hover)] md:min-h-0'
  const textClass =
    'min-w-0 text-[12.5px] leading-snug text-[var(--text-secondary)] md:truncate'
  const headingClass =
    'mb-2 text-[10.5px] font-semibold tracking-[0.07em] text-[var(--text-quaternary)]'
</script>

<Modal
  {open}
  onClose={() => onOpenChange(false)}
  title={i18n.t('command.keyboard_shortcuts_021cf9')}
  description={i18n.t(
    'command.use_nearly_every_action_without_touching_the_mouse',
  )}
  width={720}
>
  <div
    class="grid grid-cols-1 gap-x-8 gap-y-5 pr-1 md:max-h-[62vh] md:grid-cols-2 md:overflow-y-auto"
  >
    {#each groups as [group, items] (group)}
      <section aria-label={group}>
        <h3 class={headingClass}>{group}</h3>
        <ul class="space-y-0.5">
          {#each items as item, index (`${item.combo}-${index}`)}
            <li class={rowClass}>
              <span class={textClass}>{item.description}</span>
              <Kbd combo={item.combo} />
            </li>
          {/each}
        </ul>
      </section>
    {/each}
    <section>
      <h3 class={headingClass}>{i18n.t('command.triggered_as_you_type')}</h3>
      <ul class="space-y-0.5">
        {#each inputHints as [keys, key], index (index)}
          <li class={rowClass}>
            <span class={textClass}>{i18n.t(key as MessageKey)}</span>
            <Kbd {keys} />
          </li>
        {/each}
      </ul>
    </section>
  </div>
</Modal>
