<script lang="ts">
  import { SPLIT_RATIO_RANGE } from '../../state/layout-prefs'

  let { ratio, label, onChange, onReset }: {
    ratio: number; label: string
    onChange: (ratio: number) => void; onReset: () => void
  } = $props()

  function update(event: Event): void {
    const value = Number((event.currentTarget as HTMLInputElement).value) / 100
    onChange(Math.min(SPLIT_RATIO_RANGE.max, Math.max(SPLIT_RATIO_RANGE.min, value)))
  }
</script>

<input type="range" min="20" max="80" step="1" value={Math.round(ratio * 100)} aria-label={label} class="split-resizer" oninput={update} ondblclick={onReset} />

<style>
  .split-resizer { position: relative; flex: 0 0 1px; width: 1px; padding: 0 4px; background: var(--border-subtle); cursor: col-resize; touch-action: none; appearance: none; }
  .split-resizer::-webkit-slider-runnable-track { height: 100%; background: var(--border-subtle); }
  .split-resizer::-webkit-slider-thumb { width: 9px; height: 100%; border: 0; border-radius: 0; background: transparent; cursor: col-resize; appearance: none; }
  .split-resizer::-moz-range-track { height: 100%; background: var(--border-subtle); }
  .split-resizer::-moz-range-thumb { width: 9px; height: 100%; border: 0; border-radius: 0; background: transparent; cursor: col-resize; }
  .split-resizer:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
