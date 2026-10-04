<script lang="ts">
  import { getI18n } from '@app/root/context'

  const i18n = getI18n()
</script>

<p>{i18n.t('settings.version_history')}</p>
