<script lang="ts">
  let { label }: { label: string } = $props()
</script>

<div
  role="status"
  aria-live="polite"
  class="flex h-full min-h-[160px] flex-col items-center justify-center gap-2.5 text-[var(--text-quaternary)]"
>
  <svg
    aria-hidden="true"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    class="animate-[ink-spin_.7s_linear_infinite]"
  >
    <circle
      cx="12"
      cy="12"
      r="9"
      stroke="currentColor"
      stroke-width="2.4"
      opacity="0.2"
    />
    <path
      d="M21 12a9 9 0 0 0-9-9"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
    />
  </svg>
  <span class="text-[12px]">{label}</span>
</div>
