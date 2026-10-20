<script lang="ts">
  import type { WorkspacePanelProps } from '@app/root/types'
  import { getI18n } from '@app/root/context'
  const i18n = getI18n()
  let { saveNote }: WorkspacePanelProps = $props()
  let error = $state('')
  const markdown = '# Saved reply\n\n- body\n- retained'
  async function save() {
    try {
      await saveNote(markdown, [
        { mime: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=' },
        { mime: 'image/png', url: null },
      ])
    } catch {
      error = i18n.t('common.save_failed')
    }
  }
</script>

<button onclick={() => void save()}>{i18n.t('common.save')}</button>
{#if error}<p role="alert">{error}</p>{/if}
