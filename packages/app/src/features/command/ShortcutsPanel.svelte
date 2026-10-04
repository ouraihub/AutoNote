<script lang="ts">
  import type { MessageKey } from '@shared/locales/en-US'
  import * as Dialog from '@app/components/ui/dialog'
  import type { Hotkeys } from '@app/lib/hotkeys'
  import { hotkeyText, prettyCombo } from '@app/lib/hotkeys'

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
    ['mod+z', 'common.undo'],
    ['mod+shift+z', 'command.redo'],
    ['mod+f', 'command.find_and_replace_in_this_note'],
  ]
  const groups = $derived.by(() => {
    const grouped: Record<string, { combo: string; description: string }[]> = {}
    for (const hotkey of hotkeys.listHotkeys()) {
      const group = hotkeyText(hotkey.group)
      ;(grouped[group] ??= []).push({ combo: hotkey.combo, description: hotkeyText(hotkey.description) })
    }
    const edit = i18n.t('common.edit')
    ;(grouped[edit] ??= []).push(
      ...editorShortcuts.map(([combo, key]) => ({ combo, description: i18n.t(key) })),
    )
    return Object.entries(grouped)
  })
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Content class="max-w-3xl" aria-describedby="shortcuts-description">
    <Dialog.Header>
      <Dialog.Title>{i18n.t('command.keyboard_shortcuts_021cf9')}</Dialog.Title>
      <Dialog.Description id="shortcuts-description"
        >{i18n.t('command.use_nearly_every_action_without_touching_the_mouse')}</Dialog.Description
      >
    </Dialog.Header>
    <div class="grid max-h-[62vh] grid-cols-1 gap-5 overflow-y-auto md:grid-cols-2">
      {#each groups as [group, items] (group)}
        <section aria-label={group}>
          <h3 class="mb-2 text-xs font-semibold text-muted-foreground">{group}</h3>
          <ul class="space-y-1">
            {#each items as item, index (index)}
              <li class="flex min-h-9 items-center justify-between gap-4 rounded-md px-2 py-1 hover:bg-muted">
                <span class="min-w-0 text-sm text-muted-foreground">{item.description}</span>
                <kbd class="shrink-0 text-xs text-muted-foreground">{prettyCombo(item.combo).join(' + ')}</kbd>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
      <section>
        <h3 class="mb-2 text-xs font-semibold text-muted-foreground">{i18n.t('command.triggered_as_you_type')}</h3>
        <ul class="space-y-1 text-sm text-muted-foreground">
          <li><code>[[ ]]</code>: {i18n.t('command.link_to_another_note_autocomplete')}</li>
          <li><code>#</code>: {i18n.t('command.insert_tag_autocomplete')}</li>
          <li><kbd>Tab</kbd>: {i18n.t('command.jump_to_the_next_cell_in_the_table')}</li>
        </ul>
      </section>
    </div>
  </Dialog.Content>
</Dialog.Root>
