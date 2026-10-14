import { Globe, Sparkles } from '@lucide/svelte'
import type { Backend } from '@app/backend'
import type { HostExtensions } from '@app/root'
import AiSection from './settings/AiSection.svelte'
import SearchSection from './settings/SearchSection.svelte'
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
      ...(backend.aiHost.kit.search
        ? [
            {
              id: 'web-search',
              order: 29,
              titleKey: 'ai.search_title' as const,
              icon: Globe,
              canShow: () => true,
              component: SearchSection,
            },
          ]
        : []),
    ],
    aboutPanels: [],
    workspacePanel: { titleKey: 'chat.title', icon: Sparkles, component: ChatPanel },
    writingToolbar: { component: WritingToolbar },
  }
}
