<script lang="ts">
  import type { EditorView } from '@codemirror/view'
  import type { StateCommand } from '@codemirror/state'
  import type { MessageKey } from '@shared/locales/en-US'
  import { Bold, Italic, Strikethrough, Code, List, ListOrdered, ListTodo, Quote, Link, Image, Braces, Table, Sigma, Minus, Heading, Highlighter, Network, Blocks } from '@lucide/svelte'
  import { Button, buttonVariants } from '../../components/ui/button'
  import * as Menu from '../../components/ui/dropdown-menu'
  import { getI18n } from '../../root/context'
  import * as commands from '../../editor/commands'

  let { view, onPickImage }: { view: EditorView | null; onPickImage: () => void } = $props()
  const i18n = getI18n()
  const tools = [
    { key: 'common.bold', icon: Bold, command: commands.toggleBold },
    { key: 'common.italic', icon: Italic, command: commands.toggleItalic },
    { key: 'common.strikethrough', icon: Strikethrough, command: commands.toggleStrikethrough },
    { key: 'common.inline_code', icon: Code, command: commands.toggleInlineCode },
    { key: 'common.unordered_list', icon: List, command: commands.toggleBulletList },
    { key: 'common.ordered_list', icon: ListOrdered, command: commands.toggleOrderedList },
    { key: 'common.task_list', icon: ListTodo, command: commands.toggleTaskList },
    { key: 'common.quote', icon: Quote, command: commands.toggleQuote },
    { key: 'workspace.link', icon: Link, command: commands.insertLink() },
    { key: 'workspace.code_block', icon: Braces, command: commands.insertCodeBlock },
    { key: 'workspace.table', icon: Table, command: commands.insertTable },
    { key: 'workspace.math', icon: Sigma, command: commands.insertText('$$\n\n$$\n', 3) },
    { key: 'workspace.divider', icon: Minus, command: commands.insertHorizontalRule },
  ] satisfies { key: MessageKey; icon: typeof Bold; command: StateCommand }[]
  const menus = [
    { key: 'workspace.title_level', icon: Heading, items: [1, 2, 3, 4, 5, 6].map(level => ({ key: 'workspace.heading_value0' as MessageKey, params: { value0: level }, command: commands.setHeading(level) })) },
    { key: 'workspace.more_inline_styles', icon: Highlighter, items: [
      { key: 'common.highlight', command: commands.toggleHighlight }, { key: 'workspace.inline_math', command: commands.toggleInlineMath },
    ] },
    { key: 'workspace.note_syntax', icon: Network, items: [
      { key: 'common.wiki_links', command: commands.toggleWikiLink }, { key: 'workspace.note_embed', command: commands.toggleNoteEmbed },
      { key: 'workspace.remote_image', command: commands.insertImage() }, { key: 'workspace.insert_tag', command: commands.insertTag },
      { key: 'workspace.block_id', command: commands.insertBlockId }, { key: 'workspace.block_reference', command: commands.toggleBlockReference },
      { key: 'workspace.footnote', command: commands.insertFootnote },
    ] },
    { key: 'workspace.more_blocks', icon: Blocks, items: [
      { key: 'workspace.mermaid_diagram', command: commands.insertMermaid }, { key: 'workspace.enhanced_code_block', command: commands.insertAdvancedCodeBlock },
      { key: 'workspace.callout', command: commands.insertCallout }, { key: 'workspace.details_block', command: commands.insertDetails },
      { key: 'common.tabs', command: commands.insertTabs }, { key: 'workspace.front_matter', command: commands.insertFrontMatter },
    ] },
  ] satisfies { key: MessageKey; icon: typeof Heading; items: { key: MessageKey; params?: { value0: number }; command: StateCommand }[] }[]
  function run(command: StateCommand): void {
    if (!view) return
    command(view)
    view.focus()
  }
</script>

<div class="editor-toolbar flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-2 py-1" role="toolbar" aria-label={i18n.t('workspace.layout')}>
  {#each tools as tool (tool.key)}
    <Button variant="ghost" size="icon-sm" disabled={!view} aria-label={i18n.t(tool.key)} title={i18n.t(tool.key)} onclick={() => run(tool.command)}><tool.icon /></Button>
  {/each}
  <Button variant="ghost" size="icon-sm" disabled={!view} aria-label={i18n.t('workspace.insert_image')} title={i18n.t('workspace.insert_image')} onclick={onPickImage}><Image /></Button>
  {#each menus as menu (menu.key)}
    <Menu.Root>
      <Menu.Trigger class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} disabled={!view} aria-label={i18n.t(menu.key)} title={i18n.t(menu.key)}><menu.icon /></Menu.Trigger>
      <Menu.Content><Menu.Group>
        {#each menu.items as item (item.key + String('params' in item ? item.params?.value0 : ''))}
          <Menu.Item onSelect={() => run(item.command)}>{i18n.t(item.key, 'params' in item ? item.params : undefined)}</Menu.Item>
        {/each}
      </Menu.Group></Menu.Content>
    </Menu.Root>
  {/each}
</div>
