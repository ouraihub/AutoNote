export { getPreferences, getSettings } from './search-config'
export { savePreferences } from './search-preferences'
export { saveProvider, setDefault } from './search-settings'
export { saveKey } from './search-key-mutations'
export { removeKey } from './search-key-remove'
export { reveal } from './search-key-reveal'
export { check, search, fetchPage } from './search-execution'
export type {
  SearchCap,
  SearchPreferences,
  SearchProviderDto,
  SearchSettingsDto,
} from './search-config'
