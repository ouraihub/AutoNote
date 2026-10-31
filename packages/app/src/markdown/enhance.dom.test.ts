import { expect, test } from 'vitest'
import { PreviewEnhancer, enhancePreview } from './enhance'
import type { RenderServices } from './embeds'

const services: RenderServices = {
  resolveNote: async (target) =>
    target === 'Loop'
      ? { id: 'loop', title: 'Loop', content: '![[Loop]]' }
      : target === 'Child'
        ? { id: 'child', title: 'Child', content: 'Resolved child' }
        : null,
  resolveAssetUrl: (url) => url,
  openNote: () => {},
  toggleTask: async () => {},
}

test('keeps math source readable when optional math enhancement is disabled', async () => {
  const root = document.createElement('div')
  root.innerHTML = '<span class="math-inline" data-math="b64.eF4y"></span>'

  await enhancePreview(root, options())

  expect(root.textContent).toBe('$x^2$')
  expect(root.querySelector('.math-source')).toBeTruthy()
})

test('resolves bounded note embeds and stops a circular embed', async () => {
  const root = document.createElement('div')
  root.innerHTML =
    '<div data-embed-target="Child"></div><div data-embed-target="Loop"></div>'

  await enhancePreview(root, options())

  expect(root.textContent).toContain('Resolved child')
  expect(root.textContent).toContain('Circular embed')
})

test('does not mutate a stale preview after its signal aborts', async () => {
  const root = document.createElement('div')
  root.innerHTML =
    '<div class="code-block" data-lang="typescript"><pre><code>const value = 1</code></pre></div>'
  const controller = new AbortController()
  const enhancer = new PreviewEnhancer()

  const pending = enhancer.enhance(root, {
    ...options(controller.signal),
    math: false,
    mermaid: false,
  })
  controller.abort()
  enhancer.invalidate()
  await pending

  expect(root.querySelector('code')?.textContent).toBe('const value = 1')
})

function options(signal: AbortSignal = new AbortController().signal) {
  return { services, signal, math: false, mermaid: false, dark: false }
}
