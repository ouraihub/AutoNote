import adapter from '@sveltejs/adapter-static'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ fallback: 'index.html' }),
    alias: {
      '@app': '../packages/app/src',
      '@app/*': '../packages/app/src/*',
      '@shared': '../packages/shared/src',
      '@shared/*': '../packages/shared/src/*',
    },
  },
}
