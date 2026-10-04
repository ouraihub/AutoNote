import { defineConfig } from 'vite'
import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  resolve: {
    conditions: ['svelte', 'browser', 'module', 'development|production'],
  },
  clearScreen: false,
  ssr: {
    resolve: {
      conditions: ['svelte', 'node'],
    },
  },
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    ...(host ? { hmr: { protocol: 'ws' as const, host, port: 1431 } } : {}),
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
})
