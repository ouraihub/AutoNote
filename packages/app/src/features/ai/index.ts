import { Sparkles } from '@lucide/svelte'
import type { BackendCapabilities } from '@app/backend'
import type { HostExtensions } from '@app/root'
import AiSection from './settings/AiSection.svelte'
import ChatPanel from './chat/ChatPanel.svelte'
import WritingToolbar from './writing/WritingToolbar.svelte'

export { default as AiSection } from './settings/AiSection.svelte'
export { default as ChatPanel } from './chat/ChatPanel.svelte'
export { default as WritingToolbar } from './writing/WritingToolbar.svelte'
export { default as EndpointCard } from './settings/EndpointCard.svelte'
export { default as ModelPickerDialog } from './settings/ModelPickerDialog.svelte'
export { ChatSession } from './chat/chat-session.svelte'
export function aiHostExtensions(
  capabilities: Pick<BackendCapabilities, 'ai'>,
  settingsId = 'ai',
): HostExtensions {
  if (!capabilities.ai) return { settingsSections: [], aboutPanels: [] }
  return {
    settingsSections: [
      {
        id: settingsId,
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
