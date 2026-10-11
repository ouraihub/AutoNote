import type { Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { Component } from 'svelte'
import type { FlushResult } from '@shared/backend-types'
import type { Backend } from '@app/backend'
import type { Logger } from '@app/log/logger'
import type { Clock } from '@app/platform/clock'
import type { Notifier } from '@app/platform/notifier'
import type { PrefsStore } from '@app/platform/prefs'

export interface HostSettingsSection {
  id: string
  order: number
  titleKey: string
  canShow(): boolean
  component: Component
  icon?: Component<{ size?: number }>
}

export interface HostPanel {
  id: string
  order: number
  titleKey: string
  component: Component
  props?: Readonly<Record<string, unknown>>
}

export interface WorkspacePanelProps {
  note: { id: string; title: string; content: string } | null
  insert(text: string): void
  openSettings(sectionId: string): void
  onClose(): void
}

export interface WorkspacePanel {
  titleKey: string
  icon: Component<{ size?: number }>
  component: Component<WorkspacePanelProps>
}

export interface WritingSelection {
  from: number
  to: number
  docLength: number
  text: string
  doc: Text
}

export interface WritingToolbarProps {
  view: EditorView | null
  selection: WritingSelection
  noteId: string
  noteTitle: string
  onReplace(text: string, selection: WritingSelection): boolean
  onInsert(text: string): void
}

export interface WritingToolbarExtension {
  component: Component<WritingToolbarProps>
}

export interface HostExtensions {
  readonly settingsSections: readonly HostSettingsSection[]
  readonly aboutPanels: readonly HostPanel[]
  readonly workspacePanel?: WorkspacePanel
  readonly writingToolbar?: WritingToolbarExtension
  onNoteOpened?(id: string): void
  subscribeIntents?(listener: (intent: 'new-note') => void): () => void
}

export interface AppDeps {
  backend: Backend
  clock: Clock
  logger: Logger
  prefs: PrefsStore
  notifier: Notifier
  extensions: HostExtensions
  authDefaults?: Readonly<{ username: string; password: string }>
}

export interface AppHandle {
  flush(): Promise<FlushResult>
  openNote(id: string | null, pane?: 'primary' | 'secondary'): Promise<void>
  destroy(): Promise<void>
}
