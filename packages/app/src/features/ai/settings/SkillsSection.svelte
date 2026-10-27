<script lang="ts">
  import { SkillsSettings } from '@ouraihub/aether-ui/skills'
  import { getI18n } from '@app/root/context'

  const i18n = getI18n()
</script>

<div class="space-y-4">
  <p class="text-[12px] text-[var(--warning)]">{i18n.t('ai.skills_runner_warning')}</p>
  <SkillsSettings />
</div>
