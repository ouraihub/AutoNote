<script lang="ts">
  import * as ToggleGroup from '../toggle-group'

  export interface SegmentedOption {
    readonly value: string
    readonly label: string
    readonly disabled?: boolean
  }

  interface Props {
    readonly ariaLabel: string
    readonly options: readonly SegmentedOption[]
    readonly disabled?: boolean
    value?: string
  }

  let {
    ariaLabel,
    options,
    disabled = false,
    value = $bindable(''),
  }: Props = $props()
</script>

<ToggleGroup.Root
  type="single"
  variant="outline"
  size="sm"
  bind:value
  {disabled}
  aria-label={ariaLabel}
>
  {#each options as option (option.value)}
    <ToggleGroup.Item value={option.value} disabled={option.disabled ?? false}
      >{option.label}</ToggleGroup.Item
    >
  {/each}
</ToggleGroup.Root>
