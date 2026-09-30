<script lang="ts">
  import { Compartment, EditorState, type Extension } from '@codemirror/state'
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
  import { indentUnit } from '@codemirror/language'
  import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
  import { EditorView, keymap, lineNumbers, placeholder as placeholderExtension } from '@codemirror/view'
  import type { EditorSettings } from '@shared/types'
  import { externalValueAnnotation } from './transactions'

  interface Props {
    noteId: string
    value: string
    settings: EditorSettings
    placeholder?: string
    onChange(value: string): void
    onViewReady?(view: EditorView | null): void
  }

  let { noteId, value, settings, placeholder = '', onChange, onViewReady }: Props = $props()
  let host = $state<HTMLDivElement>()
  let view: EditorView | null = null
  const current: {
    value: string
    settings: EditorSettings
    placeholder: string
    onChange: (value: string) => void
    onViewReady: ((view: EditorView | null) => void) | undefined
  } = {
    value: '',
    settings: {
      fontSize: 14,
      fontFamily: 'mono',
      lineNumbers: false,
      typewriter: false,
      focusMode: false,
      spellcheck: false,
      showToolbar: false,
      tabSize: 2,
      autoSaveDelay: 1000,
    },
    placeholder: '',
    onChange: () => {},
    onViewReady: undefined,
  }
  const lineNumberCompartment = new Compartment()
  const tabSizeCompartment = new Compartment()
  const placeholderCompartment = new Compartment()

  $effect(() => {
    current.value = value
    current.settings = settings
    current.placeholder = placeholder
    current.onChange = onChange
    current.onViewReady = onViewReady
  })

  $effect(() => {
    if (!host) return
    const nextView = new EditorView({
      parent: host,
      state: EditorState.create({ doc: current.value, extensions: editorExtensions() }),
    })
    view = nextView
    nextView.contentDOM.spellcheck = current.settings.spellcheck
    current.onViewReady?.(nextView)
    return () => {
      current.onViewReady?.(null)
      nextView.destroy()
      if (view === nextView) view = null
    }
  })

  $effect(() => {
    if (!view) return
    const document = view.state.doc.toString()
    if (document === value) return
    view.dispatch({
      changes: { from: 0, to: document.length, insert: value },
      selection: { anchor: Math.min(view.state.selection.main.anchor, value.length) },
      annotations: externalValueAnnotation.of(true),
    })
  })

  $effect(() => {
    if (!view) return
    view.dispatch({
      effects: [
        lineNumberCompartment.reconfigure(settings.lineNumbers ? lineNumbers() : []),
        tabSizeCompartment.reconfigure(indentUnit.of(' '.repeat(settings.tabSize))),
        placeholderCompartment.reconfigure(placeholderExtension(placeholder)),
      ],
    })
    view.contentDOM.spellcheck = settings.spellcheck
  })

  function editorExtensions(): Extension[] {
    return [
      history(),
      markdown({ base: markdownLanguage, addKeymap: false }),
      EditorView.lineWrapping,
      lineNumberCompartment.of(current.settings.lineNumbers ? lineNumbers() : []),
      tabSizeCompartment.of(indentUnit.of(' '.repeat(current.settings.tabSize))),
      placeholderCompartment.of(placeholderExtension(current.placeholder)),
      keymap.of([...historyKeymap, ...defaultKeymap]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || update.transactions.some((transaction) => transaction.annotation(externalValueAnnotation))) return
        current.onChange(update.state.doc.toString())
      }),
    ]
  }
</script>

<div class="ink-editor" data-note-id={noteId} bind:this={host}></div>
