import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { GraphQuery, GraphResponse } from '@shared/types'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import GraphPanel from './GraphPanel.svelte'

const a = '0'.repeat(26),
  b = '1'.repeat(26)
const graph: GraphResponse = {
  nodes: [
    {
      id: a,
      title: 'Alpha',
      kind: 'note',
      degree: 2,
      inDegree: 1,
      outDegree: 1,
      folderId: null,
      folderName: null,
      folderColor: null,
      tags: [],
    },
    {
      id: b,
      title: 'Beta',
      kind: 'note',
      degree: 2,
      inDegree: 1,
      outDegree: 1,
      folderId: null,
      folderName: null,
      folderColor: null,
      tags: [],
    },
    {
      id: 'unresolved:ghost',
      title: 'Ghost',
      kind: 'unresolved',
      degree: 1,
      inDegree: 1,
      outDegree: 0,
      folderId: null,
      folderName: null,
      folderColor: null,
      tags: [],
    },
  ],
  edges: [
    { source: a, target: b },
    { source: b, target: a },
    { source: a, target: 'unresolved:ghost' },
  ],
  meta: { mode: 'global', centerId: null, depth: 1, totalNodes: 430, totalEdges: 490, truncated: true, limit: 350 },
}

const i18n = {
  t(key: keyof typeof EN_US_MESSAGES, params?: Readonly<Record<string, boolean | number | string | null | undefined>>) {
    return EN_US_MESSAGES[key].replace(/\{(\w+)\}/g, (whole, name: string) => String(params?.[name] ?? whole))
  },
}

const canvas = {
  clearRect: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  translate: vi.fn(),
  scale: vi.fn(),
  setTransform: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  fillText: vi.fn(),
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvas as unknown as CanvasRenderingContext2D)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test('renders real graph DTO with cycles, missing link and truncation; keyboard opens existing or creates missing target', async () => {
  const search = { graph: vi.fn(async (query: GraphQuery, options?: { signal?: AbortSignal }) => { void query; void options; return graph }) }
  const ui = { activeNoteId: a, activePane: 'primary' as const, openNote: vi.fn() }
  const notes = {
    open: vi.fn(async (id: string, pane?: string) => { void id; void pane }),
    create: vi.fn(async (body: { title: string }) => { void body; return { id: b } }),
    readOrganizeSnapshot: () => ({ folders: [], tags: [], notes: {}, contents: {} }),
  }
  const onClose = vi.fn()
  const { unmount } = render(GraphPanel, { props: { backend: { search }, ui, notes, i18n, onClose } })
  await screen.findByText(/Showing 3 of 430/)
  await waitFor(() => expect(canvas.stroke.mock.calls.length).toBeGreaterThanOrEqual(3))
  expect(screen.getByText(/2 notes · 3 links/)).toBeTruthy()
  const selector = screen.getByLabelText('Choose a note…')
  await fireEvent.change(selector, { target: { value: a } })
  await fireEvent.keyDown(selector, { key: 'Enter' })
  await waitFor(() => expect(ui.openNote).toHaveBeenCalledWith(a))
  expect(notes.open).toHaveBeenCalledWith(a, 'primary')
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  unmount()
  render(GraphPanel, { props: { backend: { search }, ui, notes, i18n, onClose } })
  await screen.findByRole('option', { name: 'Ghost (unresolved)' })
  await fireEvent.change(screen.getByLabelText('Choose a note…'), { target: { value: 'unresolved:ghost' } })
  await fireEvent.keyDown(screen.getByLabelText('Choose a note…'), { key: 'Enter' })
  await waitFor(() => expect(notes.create).toHaveBeenCalledWith({ title: 'Ghost' }))
  await waitFor(() => expect(ui.openNote).toHaveBeenCalledWith(b))
  expect(search.graph.mock.calls[0]?.[0]).toMatchObject({ mode: 'global', includeUnresolved: true, limit: 350 })
  expect(search.graph.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
})

test('switching filters aborts old request and ignores its eventual response; closing cancels work', async () => {
  const pending = Promise.withResolvers<GraphResponse>()
  const second = Promise.withResolvers<GraphResponse>()
  const search = {
    graph: vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockImplementationOnce(() => second.promise),
  }
  const ui = { activeNoteId: a, activePane: 'primary' as const, openNote: vi.fn() }
  const notes = {
    open: vi.fn(async (id: string, pane?: string) => { void id; void pane }),
    create: vi.fn(async (body: { title: string }) => { void body; return { id: b } }),
    readOrganizeSnapshot: () => ({ folders: [], tags: [], notes: {}, contents: {} }),
  }
  const { unmount } = render(GraphPanel, { props: { backend: { search }, ui, notes, i18n, onClose: vi.fn() } })
  await waitFor(() => expect(search.graph).toHaveBeenCalledTimes(1))
  const signal = search.graph.mock.calls[0]?.[1]?.signal as AbortSignal
  await fireEvent.click(screen.getByRole('button', { name: 'Local' }))
  await waitFor(() => expect(search.graph).toHaveBeenCalledTimes(2))
  expect(signal.aborted).toBe(true)
  expect(search.graph.mock.calls[1]?.[0]).toMatchObject({ mode: 'local', center: a })
  second.resolve({
    ...graph,
    nodes: [graph.nodes[1]!],
    edges: [],
    meta: { ...graph.meta, totalNodes: 1, truncated: false },
  })
  await screen.findByRole('option', { name: 'Beta' })
  pending.resolve(graph)
  await waitFor(() => expect(screen.queryByText(/Showing 3 of 430/)).toBeNull())
  expect(screen.queryByRole('option', { name: 'Alpha' })).toBeNull()
  const activeSignal = search.graph.mock.calls[1]?.[1]?.signal as AbortSignal
  const strokesBeforeClose = canvas.stroke.mock.calls.length
  await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(activeSignal.aborted).toBe(true)
  expect(canvas.stroke.mock.calls.length).toBe(strokesBeforeClose)
  unmount()
})

test('folder, tag and unresolved toggles reach SearchPort.graph without undefined optional fields', async () => {
  const search = { graph: vi.fn(async (query: GraphQuery, options?: { signal?: AbortSignal }) => { void query; void options; return graph }) }
  const ui = { activeNoteId: a, activePane: 'primary' as const, openNote: vi.fn() }
  const notes = {
    open: vi.fn(async (id: string, pane?: string) => { void id; void pane }),
    create: vi.fn(async (body: { title: string }) => { void body; return { id: b } }),
    readOrganizeSnapshot: () => ({
      folders: [
        { id: a, parentId: null, name: 'Work', icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1 },
      ],
      tags: [{ id: b, name: 'urgent', color: null, count: 1, createdAt: 1 }],
      notes: {},
      contents: {},
    }),
  }
  render(GraphPanel, { props: { backend: { search }, ui, notes, i18n, onClose: vi.fn() } })
  await screen.findByText(/Showing 3 of 430/)
  await fireEvent.click(screen.getByText('Filters'))
  await fireEvent.input(screen.getByLabelText('Filter notes…'), { target: { value: 'Alpha' } })
  await fireEvent.change(screen.getByLabelText('Folder'), { target: { value: a } })
  await fireEvent.change(screen.getByLabelText('Tag'), { target: { value: 'urgent' } })
  await fireEvent.click(screen.getByLabelText('Show unresolved notes'))
  await waitFor(() =>
    expect(search.graph).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'Alpha', folderId: a, tag: 'urgent', includeUnresolved: false }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ),
  )
  expect(search.graph.mock.calls.at(-1)?.[0]).not.toHaveProperty('center')
})
