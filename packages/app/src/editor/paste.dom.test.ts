import { render } from '@testing-library/svelte'
import type { EditorView } from '@codemirror/view'
import type { EditorSettings } from '@shared/types'
import { describe, expect, test, vi } from 'vitest'
import CodeEditor from './CodeEditor.svelte'
import { insertPickedFiles } from './actions'
import { htmlToMarkdown, uploadedFileMarkdown, type AttachmentServices, type UploadedAttachment } from './paste'
import { createEditorServices } from './testing'

const settings: EditorSettings = {
  fontSize: 14,
  fontFamily: 'mono',
  lineNumbers: false,
  typewriter: false,
  focusMode: false,
  spellcheck: false,
  showToolbar: true,
  tabSize: 2,
  autoSaveDelay: 1000,
}

function mountEditor(attachments: Partial<AttachmentServices>, noteId = 'note-a', value = 'Body ') {
  let view: EditorView | null = null
  const changes: string[] = []
  const props = {
    noteId,
    value,
    settings,
    services: createEditorServices({ attachments }),
    onChange: (next: string) => changes.push(next),
    onViewReady: (next: EditorView | null) => (view = next),
  }
  const rendered = render(CodeEditor, { props })
  if (!view) throw new Error('editor view was not created')
  const editor: EditorView = view
  editor.dispatch({ selection: { anchor: editor.state.doc.length } })
  return { editor, changes, rerender: rendered.rerender, props }
}

function pasteEvent(data: { files?: File[]; types?: string[]; values?: Record<string, string> }): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files: data.files ?? [],
      types: data.types ?? Object.keys(data.values ?? {}),
      items: undefined,
      getData: (type: string) => data.values?.[type] ?? '',
    },
  })
  return event
}

const image = (name = 'photo.png') => new File(['png'], name, { type: 'image/png' })
const stored: UploadedAttachment = { id: '01HZXTESTATTACHMENT0000001', filename: 'photo.png', mime: 'image/png' }

describe('attachment paste', () => {
  test('uploads pasted files through the injected service and stores the logical file URL', async () => {
    const upload = vi.fn(async () => stored)
    const { editor } = mountEditor({ upload })

    const event = pasteEvent({ files: [image()] })
    editor.contentDOM.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(upload).toHaveBeenCalledWith(expect.any(File), 'note-a')
    await vi.waitFor(() =>
      expect(editor.state.doc.toString()).toBe('Body ![photo](</api/files/01HZXTESTATTACHMENT0000001>)'),
    )
  })

  test('hands a late result to the original note after the editor switched notes', async () => {
    const pending = Promise.withResolvers<UploadedAttachment>()
    const replaceDetached = vi.fn()
    const { editor, rerender, props } = mountEditor({ upload: () => pending.promise, replaceDetached })

    const insertion = insertPickedFiles(editor, [image()])
    const placeholder = editor.state.doc.toString().slice('Body '.length)
    expect(placeholder).toContain('Uploading photo.png')

    await rerender({ ...props, noteId: 'note-b', value: 'Second note' })
    pending.resolve(stored)
    await insertion

    expect(editor.state.doc.toString()).toBe('Second note')
    expect(replaceDetached).toHaveBeenCalledWith('note-a', placeholder, uploadedFileMarkdown(stored))
  })

  test('keeps text typed during a failed upload and leaves a failure marker in place of the placeholder', async () => {
    const pending = Promise.withResolvers<UploadedAttachment>()
    const uploadFailed = vi.fn()
    const { editor } = mountEditor({ upload: () => pending.promise, uploadFailed })

    const insertion = insertPickedFiles(editor, [image('scan.png')])
    editor.dispatch({ changes: { from: 0, insert: 'Typed. ' }, userEvent: 'input.type' })
    const error = new Error('offline')
    pending.reject(error)
    await insertion

    expect(uploadFailed).toHaveBeenCalledWith(expect.any(File), error)
    expect(editor.state.doc.toString()).toBe('Typed. Body <!-- Upload failed: scan.png -->')
  })

  test('preserves the original clipboard text when an attachment upload is cancelled', async () => {
    const pending = Promise.withResolvers<UploadedAttachment>()
    const uploadFailed = vi.fn()
    const { editor } = mountEditor({ upload: () => pending.promise, uploadFailed }, 'note-a', '')
    const event = pasteEvent({ files: [image()], values: { 'text/plain': 'Original pasted text' } })
    editor.contentDOM.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)

    pending.reject(new DOMException('Cancelled', 'AbortError'))
    await vi.waitFor(() => expect(editor.state.doc.toString()).toBe('Original pasted text'))
    expect(uploadFailed).toHaveBeenCalledOnce()
  })

  test('a failed upload after switching notes restores the original clipboard text only in its source note', async () => {
    const pending = Promise.withResolvers<UploadedAttachment>()
    const replaceDetached = vi.fn()
    const { editor, rerender, props } = mountEditor({ upload: () => pending.promise, replaceDetached })
    editor.contentDOM.dispatchEvent(pasteEvent({ files: [image()], values: { 'text/plain': 'Original pasted text' } }))
    const placeholder = editor.state.doc.toString().slice('Body '.length)
    await rerender({ ...props, noteId: 'note-b', value: 'Second note' })
    pending.reject(new DOMException('Cancelled', 'AbortError'))
    await vi.waitFor(() => expect(replaceDetached).toHaveBeenCalledWith('note-a', placeholder, 'Original pasted text'))
    expect(editor.state.doc.toString()).toBe('Second note')
  })

  test('wraps a selected label in a Markdown link when a URL is pasted over it', () => {
    const { editor } = mountEditor({}, 'note-a', 'read the [docs]')
    editor.dispatch({ selection: { anchor: 9, head: 15 } })

    const event = pasteEvent({ values: { 'text/plain': 'https://example.com/guide' } })
    editor.contentDOM.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(editor.state.doc.toString()).toBe('read the [\\[docs\\]](<https://example.com/guide>)')
  })

  test('converts pasted HTML to Markdown without executable content', () => {
    const { editor } = mountEditor({}, 'note-a', '')

    editor.contentDOM.dispatchEvent(
      pasteEvent({
        values: {
          'text/html':
            '<p onclick="alert(1)">Hi <b>there</b><img src="x" onerror="alert(1)"><script>alert(2)</script></p>',
          'text/plain': 'Hi there',
        },
      }),
    )

    expect(editor.state.doc.toString()).toBe('Hi **there**![](<x>)')
  })
})

describe('htmlToMarkdown', () => {
  test('drops scripts, handlers and unsafe link schemes', () => {
    const markdown = htmlToMarkdown(
      '<a href="javascript:alert(1)">bad</a> <a href="https://ok.test/?q=1">good</a>' +
        '<img src="data:image/png;base64,AAAA" alt="inline"><svg onload="alert(1)"><text>s</text></svg>' +
        '<style>p{}</style><iframe src="https://evil.test"></iframe>',
    )

    expect(markdown).toBe('bad [good](<https://ok.test/?q=1>)s')
    expect(markdown).not.toMatch(/javascript|alert|data:|iframe/)
  })

  test('keeps document structure: headings, lists, code, quotes and tables', () => {
    const markdown = htmlToMarkdown(
      '<h2>Plan</h2><ol start="3"><li>One<ul><li>Nested</li></ul></li><li>Two</li></ol>' +
        '<pre><code class="language-ts">const a = `x`\n</code></pre><blockquote><p>Quote</p></blockquote>' +
        '<table><tr><th>A</th><th>B|C</th></tr><tr><td>1</td><td>2</td></tr></table><p>Use <code>a`b</code></p>',
    )

    expect(markdown).toBe(
      [
        '## Plan',
        '',
        '3. One',
        '   - Nested',
        '4. Two',
        '',
        '```ts',
        'const a = `x`',
        '```',
        '',
        '> Quote',
        '',
        '| A | B\\|C |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        'Use ``a`b``',
      ].join('\n'),
    )
  })
})

describe('uploadedFileMarkdown', () => {
  test('embeds images without their extension and links other files with escaped labels', () => {
    expect(uploadedFileMarkdown(stored)).toBe('![photo](</api/files/01HZXTESTATTACHMENT0000001>)')
    expect(uploadedFileMarkdown({ id: 'f1', filename: 'notes [v2].pdf', mime: 'application/pdf' })).toBe(
      '[notes \\[v2\\].pdf](</api/files/f1>)',
    )
  })
})
