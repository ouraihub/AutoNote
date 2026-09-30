import { fileURLToPath } from 'node:url'
import type { UserConfigFnPromise } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { themeBootstrapPlugin } from '../packages/app/src/theme/vite-plugin'

const ephemeralDevState = process.env.AUTONOTE_EPHEMERAL_DEV === '1'

const config: UserConfigFnPromise = async ({ mode, command }) => ({
  plugins: [
    svelte(),
    tailwindcss(),
    themeBootstrapPlugin('autonote.ui'),
    cloudflare({
      configPath: mode === 'kv' ? './wrangler.kv.toml' : undefined,
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
    alias: [
      { find: '$lib', replacement: fileURLToPath(new URL('./src/client/lib', import.meta.url)) },
      { find: '@app', replacement: fileURLToPath(new URL('../packages/app/src', import.meta.url)) },
      { find: '@shared', replacement: fileURLToPath(new URL('../packages/shared/src', import.meta.url)) },
    ],
  },

  server: {
    port: 7712,
    strictPort: false,
  },

  preview: {
    port: 7713,
  },

  build: {
    target: 'esnext',
    sourcemap: false,
    cssMinify: 'lightningcss',
  },
})

export default config
