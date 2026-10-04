import { createContext } from 'svelte'
import type { Backend } from '../backend'
import type { I18nState } from '../i18n/runtime.svelte'
import type { Logger } from '../log/logger'
import type { Clock } from '../platform/clock'
import type { Notifier } from '../platform/notifier'
import type { PrefsStore } from '../platform/prefs'
import type { OrganizeActions } from '../state/mutations'
import type { NotesState } from '../state/notes.svelte'
import type { SessionState } from '../state/session.svelte'
import type { SettingsState } from '../state/settings.svelte'
import type { UiState } from '../state/ui.svelte'
import type { HostExtensions } from './types'

export const [getBackend, setBackend] = createContext<Backend>()
export const [getClock, setClock] = createContext<Clock>()
export const [getLogger, setLogger] = createContext<Logger>()
export const [getPrefs, setPrefs] = createContext<PrefsStore>()
export const [getNotifier, setNotifier] = createContext<Notifier>()
export const [getExtensions, setExtensions] = createContext<HostExtensions>()
export const [getI18n, setI18n] = createContext<I18nState>()
export const [getNotes, setNotes] = createContext<NotesState>()
export const [getSession, setSession] = createContext<SessionState>()
export const [getSettings, setSettings] = createContext<SettingsState>()
export const [getUi, setUi] = createContext<UiState>()
export const [getOrganize, setOrganize] = createContext<OrganizeActions>()
export const [getRegisterFlush, setRegisterFlush] = createContext<(flush: () => Promise<void>) => () => void>()
