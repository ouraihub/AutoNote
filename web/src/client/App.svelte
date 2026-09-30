<script lang="ts">
  import AppBrand from '@app/foundation/AppBrand.svelte'
  import { APP_VERSION } from '../release'
</script>

<main class="grid min-h-dvh place-items-center bg-[var(--bg-base)] text-[var(--text-primary)]">
  <section class="flex flex-col items-center gap-4 text-center">
    <AppBrand />
    <p class="text-sm opacity-70">v{APP_VERSION}</p>
  </section>
</main>
