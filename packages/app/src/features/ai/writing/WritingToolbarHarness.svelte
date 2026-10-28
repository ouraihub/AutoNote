<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { EditorSelection, EditorState } from '@codemirror/state'
  import { EditorView } from '@codemirror/view'
  import type { Backend } from '@app/backend'
  import type { I18nState } from '@app/i18n/runtime.svelte'
  import { setBackend, setI18n, setLogger } from '@app/root/context'
  import WritingToolbar from './WritingToolbar.svelte'

  let { backend, i18n }: { backend: Backend; i18n: I18nState } = $props()
  untrack(() => {
    setBackend(backend)
    setI18n(i18n)
    setLogger({ debug() {}, info() {}, warn() {}, error() {} })
  })
  let parent: HTMLDivElement
  let view = $state.raw<EditorView | null>(null)
  onMount(() => {
    const editor = new EditorView({
      parent,
      state: EditorState.create({ doc: 'Selected text', selection: EditorSelection.single(0, 13) }),
    })
    view = editor
    return () => editor.destroy()
  })
</script>

<div bind:this={parent}></div>
{#if view}
  <WritingToolbar
    {view}
    selection={{ from: 0, to: 13, docLength: 13, text: 'Selected text', doc: view.state.doc }}
    noteId="note-one"
    noteTitle="A note"
    noteRev={1}
    editorGeneration={1}
    onReplace={() => true}
    onInsert={() => true}
  />
{/if}
