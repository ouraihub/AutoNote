import { fileURLToPath } from 'node:url'
import type { UserConfigFnPromise } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { themeBootstrapPlugin } from '../packages/app/src/theme/vite-plugin'
import { autonotePwa } from './pwa.config'

const ephemeralDevState = process.env.AUTONOTE_EPHEMERAL_DEV === '1'

const config: UserConfigFnPromise = async ({ mode, command }) => {
  if (mode === 'demo') throw new Error('The demo mode has been removed; use production or kv')

  return {
    plugins: [
      svelte(),
      tailwindcss(),
      themeBootstrapPlugin('autonote.ui:layout'),
      autonotePwa(),
      cloudflare({
        configPath: mode === 'kv' ? './wrangler.kv.toml' : './wrangler.toml',
        persistState: !ephemeralDevState,
        ...(command === 'serve' && mode !== 'ai'
          ? {
              config: (worker) => {
                delete worker.ai
              },
            }
          : {}),
      }),
    ],

    resolve: {
      dedupe: ['svelte', 'bits-ui'],
      alias: [
        { find: '$lib', replacement: fileURLToPath(new URL('./src/client/lib', import.meta.url)) },
        { find: '@app', replacement: fileURLToPath(new URL('../packages/app/src', import.meta.url)) },
        { find: '@shared', replacement: fileURLToPath(new URL('../packages/shared/src', import.meta.url)) },
      ],
    },

    optimizeDeps: {
      exclude: ['@ouraihub/aether-ui'],
    },

    server: {
      port: 7712,
    },

    preview: {
      port: 7713,
    },

    build: {
      target: 'esnext',
      sourcemap: false,
      cssMinify: 'lightningcss',
    },
  }
}

export default config
