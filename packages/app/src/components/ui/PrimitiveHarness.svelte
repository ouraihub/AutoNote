<script lang="ts">
  import { Button } from './button'
  import { Input } from './input'
  import { Checkbox } from './checkbox'
  import { Switch } from './switch'
  import { Slider } from './slider'
  import { Segmented } from './segmented'
  import * as Field from './field'

  let saves = $state(0)
  let enabled = $state(false)
  let layout = $state('split')
  let autosave = $state(false)
  let fontSize = $state(14)
</script>

<Field.Group class="max-w-sm">
  <Field.Field>
    <Input id="note-title" aria-label="Note title" />
  </Field.Field>
  <Field.Field orientation="horizontal">
    <Checkbox id="enable-notes" bind:checked={enabled} />
    <Field.Label for="enable-notes">Enable notes</Field.Label>
  </Field.Field>
  <Field.Field orientation="horizontal">
    <Button onclick={() => (saves += 1)}>Save changes</Button>
    <Button disabled>Disabled action</Button>
  </Field.Field>
  <p aria-live="polite">Saved {saves} time{saves === 1 ? '' : 's'}</p>
  <Field.Field orientation="horizontal">
    <Switch id="autosave" bind:checked={autosave} />
    <Field.Label for="autosave">Autosave notes</Field.Label>
  </Field.Field>
  <Field.Field>
    <Field.Label for="layout">Editor layout</Field.Label>
    <Segmented
      ariaLabel="Editor layout"
      options={[
        { value: 'live', label: 'Live' },
        { value: 'split', label: 'Split' },
        { value: 'preview', label: 'Preview' },
      ]}
      bind:value={layout}
    />
  </Field.Field>
  <Field.Field>
    <Field.Label id="font-size-label" for="font-size">Font size</Field.Label>
    <Slider id="font-size" aria-labelledby="font-size-label" type="single" bind:value={fontSize} min={12} max={18} step={1} />
  </Field.Field>
</Field.Group>
