import { DEFAULT_SETTINGS } from '../../../shared/src/constants'
import type {
  AccentName,
  BackgroundName,
  ThemePref,
} from '../../../shared/src/types'

export interface BootstrapAppearance {
  theme: ThemePref
  accent: AccentName
  background: BackgroundName
}

const ACCENTS: Record<AccentName, true> = {
  cinnabar: true,
  indigo: true,
  celadon: true,
  amber: true,
  terracotta: true,
  wisteria: true,
  graphite: true,
}

export function themeBootstrapScript(storageKey: string): string {
  const fallback = JSON.stringify(DEFAULT_SETTINGS.appearance)
  const accents = JSON.stringify(ACCENTS)
  const key = JSON.stringify(storageKey)

  return `(function(){try{var stored=localStorage.getItem(${key});var parsed=stored?JSON.parse(stored):null;var appearance=parsed&&typeof parsed==='object'&&parsed.appearance&&typeof parsed.appearance==='object'?parsed.appearance:${fallback};var dark=appearance.theme==='dark'||(appearance.theme==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);var root=document.documentElement;root.dataset.theme=dark?'dark':'light';root.dataset.accent=${accents}[appearance.accent]?appearance.accent:${JSON.stringify(DEFAULT_SETTINGS.appearance.accent)};root.dataset.background=appearance.background==='white'?'white':'paper';root.dataset.motion=matchMedia('(prefers-reduced-motion: reduce)').matches?'reduced':'full'}catch(_){var root=document.documentElement;root.dataset.theme='light';root.dataset.accent=${JSON.stringify(DEFAULT_SETTINGS.appearance.accent)};root.dataset.background=${JSON.stringify(DEFAULT_SETTINGS.appearance.background)};root.dataset.motion='full'}})();`
}
