import { describe, expect, test } from 'vitest'
import {
  DEFAULT_LAYOUT_PREFS,
  PANEL_WIDTHS,
  RECENT_NOTES_LIMIT,
  layoutPrefsValue,
  parseLayoutPrefs,
  parseWorkspacePrefs,
  workspacePrefsValue,
} from './layout-prefs'

describe('parseLayoutPrefs', () => {
  test.each([
    ['zero', 0, PANEL_WIDTHS.navigation.min],
    ['negative', -400, PANEL_WIDTHS.navigation.min],
    ['oversized', 50_000, PANEL_WIDTHS.navigation.max],
    ['non-finite', Number.POSITIVE_INFINITY, DEFAULT_LAYOUT_PREFS.navWidth],
    ['string', '300px', DEFAULT_LAYOUT_PREFS.navWidth],
    ['null', null, DEFAULT_LAYOUT_PREFS.navWidth],
  ])('keeps a %s navigation width visible', (_label, navWidth, expected) => {
    const prefs = parseLayoutPrefs({ navWidth, listWidth: navWidth })

    expect(prefs.navWidth).toBe(expected)
    expect(prefs.listWidth).toBeGreaterThanOrEqual(PANEL_WIDTHS.noteList.min)
    expect(prefs.listWidth).toBeLessThanOrEqual(PANEL_WIDTHS.noteList.max)
  })

  test('clamps split ratios so neither side collapses and keeps null as automatic', () => {
    expect(
      parseLayoutPrefs({ splitRatio: 0, workspaceSplitRatio: 1 }),
    ).toMatchObject({
      splitRatio: 0.2,
      workspaceSplitRatio: 0.8,
    })
    expect(
      parseLayoutPrefs({ splitRatio: null, workspaceSplitRatio: 'half' }),
    ).toMatchObject({
      splitRatio: null,
      workspaceSplitRatio: null,
    })
  })

  test('falls back to canonical appearance for unknown values', () => {
    const prefs = parseLayoutPrefs({
      appearance: { theme: 'neon', accent: 'teal', background: 'white' },
    })

    expect(prefs.appearance).toEqual({
      theme: 'system',
      accent: 'cinnabar',
      background: 'white',
    })
  })

  test('treats corrupt payloads as defaults', () => {
    expect(parseLayoutPrefs('{"navWidth":')).toEqual(DEFAULT_LAYOUT_PREFS)
    expect(parseLayoutPrefs([1, 2])).toEqual(DEFAULT_LAYOUT_PREFS)
  })

  test('round-trips through the stored value', () => {
    const prefs = parseLayoutPrefs({
      navWidth: 240,
      listCollapsed: true,
      splitRatio: 0.4,
      density: 'compact',
    })

    expect(parseLayoutPrefs(layoutPrefsValue(prefs))).toEqual(prefs)
  })
})

describe('parseWorkspacePrefs', () => {
  test('promotes a lone secondary note into the primary pane', () => {
    const prefs = parseWorkspacePrefs({
      panes: {
        primary: { noteId: null, layout: 'split' },
        secondary: { noteId: 'note-b', layout: 'preview' },
      },
      activePane: 'secondary',
    })

    expect(prefs.panes).toEqual({
      primary: { noteId: 'note-b', layout: 'split' },
      secondary: { noteId: null, layout: 'preview' },
    })
    expect(prefs.activePane).toBe('primary')
  })

  test('rejects targetless folder views and oversized ids', () => {
    const prefs = parseWorkspacePrefs({
      filter: { view: 'folder', folderId: null },
      panes: { primary: { noteId: 'x'.repeat(129), layout: 'live' } },
    })

    expect(prefs.filter).toEqual({ view: 'all', folderId: null, tag: null })
    expect(prefs.panes.primary.noteId).toBeNull()
  })

  test('deduplicates and bounds recent notes', () => {
    const ids = Array.from(
      { length: RECENT_NOTES_LIMIT + 10 },
      (_, index) => `note-${index}`,
    )
    const prefs = parseWorkspacePrefs({ recentNoteIds: ['note-0', ...ids, 42] })

    expect(prefs.recentNoteIds).toHaveLength(RECENT_NOTES_LIMIT)
    expect(new Set(prefs.recentNoteIds).size).toBe(RECENT_NOTES_LIMIT)
    expect(prefs.recentNoteIds[0]).toBe('note-0')
  })

  test('round-trips through the stored value', () => {
    const prefs = parseWorkspacePrefs({
      panes: {
        primary: { noteId: 'a', layout: 'split' },
        secondary: { noteId: 'b', layout: 'preview' },
      },
      activePane: 'secondary',
      filter: { view: 'tag', tag: 'work' },
      sort: 'title',
      order: 'asc',
      expandedFolders: ['f1'],
      recentNoteIds: ['b', 'a'],
    })

    expect(parseWorkspacePrefs(workspacePrefsValue(prefs))).toEqual(prefs)
  })
})
