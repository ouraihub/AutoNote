import type { Plugin } from 'vite'
import { themeBootstrapScript } from './bootstrap'

const THEME_BOOTSTRAP_MARKER = '<!-- autonote-theme-bootstrap -->'

export function themeBootstrapPlugin(storageKey: string): Plugin {
  const bootstrap = `<script>${themeBootstrapScript(storageKey)}</script>`

  return {
    name: 'autonote-theme-bootstrap',
    transformIndexHtml(html) {
      return html.replace(THEME_BOOTSTRAP_MARKER, bootstrap)
    },
  }
}
