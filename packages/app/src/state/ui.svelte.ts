import type { EditorLayout, SortKey, SortOrder, UiDensity, ViewKind } from '@shared/types'
import { isBackendError } from '@app/backend'
import type { Logger } from '@app/log/logger'
import type { Notifier, PrefsStore, PrefValue } from '@app/platform'
import type { ThemeAppearance } from '@app/theme'
import {
  DEFAULT_LAYOUT_PREFS,
  DEFAULT_WORKSPACE_PREFS,
  EXPANDED_FOLDERS_LIMIT,
  LAYOUT_PREF_KEY,
  RECENT_NOTES_LIMIT,
  isEntityId,
  layoutPrefsValue,
  listFilter,
  parseLayoutPrefs,
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
import { CoalescingPrefsWriter } from './prefs-writer'

export type PanelName = 'command' | 'search' | 'settings' | 'shortcuts' | 'graph' | 'versions' | 'share' | 'info'
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
  splitRatio?: number | null
  workspaceSplitRatio?: number | null
}

export interface UiStateOptions {
  prefs: PrefsStore
  logger: Logger
  notifier: Notifier
}

const HISTORY_LIMIT = 50
const SAVE_FAILED_TOAST_ID = 'ui.prefs.save_failed'

export class UiState {
  #layout = $state.raw<LayoutPrefs>(DEFAULT_LAYOUT_PREFS)
  #panes = $state.raw<PaneStates>(DEFAULT_WORKSPACE_PREFS.panes)
  #activePane = $state<WorkspacePane>('primary')
  #filter = $state.raw<ListFilter>(DEFAULT_WORKSPACE_PREFS.filter)
  #sort = $state<SortKey>(DEFAULT_WORKSPACE_PREFS.sort)
  #order = $state<SortOrder>(DEFAULT_WORKSPACE_PREFS.order)
  #expandedFolders = $state.raw<readonly string[]>(DEFAULT_WORKSPACE_PREFS.expandedFolders)
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
  /** Section the next settings open lands on; consumed by SettingsPanel. */
  settingsSection: string | null = null
  /** Inserts at the active editor's cursor; set by the active NotePane. */
  insertAtCursor: ((text: string) => void) | null = null
  #scope = $state<string | null>(null)
  #layoutLoad: Promise<void> | null = null
  #isLayoutTouched = false
  #generation = 0
  readonly #writer = new CoalescingPrefsWriter((key, value) => this.#write(key, value))
  #hasReportedSaveFailure = false
  readonly #prefs: PrefsStore
  readonly #logger: Logger
  readonly #notifier: Notifier

  constructor(options: UiStateOptions) {
    this.#prefs = options.prefs
    this.#logger = options.logger
    this.#notifier = options.notifier
  }

  get layout(): LayoutPrefs {
    return this.#layout
  }

  get appearance(): Readonly<ThemeAppearance> {
    return this.#layout.appearance
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
    const isNotePane = this.#mobilePane === 'editor' || this.#mobilePane === 'preview'
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
    const [, workspace] = await Promise.all([this.#loadLayout(), this.#read(workspacePrefKey(scope))])
    if (generation !== this.#generation) return
    this.#applyWorkspace(parseWorkspacePrefs(workspace))
    this.#scope = scope
  }

  async flush(): Promise<void> {
    await this.#writer.flush()
  }

  async #loadLayout(): Promise<void> {
    this.#layoutLoad ??= this.#read(LAYOUT_PREF_KEY).then((stored) => {
      if (!this.#isLayoutTouched) this.#layout = parseLayoutPrefs(stored)
    })
    await this.#layoutLoad
  }

  async #read(key: string): Promise<unknown> {
    try {
      return await this.#prefs.load(key)
    } catch (error) {
      if (!isBackendError(error)) throw error
      this.#logger.warn('ui.prefs.load_failed', { key, code: error.code })
      return undefined
    }
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
    const current = this.#layout
    const next = parseLayoutPrefs({ ...current, ...patch })
    if (
      next.navWidth === current.navWidth &&
      next.listWidth === current.listWidth &&
      next.splitRatio === current.splitRatio &&
      next.workspaceSplitRatio === current.workspaceSplitRatio
    )
      return
    this.#persistLayout(next)
  }

  toggleNav(): void {
    this.#persistLayout({ ...this.#layout, navCollapsed: !this.#layout.navCollapsed })
  }

  toggleList(): void {
    this.#persistLayout({ ...this.#layout, listCollapsed: !this.#layout.listCollapsed })
  }

  toggleAssist(open = !this.#layout.assistOpen): void {
    if (open !== this.#layout.assistOpen) this.#persistLayout({ ...this.#layout, assistOpen: open })
  }

  setDensity(density: UiDensity): void {
    if (density === this.#layout.density) return
    this.#persistLayout({ ...this.#layout, density })
  }

  applyAppearance(appearance: ThemeAppearance): void {
    const current = this.#layout.appearance
    if (
      appearance.theme === current.theme &&
      appearance.accent === current.accent &&
      appearance.background === current.background
    )
      return
    const next = { theme: appearance.theme, accent: appearance.accent, background: appearance.background }
    this.#persistLayout({ ...this.#layout, appearance: next })
  }

  openNote(id: string, options: OpenNoteOptions = {}): void {
    if (!isEntityId(id)) throw new RangeError('Invalid note id')
    const previousId = this.activeNoteId
    const requested = options.pane ?? (this.isSplit ? this.#activePane : 'primary')
    const pane = requested === 'secondary' && this.#panes.primary.noteId === null ? 'primary' : requested
    this.#updatePane(pane, { noteId: id })
    if (pane === 'secondary') this.#outlineOpen = false
    if ((options.activate ?? true) || !this.isSplit) this.#activate(pane, options.fromHistory ? null : previousId)
    this.#persistWorkspace()
  }

  goBack(): string | null {
    const target = this.#back.at(-1)
    if (target === undefined) return null
    const current = this.activeNoteId
    this.#back = this.#back.slice(0, -1)
    if (current !== null) this.#forward = [current, ...this.#forward].slice(0, HISTORY_LIMIT)
    this.openNote(target, { fromHistory: true })
    return target
  }

  goForward(): string | null {
    const target = this.#forward[0]
    if (target === undefined) return null
    const current = this.activeNoteId
    this.#forward = this.#forward.slice(1)
    if (current !== null) this.#back = [...this.#back, current].slice(-HISTORY_LIMIT)
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
      this.#panes = { primary: { ...primary, noteId: secondary.noteId }, secondary: { ...secondary, noteId: null } }
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
        primary: { ...primary, noteId: isPrimary ? (isSecondary ? null : secondary.noteId) : primary.noteId },
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

  openView(view: ViewKind, target: { folderId?: string; tag?: string } = {}): void {
    const filter = listFilter(view, target.folderId ?? null, target.tag ?? null)
    if (filter === null) throw new RangeError(`View ${view} requires a valid target`)
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
      (id, index) => isEntityId(id) && ids.indexOf(id) === index && !this.#expandedFolders.includes(id),
    )
    if (added.length === 0) return
    this.#expandedFolders = [...this.#expandedFolders, ...added].slice(0, EXPANDED_FOLDERS_LIMIT)
    this.#persistWorkspace()
  }

  reconcileFolders(validIds: ReadonlySet<string>): void {
    const expanded = this.#expandedFolders.filter((id) => validIds.has(id))
    const isFolderMissing = this.#filter.folderId !== null && !validIds.has(this.#filter.folderId)
    if (expanded.length === this.#expandedFolders.length && !isFolderMissing) return
    this.#expandedFolders = expanded
    if (isFolderMissing) this.openView('all')
    else this.#persistWorkspace()
  }

  setSelection(ids: readonly string[]): void {
    this.#selection = ids.filter((id, index) => ids.indexOf(id) === index)
  }

  toggleSelected(id: string, isAdditive: boolean): void {
    if (!isAdditive) this.#selection = [id]
    else if (this.#selection.includes(id)) this.#selection = this.#selection.filter((selectedId) => selectedId !== id)
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
    this.#recent = [id, ...this.#recent.filter((recentId) => recentId !== id)].slice(0, RECENT_NOTES_LIMIT)
    this.#mobilePane = 'preview'
    if (previousId === null || previousId === id) return
    this.#back = [...this.#back.filter((noteId) => noteId !== previousId), previousId].slice(-HISTORY_LIMIT)
    this.#forward = []
  }

  #persistLayout(next: LayoutPrefs): void {
    this.#isLayoutTouched = true
    this.#layout = next
    this.#writer.schedule(LAYOUT_PREF_KEY, layoutPrefsValue(next))
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
    this.#writer.schedule(workspacePrefKey(this.#scope), value)
  }

  async #write(key: string, value: PrefValue): Promise<void> {
    try {
      await this.#prefs.save(key, value)
      this.#hasReportedSaveFailure = false
    } catch (error) {
      if (!isBackendError(error)) throw error
      this.#logger.warn('ui.prefs.save_failed', { key, code: error.code })
      if (!this.#hasReportedSaveFailure) {
        this.#hasReportedSaveFailure = true
        this.#notifier.toast({ id: SAVE_FAILED_TOAST_ID, key: 'shell.layout_preferences_not_saved', tone: 'warning' })
      }
      throw error
    }
  }
}
