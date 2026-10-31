import { expect, test, vi } from 'vitest'
import { welcomeNoteContent } from '@shared/welcome-notes'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import { renderMarkdown } from '../../markdown/renderer'
import { PreviewEnhancer } from '../../markdown/enhance'
import type { RenderServices, ResolvedNote } from '../../markdown/embeds'
import type { I18nState } from '../../i18n/runtime.svelte'
import {
  bindArticleInteractions,
  captureArticleState,
  prepareArticle,
  selectMarkdownTab,
} from './article'
import { updateTaskAtSourceLine } from './services'

const i18n = {
  t: (key: keyof typeof EN_US_MESSAGES) => EN_US_MESSAGES[key],
} as I18nState
const services: RenderServices = {
  resolveNote: async () => null,
  resolveAssetUrl: (url) => url,
  openNote: () => {},
  toggleTask: async () => {},
}

test('consumer task clicks preserve exact CRLF source lines and reject embedded/example/stale tasks; tabs restore only their note', async () => {
  const source =
    '---\r\ntitle: Tasks\r\n---\r\n- [ ] Host\r\n  - [ ] Nested\r\n\r\n::: details [Fold]\r\n- [ ] Folded\r\n:::\r\n\r\n:::: tabs\r\n::: tab-item One\r\n- [ ] Tab task\r\n:::\r\n::: tab-item Two\r\nOther\r\n:::\r\n::::\r\n'
  const root = document.createElement('article')
  root.innerHTML = renderMarkdown(source).html
  expect(
    [...root.querySelectorAll<HTMLElement>('[role="checkbox"]')].map((task) =>
      Number(task.dataset.taskLine),
    ),
  ).toEqual([3, 4, 7, 12])
  let latest = source
  const toggleTask = vi.fn(async (line: number, checked: boolean) => {
    latest = updateTaskAtSourceLine(source, line, checked)!
  })
  prepareArticle(root, { noteId: 'a', services, i18n, collapseLines: 0 })
  const notifier = { toast: vi.fn(), confirm: async () => false }
  const cleanup = bindArticleInteractions(root, {
    services: { ...services, toggleTask },
    source: () => latest,
    renderedSource: source,
    i18n,
    notifier,
  })
  root
    .querySelector<HTMLElement>('[data-task-line="4"][role="checkbox"]')!
    .click()
  await Promise.resolve()
  expect(latest).toBe(source.replace('  - [ ] Nested', '  - [x] Nested'))
  expect(latest.split('\r\n')[3]).toBe('- [ ] Host')
  expect(updateTaskAtSourceLine(source, 7, true)).toBe(
    source.replace('- [ ] Folded', '- [x] Folded'),
  )
  expect(updateTaskAtSourceLine(source, 12, true)).toBe(
    source.replace('- [ ] Tab task', '- [x] Tab task'),
  )
  const embedded = document.createElement('div')
  embedded.dataset.embedTarget = 'Child'
  embedded.innerHTML = renderMarkdown('- [ ] Embedded').html
  root.append(embedded)
  embedded.querySelector<HTMLElement>('[role="checkbox"]')!.click()
  const example = document.createElement('section')
  example.dataset.markdownExample = ''
  example.innerHTML = renderMarkdown('- [ ] Example').html
  root.append(example)
  example.querySelector<HTMLElement>('[role="checkbox"]')!.click()
  root
    .querySelector<HTMLElement>('[data-task-line="3"][role="checkbox"]')!
    .click()
  expect(toggleTask).toHaveBeenCalledTimes(1)
  expect(notifier.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      key: 'preview.the_preview_is_updating_try_again_in_a_moment',
    }),
  )
  const second =
    root.querySelectorAll<HTMLButtonElement>('[data-tab-button]')[1]!
  selectMarkdownTab(second)
  expect(root.querySelector<HTMLElement>('[data-tab-panel="0"]')!.hidden).toBe(
    true,
  )
  const state = captureArticleState(root)
  root.innerHTML = renderMarkdown(source).html
  prepareArticle(root, { noteId: 'a', services, i18n, collapseLines: 0, state })
  expect(
    root.querySelector('[data-tab-button="1"]')?.getAttribute('aria-selected'),
  ).toBe('true')
  root.innerHTML = renderMarkdown(source).html
  prepareArticle(root, { noteId: 'b', services, i18n, collapseLines: 0, state })
  expect(
    root.querySelector('[data-tab-button="0"]')?.getAttribute('aria-selected'),
  ).toBe('true')
  cleanup()
})

test('an aborted embed cannot insert its late response into the next note and embedded math is enhanced', async () => {
  const pending = Promise.withResolvers<ResolvedNote | null>()
  const root = document.createElement('article')
  root.innerHTML = renderMarkdown('![[Child]]').html
  const enhancer = new PreviewEnhancer()
  const controller = new AbortController()
  const first = enhancer.enhance(root, {
    services: { ...services, resolveNote: () => pending.promise },
    signal: controller.signal,
    math: false,
    mermaid: false,
    dark: false,
  })
  controller.abort()
  enhancer.invalidate()
  root.innerHTML = renderMarkdown('# Second note').html
  pending.resolve({ id: 'child', title: 'Child', content: 'Late child' })
  await first
  expect(root.textContent).toContain('Second note')
  expect(root.textContent).not.toContain('Late child')
  root.innerHTML = renderMarkdown('![[Child]]').html
  await enhancer.enhance(root, {
    services: {
      ...services,
      resolveNote: async () => ({
        id: 'child',
        title: 'Child',
        content: '$x^2$\n\n- [ ] Child task',
      }),
    },
    signal: new AbortController().signal,
    math: false,
    mermaid: false,
    dark: false,
  })
  expect(root.querySelector('.math-source')?.textContent).toBe('$x^2$')
  expect(
    root.querySelector('[role="checkbox"]')?.getAttribute('aria-disabled'),
  ).toBe('true')
})

test('the real welcome note exposes modern containers and safe copyable examples including local block embeds', async () => {
  const source = welcomeNoteContent('en-US')
  const root = document.createElement('article')
  root.innerHTML = renderMarkdown(source).html
  prepareArticle(root, { noteId: 'welcome', services, i18n, collapseLines: 20 })
  expect(root.querySelector('[data-tabs]')).toBeTruthy()
  expect(root.querySelectorAll('[data-tab-panel]').length).toBeGreaterThan(4)
  expect(root.querySelector('details.markdown-details')).toBeTruthy()
  expect(root.querySelector('.callout')).toBeTruthy()
  expect(root.querySelector('[id="^markdown-demo"]')).toBeTruthy()
  expect(root.querySelector('[data-copy]')).toBeTruthy()
  await new PreviewEnhancer().enhance(root, {
    services: {
      ...services,
      resolveNote: async () => ({
        id: 'welcome',
        title: 'Welcome',
        content: source,
      }),
    },
    signal: new AbortController().signal,
    math: false,
    mermaid: false,
    dark: false,
  })
  expect(root.querySelector('[data-embed-target]')?.textContent).toContain(
    'This content is embedded again below.',
  )
  expect(
    root.querySelector('a[href="https://example.com"]')?.getAttribute('rel'),
  ).toBe('noopener noreferrer')
})

test('public articles cannot write tasks or follow private links, but tabs remain interactive', async () => {
  const source =
    '- [ ] Task\n\n[[Private]]\n\n#secret\n\n:::: tabs\n::: tab-item One\nFirst\n:::\n::: tab-item Two\nSecond\n:::\n::::'
  const root = document.createElement('article')
  root.innerHTML = renderMarkdown(source).html
  const openNote = vi.fn(),
    toggleTask = vi.fn(async () => {}),
    onTag = vi.fn()
  const readonlyServices = { ...services, openNote, toggleTask }
  prepareArticle(root, {
    noteId: 'public',
    services: readonlyServices,
    i18n,
    collapseLines: 0,
    publicReadonly: true,
  })
  const cleanup = bindArticleInteractions(root, {
    services: readonlyServices,
    source: () => source,
    renderedSource: source,
    i18n,
    notifier: { toast() {}, confirm: async () => false },
    onTag,
    publicReadonly: true,
  })
  try {
    root.querySelector<HTMLElement>('[role="checkbox"]')!.click()
    root.querySelector<HTMLElement>('[data-wikilink]')!.click()
    root.querySelector<HTMLElement>('[data-tag]')!.click()
    root.querySelectorAll<HTMLButtonElement>('[data-tab-button]')[1]!.click()
    await Promise.resolve()
    expect(
      root.querySelector('[role="checkbox"]')?.getAttribute('aria-checked'),
    ).toBe('false')
    expect(
      root
        .querySelector('[data-tab-button="1"]')
        ?.getAttribute('aria-selected'),
    ).toBe('true')
    expect(openNote).not.toHaveBeenCalled()
    expect(toggleTask).not.toHaveBeenCalled()
    expect(onTag).not.toHaveBeenCalled()
  } finally {
    cleanup()
  }
})
