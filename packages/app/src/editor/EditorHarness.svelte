<script lang="ts">
  import { undo } from '@codemirror/commands'
  import type { EditorView } from '@codemirror/view'
  import type { EditorSettings } from '@shared/types'
  import CodeEditor from './CodeEditor.svelte'
  import { createEditorServices } from './testing'

  const services = createEditorServices()

  const settings: EditorSettings = {
    fontSize: 14,
    fontFamily: 'mono',
    lineNumbers: true,
    typewriter: false,
    focusMode: false,
    spellcheck: false,
    showToolbar: true,
    tabSize: 2,
    autoSaveDelay: 1000,
  }

  let first = $state('first')
  let second = $state('second')
  let firstChanges = $state(0)
  let secondChanges = $state(0)
  let firstView = $state<EditorView | null>(null)
  let secondView = $state<EditorView | null>(null)

  function append(view: EditorView | null, value: string): void {
    if (!view) return
    view.dispatch({
      changes: { from: view.state.doc.length, insert: value },
      userEvent: 'input.type',
    })
  }
</script>

<div data-testid="first-editor">
  <CodeEditor
    noteId="first"
    value={first}
    {settings}
    {services}
    onChange={(value) => {
      first = value
      firstChanges += 1
    }}
    onViewReady={(view) => (firstView = view)}
  />
</div>
<div data-testid="second-editor">
  <CodeEditor
    noteId="second"
    value={second}
    {settings}
    {services}
    onChange={(value) => {
      second = value
      secondChanges += 1
    }}
    onViewReady={(view) => (secondView = view)}
  />
</div>
<button type="button" onclick={() => append(firstView, ' A')}>Edit first</button
>
<button type="button" onclick={() => append(secondView, ' B')}
  >Edit second</button
>
<button
  type="button"
  onclick={() => {
    if (firstView) undo(firstView)
  }}>Undo first</button
>
<p data-testid="first-changes">{firstChanges}</p>
<p data-testid="second-changes">{secondChanges}</p>
