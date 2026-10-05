import { fileURLToPath } from 'node:url'
import type { UserConfigFnPromise } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { themeBootstrapPlugin } from '../packages/app/src/theme/vite-plugin'
import { autonotePwa } from './pwa.config'

const ephemeralDevState = process.env.AUTONOTE_EPHEMERAL_DEV === '1'

const config: UserConfigFnPromise = async ({ mode, command }) => ({
  plugins: [
    svelte(),
    tailwindcss(),
    themeBootstrapPlugin('autonote.ui:layout'),
    autonotePwa(),
    ...(mode === 'demo' ? [] : cloudflare({
      configPath: mode === 'kv' ? './wrangler.kv.toml' : './wrangler.toml',
      persistState: !ephemeralDevState,
      ...(command === 'serve' && mode !== 'ai'
        ? {
            config: (worker) => {
              delete worker.ai
            },
          }
        : {}),
    })),
  ],

  resolve: {
    alias: [
      { find: '$lib', replacement: fileURLToPath(new URL('./src/client/lib', import.meta.url)) },
      { find: '@app', replacement: fileURLToPath(new URL('../packages/app/src', import.meta.url)) },
      { find: '@shared', replacement: fileURLToPath(new URL('../packages/shared/src', import.meta.url)) },
    ],
  },

  server: {
    port: mode === 'demo' ? 7714 : 7712,
    strictPort: mode === 'demo',
  },

  preview: {
    port: mode === 'demo' ? 7715 : 7713,
  },

  build: {
    target: 'esnext',
    ...(mode === 'demo' ? { outDir: 'dist/demo', emptyOutDir: true } : {}),
    sourcemap: false,
    cssMinify: 'lightningcss',
  },
})

export default config
