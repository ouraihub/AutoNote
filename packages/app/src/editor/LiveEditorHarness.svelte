<script lang="ts">
  import type { EditorView } from '@codemirror/view'
  import type { EditorSettings } from '@shared/types'
  import CodeEditor from './CodeEditor.svelte'
  import { createEditorServices } from './testing'

  let { onView }: { onView(view: EditorView | null): void } = $props()
  const services = createEditorServices()
  const settings: EditorSettings = { fontSize: 14, fontFamily: 'mono', lineNumbers: false, typewriter: false, focusMode: false, spellcheck: false, showToolbar: false, tabSize: 2, autoSaveDelay: 1000 }
  let tick = $state(0)
  const liveServices = {
    title: () => '',
    prepare: () => () => {},
    revision: () => {
      void tick
      return 'same'
    },
  }
</script>

<CodeEditor noteId="n" value="hello" {settings} {services} live {liveServices} onChange={() => {}} onViewReady={onView} />
<button type="button" onclick={() => tick++}>Touch settings</button>
