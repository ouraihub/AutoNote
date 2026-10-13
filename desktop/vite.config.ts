import { defineConfig } from 'vitest/config'
import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  resolve: {
    conditions: ['svelte', 'browser', 'module', 'development|production'],
  },
  optimizeDeps: {
    exclude: ['@ouraihub/aether-ui'],
  },
  clearScreen: false,
  ssr: {
    resolve: {
      conditions: ['svelte', 'node'],
    },
  },
  build: {
    reportCompressedSize: false,
  },
  test: {
    include: ['src/**/*.test.ts'],
    // Compile .svelte deps (lucide, bits-ui and its runed/svelte-toolbelt) so they share one Svelte runtime.
    server: { deps: { inline: [/@lucide\/svelte/, /bits-ui/, /runed/, /svelte-toolbelt/] } },
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
