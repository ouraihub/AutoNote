import { ZH_CN_MESSAGES } from '@shared/locales/zh-CN'
import { fireEvent, waitFor, within } from '@testing-library/svelte'
import { afterEach, expect, test, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { undo } from '@codemirror/commands'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { Note, PatchNoteBody } from '@shared/types'
import type { BackendSession } from '@shared/backend-types'
import type { PrefValue } from '../../platform/prefs'
import { ChangeFeedEmitter, type Backend } from '../../backend'
import { mountApp, type AppDeps, type AppHandle } from '../../root'
import { bindSyncScroll, buildScrollCurve, previewTopForLine, sourceLineForPreviewTop } from './sync-scroll'
import { bindReadingPosition, readingPositionKey, parseReadingPosition } from './reading-position'
import { CoalescingPrefsWriter } from '../../state/prefs-writer'

const handles: AppHandle[] = []
afterEach(async () => { vi.useRealTimers(); for (const handle of handles.splice(0)) await handle.destroy(); document.body.replaceChildren() })

function fixture() {
  const records: Record<string, Note> = {}
  for (const [id, title] of [['00000000000000000000000001', 'First note'], ['00000000000000000000000002', 'Second note']]) {
    records[id!] = { id: id!, title: title!, content: `${title}\n\n- [ ] task`, excerpt: '', folderId: null, tags: [], isPinned: false, isStarred: false, isArchived: false, wordCount: 3, charCount: 20, rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null }
  }
  const stored = new Map<string, PrefValue>()
  const session = { user: { id: 'alice', login: 'alice', username: 'alice', name: 'Alice', avatarUrl: '', role: 'owner', createdAt: 1 }, site: { name: 'Notebook', initialized: true, registrationOpen: false, r2Enabled: false, kvEnabled: false, attachmentStorage: 'local', realtimeEnabled: false, version: '1' }, settings: DEFAULT_SETTINGS } satisfies BackendSession
  const patch = vi.fn(async (id: string, body: PatchNoteBody, options: { writeId: string }) => {
    records[id] = { ...records[id]!, ...body, rev: records[id]!.rev + 1 }
    return { queued: false as const, note: { ...records[id]! }, writeId: options.writeId }
  })
  const backend = {
    kind: 'desktop', capabilities: { accounts: false, totp: false, share: false, remoteBackup: false, semanticSearch: false, mcp: null, realtime: false, remoteSync: false, updateCheck: false },
    session: { load: async () => session, logout: async () => {} },
    settings: { get: async () => DEFAULT_SETTINGS, save: async () => DEFAULT_SETTINGS },
    files: { resolveUrl: (url: string) => url },
    notes: { list: async () => ({ notes: Object.values(records).map((note) => { const summary = { ...note }; delete (summary as Partial<Note>).content; return summary }), nextCursor: null }), snapshot: async () => ({ notes: Object.values(records), folders: [], tags: [], deletions: [], cursor: 1, full: true, facetsFull: true, hasMore: false, nextKey: null, settingsChanged: false, profileChanged: false, siteChanged: false, serverTime: 1 }), get: async (id: string) => ({ ...records[id]! }), patch, flush: async () => ({ pending: 0, failed: 0 }), backlinks: async () => [] },
    changes: new ChangeFeedEmitter(), dispose: async () => {},
  } as unknown as Backend
  const deps: AppDeps = { backend, prefs: { load: async key => stored.get(key), save: async (key, value) => { stored.set(key, value) }, remove: async key => { stored.delete(key) } }, logger: { debug() {}, info() {}, warn() {}, error() {} }, notifier: { toast() {}, confirm: async () => false }, clock: { now: () => 1 }, extensions: { settingsSections: [], aboutPanels: [] } }
  return { deps, records, patch }
}

test('two panes keep independent bodies and undo history across all layouts', async () => {
  const { deps, records, patch } = fixture()
  const target = document.createElement('div')
  document.body.append(target)
  const app = mountApp(target, deps)
  handles.push(app)
  await waitFor(() => expect(within(target).getByRole('option', { name: 'First note' })).toBeTruthy())
  await fireEvent.click(within(target).getByRole('option', { name: 'First note' }))
  await fireEvent.click(within(target).getByRole('option', { name: 'Second note' }), { shiftKey: true })
  await waitFor(() => expect(target.querySelectorAll('.cm-editor')).toHaveLength(2))
  const primary = target.querySelector<HTMLElement>('[data-workspace-pane="primary"]')!
  const secondary = target.querySelector<HTMLElement>('[data-workspace-pane="secondary"]')!
  const first = EditorView.findFromDOM(primary.querySelector('.cm-editor')!)!
  const second = EditorView.findFromDOM(secondary.querySelector('.cm-editor')!)!
  first.dispatch({ changes: { from: first.state.doc.length, insert: '\nleft edit' }, userEvent: 'input.type' })
  second.dispatch({ changes: { from: second.state.doc.length, insert: '\nright edit' }, userEvent: 'input.type' })
  await fireEvent.click(within(primary).getByRole('radio', { name: ZH_CN_MESSAGES['workspace.split_view'] }))
  await fireEvent.click(within(primary).getByRole('radio', { name: ZH_CN_MESSAGES['workspace.reading_mode'] }))
  await fireEvent.click(within(primary).getByRole('radio', { name: ZH_CN_MESSAGES['workspace.live_preview'] }))
  expect(EditorView.findFromDOM(primary.querySelector('.cm-editor')!)).toBe(first)
  expect(EditorView.findFromDOM(secondary.querySelector('.cm-editor')!)).toBe(second)
  expect(undo(first)).toBe(true)
  await app.flush()
  expect(records['00000000000000000000000001']!.content).not.toContain('left edit')
  expect(records['00000000000000000000000002']!.content).toContain('right edit')
  expect(patch.mock.calls.some(([id]) => id === '00000000000000000000000001')).toBe(true)
  expect(patch.mock.calls.some(([id]) => id === '00000000000000000000000002')).toBe(true)
})

test('confirming an IME candidate keeps title focus and persists the committed Chinese title', async () => {
  const { deps, records } = fixture()
  const target = document.createElement('div')
  document.body.append(target)
  const app = mountApp(target, deps)
  handles.push(app)
  await waitFor(() => expect(within(target).getByRole('option', { name: 'First note' })).toBeTruthy())
  await fireEvent.click(within(target).getByRole('option', { name: 'First note' }))
  const title = within(target).getByRole('textbox', { name: ZH_CN_MESSAGES['workspace.note_title'] })
  title.focus()
  await fireEvent.compositionStart(title)
  await fireEvent.input(title, { target: { value: 'zhong' }, isComposing: true })
  await fireEvent.keyDown(title, { key: 'Enter', isComposing: true, keyCode: 229 })
  expect(document.activeElement).toBe(title)
  await fireEvent.compositionEnd(title, { data: '中文' })
  await fireEvent.input(title, { target: { value: '中文标题' } })
  await fireEvent.keyDown(title, { key: 'Enter' })
  expect(document.activeElement).not.toBe(title)
  await app.flush()
  expect(records['00000000000000000000000001']?.title).toBe('中文标题')
})

test('source curves map nonuniform blocks and only the user driver scrolls the other side', async () => {
  vi.useFakeTimers()
  const curve = buildScrollCurve([{ line: 2, top: 800 }, { line: 8, top: 900 }], 10, 0, 1000)
  expect(previewTopForLine(curve, 2)).toBe(800)
  expect(sourceLineForPreviewTop(curve, 850)).toBe(5)
  const editor = document.createElement('div'), preview = document.createElement('div')
  preview.innerHTML = '<article data-preview-content><p data-line="2">Tall block</p></article>'
  for (const element of [editor, preview]) Object.defineProperties(element, { clientHeight: { value: 100 }, scrollHeight: { value: 1100 } })
  const view = { scrollDOM: editor, state: { doc: { lines: 10 } } } as unknown as EditorView
  const dispose = bindSyncScroll(view, preview)
  try {
    editor.scrollTop = 1000
    editor.dispatchEvent(new WheelEvent('wheel'))
    editor.dispatchEvent(new Event('scroll'))
    await vi.advanceTimersByTimeAsync(20)
    expect(preview.scrollTop).toBe(1000)
    preview.scrollTop = 0
    preview.dispatchEvent(new Event('scroll'))
    await vi.advanceTimersByTimeAsync(20)
    expect(editor.scrollTop).toBe(1000)
    preview.dispatchEvent(new WheelEvent('wheel'))
    preview.dispatchEvent(new Event('scroll'))
    await vi.advanceTimersByTimeAsync(20)
    expect(editor.scrollTop).toBe(0)
  } finally { dispose() }
})

test('reading prefs contain only source position, survive reopen and cannot cross accounts', async () => {
  vi.useFakeTimers()
  const stored = new Map<string, PrefValue>()
  const prefs = { load: async (key: string) => stored.get(key), save: async (key: string, value: PrefValue) => { stored.set(key, value) }, remove: async (key: string) => { stored.delete(key) } }
  const writer = new CoalescingPrefsWriter(prefs.save)
  const callbacks = new Set<() => Promise<void>>()
  const scroller = document.createElement('div')
  scroller.innerHTML = '<article data-preview-content><p data-line="1">a</p><p data-line="5">b</p></article>'
  Object.defineProperties(scroller, { clientHeight: { value: 100 }, scrollHeight: { value: 1100 } })
  scroller.getBoundingClientRect = () => ({ top: 0 } as DOMRect)
  for (const [index, element] of [...scroller.querySelectorAll<HTMLElement>('p')].entries())
    element.getBoundingClientRect = () => ({ top: index * 400 - scroller.scrollTop } as DOMRect)
  const options = { scroller, lineCount: () => 10, key: readingPositionKey('alice', 'one'), prefs, writer, onError: (error: unknown) => { throw error }, registerFlush: (callback: () => Promise<void>) => { callbacks.add(callback); return () => { callbacks.delete(callback) } } }
  let dispose = bindReadingPosition(options)
  await vi.advanceTimersByTimeAsync(50)
  scroller.scrollTop = 600
  for (const flush of callbacks) await flush()
  const position = stored.get(options.key)
  expect(parseReadingPosition(position)).toBeTruthy()
  expect(Object.keys(position as object).sort()).toEqual(['line', 'offset'])
  dispose()
  scroller.scrollTop = 0
  dispose = bindReadingPosition(options)
  await vi.advanceTimersByTimeAsync(50)
  expect(scroller.scrollTop).toBe(600)
  dispose()
  scroller.scrollTop = 0
  dispose = bindReadingPosition({ ...options, key: readingPositionKey('bob', 'one') })
  await vi.advanceTimersByTimeAsync(50)
  expect(scroller.scrollTop).toBe(0)
  dispose()
  expect(parseReadingPosition({ line: -1, offset: 1 })).toBeNull()
})
