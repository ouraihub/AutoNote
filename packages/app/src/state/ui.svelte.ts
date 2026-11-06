import type {
  EditorLayout,
  SortKey,
  SortOrder,
  UiDensity,
  ViewKind,
} from '@shared/types'
import type { Logger } from '@app/log/logger'
import type { Notifier, PrefsStore } from '@app/platform'
import type { ThemeAppearance } from '@app/theme'
import {
  DEFAULT_WORKSPACE_PREFS,
  EXPANDED_FOLDERS_LIMIT,
  RECENT_NOTES_LIMIT,
  isEntityId,
  listFilter,
  parseWorkspacePrefs,
  workspacePrefKey,
  workspacePrefsValue,
  type LayoutPrefs,
  type ListFilter,
  type PaneState,
  type PaneStates,
  type WorkspacePane,
  type WorkspacePrefs,
} from './layout-prefs'
import { UiPreferences } from './ui-preferences.svelte'

export type PanelName =
  | 'command'
  | 'search'
  | 'settings'
  | 'shortcuts'
  | 'graph'
  | 'versions'
  | 'share'
  | 'info'
export type MobilePane = 'list' | 'editor' | 'preview' | 'account'

export interface LightboxImage {
  readonly src: string
  readonly alt: string
}

export interface OpenNoteOptions {
  pane?: WorkspacePane
  activate?: boolean
  fromHistory?: boolean
}

export interface LayoutResize {
  navWidth?: number
  listWidth?: number
  assistWidth?: number
  splitRatio?: number | null
  workspaceSplitRatio?: number | null
}

export interface UiStateOptions {
  prefs: PrefsStore
  logger: Logger
  notifier: Notifier
}

const HISTORY_LIMIT = 50

export class UiState {
  #panes = $state.raw<PaneStates>(DEFAULT_WORKSPACE_PREFS.panes)
  #activePane = $state<WorkspacePane>('primary')
  #filter = $state.raw<ListFilter>(DEFAULT_WORKSPACE_PREFS.filter)
  #sort = $state<SortKey>(DEFAULT_WORKSPACE_PREFS.sort)
  #order = $state<SortOrder>(DEFAULT_WORKSPACE_PREFS.order)
  #expandedFolders = $state.raw<readonly string[]>(
    DEFAULT_WORKSPACE_PREFS.expandedFolders,
  )
  #recent = $state.raw<readonly string[]>(DEFAULT_WORKSPACE_PREFS.recentNoteIds)
  #selection = $state.raw<readonly string[]>([])
  #back = $state.raw<readonly string[]>([])
  #forward = $state.raw<readonly string[]>([])
  #panel = $state<PanelName | null>(null)
  #mobilePane = $state<MobilePane>('list')
  #navDrawerOpen = $state(false)
  #outlineOpen = $state(false)
  #backlinksOpen = $state(false)
  #lightbox = $state.raw<LightboxImage | null>(null)
  settingsSection: string | null = null
  insertAtCursor: ((text: string) => void) | null = null
  #scope = $state<string | null>(null)
  #generation = 0
  readonly #preferences: UiPreferences

  constructor(options: UiStateOptions) {
    this.#preferences = new UiPreferences(options)
  }

  get layout(): LayoutPrefs {
    return this.#preferences.layout
  }

  get appearance(): Readonly<ThemeAppearance> {
    return this.#preferences.layout.appearance
  }

  get panes(): PaneStates {
    return this.#panes
  }

  get activePane(): WorkspacePane {
    return this.#activePane
  }

  get isSplit(): boolean {
    return this.#panes.secondary.noteId !== null
  }

  get activeNoteId(): string | null {
    return this.#panes[this.#activePane].noteId
  }

  get filter(): ListFilter {
    return this.#filter
  }

  get sort(): SortKey {
    return this.#sort
  }

  get order(): SortOrder {
    return this.#order
  }

  get expandedFolders(): readonly string[] {
    return this.#expandedFolders
  }

  get recent(): readonly string[] {
    return this.#recent
  }

  get selection(): readonly string[] {
    return this.#selection
  }

  get canGoBack(): boolean {
    return this.#back.length > 0
  }

  get canGoForward(): boolean {
    return this.#forward.length > 0
  }

  get panel(): PanelName | null {
    return this.#panel
  }

  get mobilePane(): MobilePane {
    const isNotePane =
      this.#mobilePane === 'editor' || this.#mobilePane === 'preview'
    return isNotePane && this.activeNoteId === null ? 'list' : this.#mobilePane
  }

  get navDrawerOpen(): boolean {
    return this.#navDrawerOpen
  }

  get outlineOpen(): boolean {
    return this.#outlineOpen
  }

  get backlinksOpen(): boolean {
    return this.#backlinksOpen
  }

  get lightbox(): LightboxImage | null {
    return this.#lightbox
  }

  get scope(): string | null {
    return this.#scope
  }

  async load(scope: string): Promise<void> {
    const generation = ++this.#generation
    this.#scope = null
    this.#applyWorkspace(DEFAULT_WORKSPACE_PREFS)
    this.#resetTransient()
    const [, workspace] = await Promise.all([
      this.#preferences.loadLayout(),
      this.#preferences.read(workspacePrefKey(scope)),
    ])
    if (generation !== this.#generation) return
    this.#applyWorkspace(parseWorkspacePrefs(workspace))
    this.#scope = scope
  }

  async flush(): Promise<void> {
    await this.#preferences.flush()
  }

  #applyWorkspace(prefs: WorkspacePrefs): void {
    this.#panes = prefs.panes
    this.#activePane = prefs.activePane
    this.#filter = prefs.filter
    this.#sort = prefs.sort
    this.#order = prefs.order
    this.#expandedFolders = prefs.expandedFolders
    this.#recent = prefs.recentNoteIds
    const activeNoteId = prefs.panes[prefs.activePane].noteId
    this.#selection = activeNoteId === null ? [] : [activeNoteId]
  }

  #resetTransient(): void {
    this.#back = []
    this.#forward = []
    this.#panel = null
    this.#mobilePane = 'list'
    this.#navDrawerOpen = false
    this.#outlineOpen = false
    this.#backlinksOpen = false
    this.#lightbox = null
  }

  resize(patch: LayoutResize): void {
    this.#preferences.resize(patch)
  }

  toggleNav(): void {
    this.#preferences.toggleNav()
  }

  toggleList(): void {
    this.#preferences.toggleList()
  }

  toggleAssist(open = !this.layout.assistOpen): void {
    this.#preferences.toggleAssist(open)
  }

  setDensity(density: UiDensity): void {
    this.#preferences.setDensity(density)
  }

  applyAppearance(appearance: ThemeAppearance): void {
    this.#preferences.applyAppearance(appearance)
  }

  openNote(id: string, options: OpenNoteOptions = {}): void {
    if (!isEntityId(id)) throw new RangeError('Invalid note id')
    const previousId = this.activeNoteId
    const requested =
      options.pane ?? (this.isSplit ? this.#activePane : 'primary')
    const pane =
      requested === 'secondary' && this.#panes.primary.noteId === null
        ? 'primary'
        : requested
    this.#updatePane(pane, { noteId: id })
    if (pane === 'secondary') this.#outlineOpen = false
    if ((options.activate ?? true) || !this.isSplit)
      this.#activate(pane, options.fromHistory ? null : previousId)
    this.#persistWorkspace()
  }

  goBack(): string | null {
    const target = this.#back.at(-1)
    if (target === undefined) return null
    const current = this.activeNoteId
    this.#back = this.#back.slice(0, -1)
    if (current !== null)
      this.#forward = [current, ...this.#forward].slice(0, HISTORY_LIMIT)
    this.openNote(target, { fromHistory: true })
    return target
  }

  goForward(): string | null {
    const target = this.#forward[0]
    if (target === undefined) return null
    const current = this.activeNoteId
    this.#forward = this.#forward.slice(1)
    if (current !== null)
      this.#back = [...this.#back, current].slice(-HISTORY_LIMIT)
    this.openNote(target, { fromHistory: true })
    return target
  }

  activatePane(pane: WorkspacePane): void {
    if (this.#panes[pane].noteId === null) return
    this.#activate(pane, null)
    this.#outlineOpen = false
    this.#persistWorkspace()
  }

  closePane(pane: WorkspacePane): void {
    const { primary, secondary } = this.#panes
    if (secondary.noteId === null) {
      if (pane === 'secondary' || primary.noteId === null) return
      this.#updatePane('primary', { noteId: null })
    } else if (pane === 'secondary') {
      this.#updatePane('secondary', { noteId: null })
    } else {
      this.#panes = {
        primary: { ...primary, noteId: secondary.noteId },
        secondary: { ...secondary, noteId: null },
      }
    }
    this.#activate('primary', null)
    this.#persistWorkspace()
  }

  forgetNote(id: string): void {
    const { primary, secondary } = this.#panes
    const isPrimary = primary.noteId === id
    const isSecondary = secondary.noteId === id
    if (isPrimary || isSecondary) {
      this.#panes = {
        primary: {
          ...primary,
          noteId: isPrimary
            ? isSecondary
              ? null
              : secondary.noteId
            : primary.noteId,
        },
        secondary: { ...secondary, noteId: null },
      }
      this.#activate('primary', null)
    }
    this.#selection = this.#selection.filter((selectedId) => selectedId !== id)
    this.#back = this.#back.filter((noteId) => noteId !== id)
    this.#forward = this.#forward.filter((noteId) => noteId !== id)
    this.#persistWorkspace()
  }

  setPaneLayout(pane: WorkspacePane, layout: EditorLayout): void {
    if (this.#panes[pane].layout === layout) return
    this.#updatePane(pane, { layout })
    this.#persistWorkspace()
  }

  openView(
    view: ViewKind,
    target: { folderId?: string; tag?: string } = {},
  ): void {
    const filter = listFilter(view, target.folderId ?? null, target.tag ?? null)
    if (filter === null)
      throw new RangeError(`View ${view} requires a valid target`)
    this.#filter = filter
    this.#selection = []
    this.#mobilePane = 'list'
    this.#navDrawerOpen = false
    this.#persistWorkspace()
  }

  setSort(sort: SortKey, order: SortOrder = this.#order): void {
    this.#sort = sort
    this.#order = order
    this.#persistWorkspace()
  }

  toggleFolder(id: string): void {
    const expanded = this.#expandedFolders
    this.#expandedFolders = expanded.includes(id)
      ? expanded.filter((folderId) => folderId !== id)
      : [...expanded, id].slice(0, EXPANDED_FOLDERS_LIMIT)
    this.#persistWorkspace()
  }

  expandFolders(ids: readonly string[]): void {
    const added = ids.filter(
      (id, index) =>
        isEntityId(id) &&
        ids.indexOf(id) === index &&
        !this.#expandedFolders.includes(id),
    )
    if (added.length === 0) return
    this.#expandedFolders = [...this.#expandedFolders, ...added].slice(
      0,
      EXPANDED_FOLDERS_LIMIT,
    )
    this.#persistWorkspace()
  }

  reconcileFolders(validIds: ReadonlySet<string>): void {
    const expanded = this.#expandedFolders.filter((id) => validIds.has(id))
    const isFolderMissing =
      this.#filter.folderId !== null && !validIds.has(this.#filter.folderId)
    if (expanded.length === this.#expandedFolders.length && !isFolderMissing)
      return
    this.#expandedFolders = expanded
    if (isFolderMissing) this.openView('all')
    else this.#persistWorkspace()
  }

  setSelection(ids: readonly string[]): void {
    this.#selection = ids.filter((id, index) => ids.indexOf(id) === index)
  }

  toggleSelected(id: string, isAdditive: boolean): void {
    if (!isAdditive) this.#selection = [id]
    else if (this.#selection.includes(id))
      this.#selection = this.#selection.filter(
        (selectedId) => selectedId !== id,
      )
    else this.#selection = [...this.#selection, id]
  }

  openPanel(panel: PanelName): void {
    this.#panel = panel
  }

  openSettings(sectionId: string): void {
    this.settingsSection = sectionId
    this.#panel = 'settings'
  }

  closePanel(): void {
    this.#panel = null
  }

  togglePanel(panel: PanelName): void {
    this.#panel = this.#panel === panel ? null : panel
  }

  setMobilePane(pane: MobilePane): void {
    this.#mobilePane = pane
  }

  mobileBack(): void {
    this.#mobilePane = 'list'
  }

  toggleNavDrawer(isOpen: boolean = !this.#navDrawerOpen): void {
    this.#navDrawerOpen = isOpen
  }

  toggleOutline(): void {
    this.#outlineOpen = !this.#outlineOpen
  }

  toggleBacklinks(): void {
    this.#backlinksOpen = !this.#backlinksOpen
  }

  setLightbox(image: LightboxImage | null): void {
    this.#lightbox = image
  }

  #updatePane(pane: WorkspacePane, patch: Partial<PaneState>): void {
    this.#panes = { ...this.#panes, [pane]: { ...this.#panes[pane], ...patch } }
  }

  #activate(pane: WorkspacePane, previousId: string | null): void {
    this.#activePane = pane
    const id = this.#panes[pane].noteId
    this.#selection = id === null ? [] : [id]
    if (id === null) return
    this.#recent = [
      id,
      ...this.#recent.filter((recentId) => recentId !== id),
    ].slice(0, RECENT_NOTES_LIMIT)
    this.#mobilePane = 'preview'
    if (previousId === null || previousId === id) return
    this.#back = [
      ...this.#back.filter((noteId) => noteId !== previousId),
      previousId,
    ].slice(-HISTORY_LIMIT)
    this.#forward = []
  }

  #persistWorkspace(): void {
    if (this.#scope === null) return
    const value = workspacePrefsValue({
      panes: this.#panes,
      activePane: this.#activePane,
      filter: this.#filter,
      sort: this.#sort,
      order: this.#order,
      expandedFolders: this.#expandedFolders,
      recentNoteIds: this.#recent,
    })
    this.#preferences.schedule(workspacePrefKey(this.#scope), value)
  }
}
