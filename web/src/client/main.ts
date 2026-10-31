import { mount } from 'svelte'
import { ConsoleRingLogger } from './log'
import '@app/styles/shell.css'
import App from './App.svelte'
import { parseRoute } from './router'
import { createWebServices } from './runtime'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import { ZH_CN_MESSAGES } from '@shared/locales/zh-CN'
const target = document.getElementById('app')
if (!target) throw new Error('Missing #app mount point')

const route = parseRoute(location.pathname, import.meta.env.DEV)
// Static importing the dev-only gallery would put it into the production
// application chunk.
if (route.kind === 'gallery') {
  const { default: Gallery } = await import('@app/gallery/Gallery.svelte')
  mount(Gallery, { target })
} else {
  try {
    const services = await createWebServices()
    mount(App, { target, props: { services } })
  } catch {
    new ConsoleRingLogger().error('host.lifecycle.failed', { code: 'internal' })
    const messages = globalThis.navigator.language.startsWith('zh')
      ? ZH_CN_MESSAGES
      : EN_US_MESSAGES
    const section = document.createElement('section')
    section.setAttribute('role', 'alert')
    const message = document.createElement('p')
    message.textContent = messages['common.action_failed']
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = messages['common.retry']
    retry.onclick = () => location.reload()
    section.append(message, retry)
    target.replaceChildren(section)
  }
}
