<script lang="ts">
  import type { EditorView } from '@codemirror/view'
  import type { StateCommand } from '@codemirror/state'
  import type { MessageKey } from '@shared/locales/en-US'
  import { Bold, Italic, Strikethrough, Code, List, ListOrdered, ListTodo, Quote, Link2, Image, Braces, Table, Sigma, Minus, Heading, Highlighter, Network, Blocks, ChevronDown } from '@lucide/svelte'
  import IconButton from '../../components/primitives/IconButton.svelte'
  import * as Menu from '../../components/ui/dropdown-menu'
  import { getI18n } from '../../root/context'
  import * as commands from '../../editor/commands'

  let { view, onPickImage }: { view: EditorView | null; onPickImage: () => void } = $props()
  const i18n = getI18n()
  type Tool = { key: MessageKey; icon: typeof Bold; command?: StateCommand }
  type MenuDef = { key: MessageKey; icon: typeof Heading; items: { key: MessageKey; params?: { value0: number }; command: StateCommand }[] }
  const heading: MenuDef = { key: 'workspace.title_level', icon: Heading, items: [1, 2, 3, 4, 5, 6].map(level => ({ key: 'workspace.heading_value0' as MessageKey, params: { value0: level }, command: commands.setHeading(level) })) }
  const inline: MenuDef = { key: 'workspace.more_inline_styles', icon: Highlighter, items: [
    { key: 'common.highlight', command: commands.toggleHighlight }, { key: 'workspace.inline_math', command: commands.toggleInlineMath },
  ] }
  const note: MenuDef = { key: 'workspace.note_syntax', icon: Network, items: [
    { key: 'common.wiki_links', command: commands.toggleWikiLink }, { key: 'workspace.note_embed', command: commands.toggleNoteEmbed },
    { key: 'workspace.remote_image', command: commands.insertImage() }, { key: 'workspace.insert_tag', command: commands.insertTag },
    { key: 'workspace.block_id', command: commands.insertBlockId }, { key: 'workspace.block_reference', command: commands.toggleBlockReference },
    { key: 'workspace.footnote', command: commands.insertFootnote },
  ] }
  const blocks: MenuDef = { key: 'workspace.more_blocks', icon: Blocks, items: [
    { key: 'workspace.mermaid_diagram', command: commands.insertMermaid }, { key: 'workspace.enhanced_code_block', command: commands.insertAdvancedCodeBlock },
    { key: 'workspace.callout', command: commands.insertCallout }, { key: 'workspace.details_block', command: commands.insertDetails },
    { key: 'common.tabs', command: commands.insertTabs }, { key: 'workspace.front_matter', command: commands.insertFrontMatter },
  ] }
  const groups: (Tool | MenuDef)[][] = [
    [heading],
    [
      { key: 'common.bold', icon: Bold, command: commands.toggleBold },
      { key: 'common.italic', icon: Italic, command: commands.toggleItalic },
      { key: 'common.strikethrough', icon: Strikethrough, command: commands.toggleStrikethrough },
      { key: 'common.inline_code', icon: Code, command: commands.toggleInlineCode },
      inline,
    ],
    [
      { key: 'common.unordered_list', icon: List, command: commands.toggleBulletList },
      { key: 'common.ordered_list', icon: ListOrdered, command: commands.toggleOrderedList },
      { key: 'common.task_list', icon: ListTodo, command: commands.toggleTaskList },
      { key: 'common.quote', icon: Quote, command: commands.toggleQuote },
    ],
    [
      { key: 'workspace.link', icon: Link2, command: commands.insertLink() },
      { key: 'workspace.insert_image', icon: Image },
      note,
    ],
    [
      { key: 'workspace.code_block', icon: Braces, command: commands.insertCodeBlock },
      { key: 'workspace.table', icon: Table, command: commands.insertTable },
      { key: 'workspace.math', icon: Sigma, command: commands.insertText('$$\n\n$$\n', 3) },
      { key: 'workspace.divider', icon: Minus, command: commands.insertHorizontalRule },
      blocks,
    ],
  ]
  function run(command: StateCommand): void {
    if (!view) return
    command(view)
    view.focus()
  }
</script>

<div class="editor-toolbar flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[var(--border-subtle)] px-2 no-scrollbar" role="toolbar" aria-label={i18n.t('workspace.layout')}>
  {#each groups as group, index (index)}
    {#if index > 0}<span class="mx-1 h-4 w-px shrink-0 bg-[var(--border-subtle)]"></span>{/if}
    {#each group as entry (entry.key)}
      {@const label = i18n.t(entry.key as MessageKey)}
      {#if 'items' in entry}
        <Menu.Root>
          <Menu.Trigger class="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-[var(--r-md)] px-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-40" disabled={!view} aria-label={label} title={entry === heading ? i18n.t('workspace.title_748d7d') : label}>
            <entry.icon size={14} />
            <ChevronDown size={10} class="opacity-60" />
          </Menu.Trigger>
          <Menu.Content><Menu.Group>
            {#each entry.items as item (item.key + String(item.params?.value0 ?? ''))}
              <Menu.Item onSelect={() => run(item.command)}>{i18n.t(item.key as MessageKey, item.params)}</Menu.Item>
            {/each}
          </Menu.Group></Menu.Content>
        </Menu.Root>
      {:else}
        <IconButton {label} title={label} size="sm" class="size-9 md:size-7" disabled={!view} onclick={() => entry.command ? run(entry.command) : onPickImage()}>
          <entry.icon size={14} />
        </IconButton>
      {/if}
    {/each}
  {/each}
</div>
