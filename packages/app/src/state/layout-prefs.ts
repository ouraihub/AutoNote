import { ACCENTS, DEFAULT_SETTINGS, LIMITS, VIEW_KINDS } from '@shared/constants'
import type { EditorLayout, SortKey, SortOrder, UiDensity, ViewKind } from '@shared/types'
import type { PrefValue } from '@app/platform'
import type { ThemeAppearance } from '@app/theme'

export type WorkspacePane = 'primary' | 'secondary'

export interface PaneState {
  readonly noteId: string | null
  readonly layout: EditorLayout
}

export type PaneStates = Readonly<Record<WorkspacePane, PaneState>>

export interface LayoutPrefs {
  readonly navWidth: number
  readonly listWidth: number
  readonly navCollapsed: boolean
  readonly listCollapsed: boolean
  readonly assistOpen: boolean
  readonly splitRatio: number | null
  readonly workspaceSplitRatio: number | null
  readonly density: UiDensity
  readonly appearance: Readonly<ThemeAppearance>
}

export interface ListFilter {
  readonly view: ViewKind
  readonly folderId: string | null
  readonly tag: string | null
}

export interface WorkspacePrefs {
  readonly panes: PaneStates
  readonly activePane: WorkspacePane
  readonly filter: ListFilter
  readonly sort: SortKey
  readonly order: SortOrder
  readonly expandedFolders: readonly string[]
  readonly recentNoteIds: readonly string[]
}

export const PANEL_WIDTHS = {
  navigation: { min: 196, max: 380 },
  noteList: { min: 260, max: 520 },
} as const

export const SPLIT_RATIO_RANGE = { min: 0.2, max: 0.8 } as const
export const RECENT_NOTES_LIMIT = 24
export const EXPANDED_FOLDERS_LIMIT = 500
export const LAYOUT_PREF_KEY = 'layout'

const ENTITY_ID_MAX_LENGTH = 128
const WORKSPACE_PANES: readonly WorkspacePane[] = ['primary', 'secondary']
const EDITOR_LAYOUTS: readonly EditorLayout[] = ['live', 'split', 'preview']
const SORT_KEYS: readonly SortKey[] = ['updated', 'created', 'title']
const SORT_ORDERS: readonly SortOrder[] = ['asc', 'desc']
const DENSITIES: readonly UiDensity[] = ['comfortable', 'compact']
const THEMES: readonly ThemeAppearance['theme'][] = ['light', 'dark', 'system']
const ACCENT_NAMES: readonly ThemeAppearance['accent'][] = ACCENTS.map((accent) => accent.name)
const BACKGROUNDS: readonly ThemeAppearance['background'][] = ['paper', 'white']

export const DEFAULT_LAYOUT_PREFS: LayoutPrefs = Object.freeze({
  navWidth: PANEL_WIDTHS.navigation.min,
  listWidth: PANEL_WIDTHS.noteList.min,
  navCollapsed: false,
  listCollapsed: false,
  assistOpen: false,
  splitRatio: null,
  workspaceSplitRatio: null,
  density: DEFAULT_SETTINGS.appearance.density,
  appearance: Object.freeze({
    theme: DEFAULT_SETTINGS.appearance.theme,
    accent: DEFAULT_SETTINGS.appearance.accent,
    background: DEFAULT_SETTINGS.appearance.background,
  }),
})

export const DEFAULT_WORKSPACE_PREFS: WorkspacePrefs = Object.freeze({
  panes: Object.freeze({
    primary: Object.freeze({ noteId: null, layout: 'live' as const }),
    secondary: Object.freeze({ noteId: null, layout: 'live' as const }),
  }),
  activePane: 'primary' as const,
  filter: Object.freeze({ view: 'all' as const, folderId: null, tag: null }),
  sort: 'updated' as const,
  order: 'desc' as const,
  expandedFolders: Object.freeze([]),
  recentNoteIds: Object.freeze([]),
})

export function workspacePrefKey(scope: string): string {
  return `workspace:${scope}`
}

export function isEntityId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= ENTITY_ID_MAX_LENGTH
}

export function listFilter(view: ViewKind, folderId: string | null, tag: string | null): ListFilter | null {
  if (view === 'folder') return isEntityId(folderId) ? { view, folderId, tag: null } : null
  if (view === 'tag') return isTagName(tag) ? { view, folderId: null, tag } : null
  return { view, folderId: null, tag: null }
}

export function parseLayoutPrefs(value: unknown): LayoutPrefs {
  const source = asRecord(value)
  const appearance = asRecord(source.appearance)
  const fallback = DEFAULT_LAYOUT_PREFS
  return {
    navWidth: clampNumber(source.navWidth, PANEL_WIDTHS.navigation, fallback.navWidth),
    listWidth: clampNumber(source.listWidth, PANEL_WIDTHS.noteList, fallback.listWidth),
    navCollapsed: typeof source.navCollapsed === 'boolean' ? source.navCollapsed : fallback.navCollapsed,
    listCollapsed: typeof source.listCollapsed === 'boolean' ? source.listCollapsed : fallback.listCollapsed,
    assistOpen: typeof source.assistOpen === 'boolean' ? source.assistOpen : fallback.assistOpen,
    splitRatio: clampNumber(source.splitRatio, SPLIT_RATIO_RANGE, null),
    workspaceSplitRatio: clampNumber(source.workspaceSplitRatio, SPLIT_RATIO_RANGE, null),
    density: choiceOr(source.density, DENSITIES, fallback.density),
    appearance: {
      theme: choiceOr(appearance.theme, THEMES, fallback.appearance.theme),
      accent: choiceOr(appearance.accent, ACCENT_NAMES, fallback.appearance.accent),
      background: choiceOr(appearance.background, BACKGROUNDS, fallback.appearance.background),
    },
  }
}

export function parseWorkspacePrefs(value: unknown): WorkspacePrefs {
  const source = asRecord(value)
  const panes = asRecord(source.panes)
  const storedPrimary = parsePane(panes.primary)
  const storedSecondary = parsePane(panes.secondary)
  const promoted = storedPrimary.noteId === null && storedSecondary.noteId !== null
  const primary = promoted ? { noteId: storedSecondary.noteId, layout: storedPrimary.layout } : storedPrimary
  const secondary = promoted ? { noteId: null, layout: storedSecondary.layout } : storedSecondary
  const filter = asRecord(source.filter)
  const parsedFilter = listFilter(
    choiceOr(filter.view, VIEW_KINDS, DEFAULT_WORKSPACE_PREFS.filter.view),
    isEntityId(filter.folderId) ? filter.folderId : null,
    isTagName(filter.tag) ? filter.tag : null,
  )
  return {
    panes: { primary, secondary },
    activePane: secondary.noteId === null ? 'primary' : choiceOr(source.activePane, WORKSPACE_PANES, 'primary'),
    filter: parsedFilter ?? DEFAULT_WORKSPACE_PREFS.filter,
    sort: choiceOr(source.sort, SORT_KEYS, DEFAULT_WORKSPACE_PREFS.sort),
    order: choiceOr(source.order, SORT_ORDERS, DEFAULT_WORKSPACE_PREFS.order),
    expandedFolders: uniqueIds(source.expandedFolders, EXPANDED_FOLDERS_LIMIT),
    recentNoteIds: uniqueIds(source.recentNoteIds, RECENT_NOTES_LIMIT),
  }
}

export function layoutPrefsValue(prefs: LayoutPrefs): PrefValue {
  return {
    navWidth: prefs.navWidth,
    listWidth: prefs.listWidth,
    navCollapsed: prefs.navCollapsed,
    listCollapsed: prefs.listCollapsed,
    assistOpen: prefs.assistOpen,
    splitRatio: prefs.splitRatio,
    workspaceSplitRatio: prefs.workspaceSplitRatio,
    density: prefs.density,
    appearance: {
      theme: prefs.appearance.theme,
      accent: prefs.appearance.accent,
      background: prefs.appearance.background,
    },
  }
}

export function workspacePrefsValue(prefs: WorkspacePrefs): PrefValue {
  return {
    panes: {
      primary: { noteId: prefs.panes.primary.noteId, layout: prefs.panes.primary.layout },
      secondary: { noteId: prefs.panes.secondary.noteId, layout: prefs.panes.secondary.layout },
    },
    activePane: prefs.activePane,
    filter: { view: prefs.filter.view, folderId: prefs.filter.folderId, tag: prefs.filter.tag },
    sort: prefs.sort,
    order: prefs.order,
    expandedFolders: prefs.expandedFolders,
    recentNoteIds: prefs.recentNoteIds,
  }
}

function parsePane(value: unknown): PaneState {
  const source = asRecord(value)
  return {
    noteId: isEntityId(source.noteId) ? source.noteId : null,
    layout: choiceOr(source.layout, EDITOR_LAYOUTS, 'live'),
  }
}

function isTagName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= LIMITS.tagNameMaxLength
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function clampNumber<F extends number | null>(
  value: unknown,
  range: { readonly min: number; readonly max: number },
  fallback: F,
): number | F {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(range.max, Math.max(range.min, value))
}

function choiceOr<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return choices.find((choice) => choice === value) ?? fallback
}

function uniqueIds(value: unknown, limit: number): readonly string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(isEntityId))].slice(0, limit)
}
