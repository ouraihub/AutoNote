import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      $lib: resolve('./src/client/lib'),
      '@app': resolve('../packages/app/src'),
      '@shared': resolve('../packages/shared/src'),
    },
  },
  test: {
    // Aether Git packages are source-distributed; inline them so Vitest transforms TS instead of Node stripping types.
    server: { deps: { inline: [/@ouraihub\/aether-(contracts|core)/] } },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
          exclude: ['src/**/*.dom.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          environmentOptions: { jsdom: { pretendToBeVisual: true } },
          include: ['src/**/*.dom.test.ts'],
        },
      },
    ],
  },
})
