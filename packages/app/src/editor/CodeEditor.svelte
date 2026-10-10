<script lang="ts">
  import { untrack } from 'svelte'
  import { Compartment, EditorState, type Extension, type Text } from '@codemirror/state'
  import { acceptCompletion, autocompletion } from '@codemirror/autocomplete'
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
  import { indentUnit } from '@codemirror/language'
  import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
  import { EditorView, keymap, lineNumbers, placeholder as placeholderExtension } from '@codemirror/view'
  import type { EditorSettings } from '@shared/types'
  import { codeFenceSource, tagSource, wikiLinkSource, type CompletionLabels } from './completion'
  import { pasteExtension } from './paste'
  import type { EditorServices } from './services'
  import { externalValueAnnotation } from './transactions'
  import { commandLabels, completeCodeFenceOnEnter, smartEnter, tableTab, setHeading, toggleBold, toggleItalic, toggleInlineCode, toggleStrikethrough, toggleHighlight, toggleQuote, toggleBulletList, toggleOrderedList, toggleTaskList, toggleTaskDone } from './commands'
  import { focusModePlugin, markdownDecorations, setFocusMode, typewriterPlugin } from './decorations'
  import { livePreview, type LivePreviewServices } from './live-preview'

  interface Props {
    noteId: string
    value: string
    settings: EditorSettings
    services: EditorServices
    placeholder?: string
    live?: boolean
    liveServices?: LivePreviewServices
    onChange(value: string): void
    onViewReady?(view: EditorView | null): void
    onSelectionChange?(selection: { from: number; to: number; docLength: number; text: string; doc: Text }): void
  }

  let { noteId, value, settings, services, placeholder = '', live = false, liveServices: liveRenderer, onChange, onViewReady, onSelectionChange }: Props = $props()
  let host = $state<HTMLDivElement>()
  let view = $state.raw<EditorView | null>(null)
  const current: {
    noteId: string
    generation: number
    value: string
    settings: EditorSettings
    services: EditorServices | null
    placeholder: string
    onChange: (value: string) => void
    onViewReady: ((view: EditorView | null) => void) | undefined
    onSelectionChange: ((selection: { from: number; to: number; docLength: number; text: string; doc: Text }) => void) | undefined
  } = {
    noteId: '',
    generation: 0,
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
    services: null,
    placeholder: '',
    onChange: () => {},
    onViewReady: undefined,
    onSelectionChange: undefined,
  }
  const lineNumberCompartment = new Compartment()
  const tabSizeCompartment = new Compartment()
  const placeholderCompartment = new Compartment()
  const liveCompartment = new Compartment()

  $effect(() => {
    if (current.noteId !== noteId) {
      current.noteId = noteId
      current.generation += 1
    }
    current.value = value
    current.settings = settings
    current.services = services
    current.placeholder = placeholder
    current.onChange = onChange
    current.onViewReady = onViewReady
    current.onSelectionChange = onSelectionChange
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

  $effect(() => {
    if (!view) return
    const renderer = live && liveRenderer ? liveRenderer : null
    renderer?.revision?.()
    untrack(() => view?.dispatch({ effects: liveCompartment.reconfigure(renderer ? livePreview(renderer) : []) }))
  })

  $effect(() => {
    if (!view) return
    view.dispatch({ effects: setFocusMode.of(settings.focusMode) })
  })

  function liveServices(): EditorServices {
    if (!current.services) throw new Error('CodeEditor services are read before props were synchronized')
    return current.services
  }

  function editorExtensions(): Extension[] {
    const labels: CompletionLabels = {
      createNote: () => liveServices().t('editor.create_new_note'),
      tagCount: (count) => liveServices().t('common.value0_notes', { value0: count }),
    }
    return [
      history(),
      commandLabels.of((key) => liveServices().t(key)),
      markdownDecorations,
      focusModePlugin,
      typewriterPlugin,
      liveCompartment.of([]),
      markdown({ base: markdownLanguage, addKeymap: false, pasteURLAsLink: false }),
      EditorView.lineWrapping,
      lineNumberCompartment.of(current.settings.lineNumbers ? lineNumbers() : []),
      tabSizeCompartment.of(indentUnit.of(' '.repeat(current.settings.tabSize))),
      placeholderCompartment.of(placeholderExtension(current.placeholder)),
      autocompletion({
        override: [
          wikiLinkSource(() => liveServices().completion, labels),
          tagSource(() => liveServices().completion, labels),
          codeFenceSource,
        ],
        activateOnTyping: true,
        closeOnBlur: true,
        maxRenderedOptions: 24,
        icons: false,
      }),
      pasteExtension({
        attachments: () => liveServices().attachments,
        target: () => ({ noteId: current.noteId, generation: current.generation }),
        uploadingLabel: (fileName) => liveServices().t('editor.uploading_value0', { value0: fileName }),
        uploadFailedLabel: (fileName) => liveServices().t('editor.upload_failed_value0', { value0: fileName }),
      }),
      keymap.of([
        { key: 'Enter', run: (target) => completeCodeFenceOnEnter(target) || smartEnter(target) },
        { key: 'Tab', run: (target) => acceptCompletion(target) || tableTab(target) },
        { key: 'Mod-b', run: toggleBold }, { key: 'Mod-i', run: toggleItalic },
        { key: 'Mod-e', run: toggleInlineCode }, { key: 'Mod-Shift-x', run: toggleStrikethrough },
        { key: 'Mod-Shift-h', run: toggleHighlight }, { key: 'Mod-Shift-.', run: toggleQuote },
        { key: 'Mod-Shift-8', run: toggleBulletList }, { key: 'Mod-Shift-7', run: toggleOrderedList },
        { key: 'Mod-Shift-9', run: toggleTaskList }, { key: 'Mod-Shift-Enter', run: toggleTaskDone },
        ...[1, 2, 3, 4, 5, 6].map((level) => ({ key: `Mod-${level}`, run: setHeading(level) })),
        ...historyKeymap, ...defaultKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(externalValueAnnotation))) {
          current.onChange(update.state.doc.toString())
        }
        if (update.selectionSet || update.docChanged) {
          const range = update.state.selection.main
          current.onSelectionChange?.({
            from: range.from,
            to: range.to,
            docLength: update.state.doc.length,
            text: update.state.sliceDoc(range.from, range.to),
            doc: update.state.doc,
          })
        }
      }),
    ]
  }
</script>

<div class="ink-editor" data-note-id={noteId} data-live={live} data-family={settings.fontFamily} data-focus-mode={settings.focusMode} data-typewriter={settings.typewriter} style:--editor-size={`${settings.fontSize}px`} bind:this={host}></div>
