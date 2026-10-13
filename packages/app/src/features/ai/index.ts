import { Sparkles } from '@lucide/svelte'
import type { Backend } from '@app/backend'
import type { HostExtensions } from '@app/root'
import AiSection from './settings/AiSection.svelte'
import ChatPanel from './chat/ChatPanel.svelte'
import WritingToolbar from './writing/WritingToolbar.svelte'

export function aiHostExtensions(backend: Pick<Backend, 'aiHost'>): HostExtensions {
  if (!backend.aiHost) return { settingsSections: [], aboutPanels: [] }
  return {
    settingsSections: [
      {
        id: 'ai',
        order: 28,
        titleKey: 'ai.settings_title',
        icon: Sparkles,
        canShow: () => true,
        component: AiSection,
      },
    ],
    aboutPanels: [],
    workspacePanel: { titleKey: 'chat.title', icon: Sparkles, component: ChatPanel },
    writingToolbar: { component: WritingToolbar },
  }
}
