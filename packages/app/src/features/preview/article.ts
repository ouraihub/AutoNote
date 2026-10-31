import type { I18nState } from '../../i18n/runtime.svelte'
import type { UiState } from '../../state/ui.svelte'
import type { Notifier } from '../../platform/notifier'
import type { RenderServices } from '../../markdown/embeds'
import { decodeDataValue } from '../../markdown/data-attr'

export type ArticleState = Map<string, string>
export interface ArticleOptions {
  noteId: string
  services: RenderServices
  i18n: Pick<I18nState, 't'>
  collapseLines: number
  state?: ArticleState
  publicReadonly?: boolean
  resolveResourcesBeforeInsert?: boolean
}
export interface ArticleInteractionOptions {
  services: RenderServices
  source(): string
  renderedSource: string
  i18n: Pick<I18nState, 't'>
  notifier: Notifier
  onImage?(image: HTMLImageElement): void
  onTag?(tag: string): void
  publicReadonly?: boolean
}
let articleSequence = 0
const lightboxFocus = new WeakMap<UiState, HTMLElement>()
export function rememberLightboxFocus(ui: UiState, element: HTMLElement): void {
  lightboxFocus.set(ui, element)
}
export function restoreLightboxFocus(ui: UiState): void {
  const element = lightboxFocus.get(ui)
  if (element?.isConnected) element.focus()
  lightboxFocus.delete(ui)
}

export function previewSourceAnchors(root: HTMLElement): HTMLElement[] {
  const content = root.matches('[data-preview-content]')
    ? root
    : root.querySelector<HTMLElement>('[data-preview-content]')
  return content
    ? [...content.children].filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement && child.hasAttribute('data-line'),
      )
    : []
}

export function selectMarkdownTab(button: HTMLButtonElement): void {
  const tabs = button.closest<HTMLElement>('[data-tabs]')
  if (!tabs) return
  for (const candidate of tabs.querySelectorAll<HTMLButtonElement>(
    '[data-tab-button]',
  )) {
    if (candidate.closest('[data-tabs]') !== tabs) continue
    candidate.setAttribute('aria-selected', String(candidate === button))
    candidate.tabIndex = candidate === button ? 0 : -1
  }
  for (const panel of tabs.querySelectorAll<HTMLElement>('[data-tab-panel]')) {
    if (panel.closest('[data-tabs]') === tabs)
      panel.hidden = panel.dataset.tabPanel !== button.dataset.tabButton
  }
}

export function captureArticleState(root: HTMLElement): ArticleState {
  const state: ArticleState = new Map()
  for (const element of root.querySelectorAll<HTMLElement>(
    '[data-preview-key]',
  )) {
    const key = element.dataset.previewKey!
    if (element instanceof HTMLDetailsElement)
      state.set(key, String(element.open))
    else if (element.matches('[data-tabs]'))
      state.set(
        key,
        element.querySelector<HTMLElement>('[aria-selected="true"]')?.dataset
          .tabButton ?? '0',
      )
    else if (element.matches('.code-block'))
      state.set(key, String(element.classList.contains('is-code-expanded')))
  }
  return state
}

function setCodeExpanded(
  block: HTMLElement,
  expanded: boolean,
  i18n: Pick<I18nState, 't'>,
): void {
  block.classList.toggle('is-code-expanded', expanded)
  const button = block.querySelector<HTMLButtonElement>('[data-code-collapse]')
  if (button) {
    button.setAttribute('aria-expanded', String(expanded))
    button.textContent = expanded
      ? i18n.t('common.collapse')
      : i18n.t('workspace.preview.expand_code')
  }
}

export function prepareArticle(
  root: HTMLElement,
  options: ArticleOptions,
): void {
  const prefix = `preview-${++articleSequence}`
  const occurrences = new Map<string, number>()
  let tabSequence = 0
  for (const element of root.querySelectorAll<HTMLElement>(
    '.code-block, details, [data-tabs]',
  )) {
    if (!element.dataset.previewKey) {
      const signature = element.matches('.code-block')
        ? element.querySelector('code')?.textContent
        : element.matches('details')
          ? element.querySelector('summary')?.textContent
          : [...element.querySelectorAll('[data-tab-button]')]
              .map((button) => button.textContent)
              .join('|')
      const identity = `${element.tagName}:${element.dataset.line ?? ''}:${signature ?? ''}`
      const occurrence = occurrences.get(identity) ?? 0
      occurrences.set(identity, occurrence + 1)
      element.dataset.previewKey = `${options.noteId}:${identity}:${occurrence}`
    }
    const saved = options.state?.get(element.dataset.previewKey)
    if (element instanceof HTMLDetailsElement && saved !== undefined)
      element.open = saved === 'true'
    if (element.matches('[data-tabs]')) {
      const id = `${prefix}-${++tabSequence}`
      for (const button of element.querySelectorAll<HTMLButtonElement>(
        '[data-tab-button]',
      )) {
        if (button.closest('[data-tabs]') !== element) continue
        const index = button.dataset.tabButton
        button.id = `${id}-tab-${index}`
        button.setAttribute('aria-controls', `${id}-panel-${index}`)
        const panel = [
          ...element.querySelectorAll<HTMLElement>('[data-tab-panel]'),
        ].find(
          (candidate) =>
            candidate.closest('[data-tabs]') === element &&
            candidate.dataset.tabPanel === index,
        )
        if (panel) {
          panel.id = `${id}-panel-${index}`
          panel.setAttribute('aria-labelledby', button.id)
        }
      }
      const selected = [
        ...element.querySelectorAll<HTMLButtonElement>('[data-tab-button]'),
      ].find(
        (button) =>
          button.dataset.tabButton === saved &&
          button.closest('[data-tabs]') === element,
      )
      if (selected) selectMarkdownTab(selected)
    }
    if (
      element.matches('.code-block') &&
      element.querySelector('pre') &&
      !element.querySelector('[data-copy]')
    ) {
      const copy = document.createElement('button')
      copy.type = 'button'
      copy.dataset.copy = ''
      copy.textContent = options.i18n.t('common.copy')
      element.prepend(copy)
      if (element.dataset.codeTitle) {
        const title = document.createElement('span')
        title.className = 'code-title'
        title.textContent = element.dataset.codeTitle
        element.prepend(title)
      }
      const lines = (element.querySelector('code')?.textContent ?? '').split(
        '\n',
      ).length
      if (options.collapseLines > 0 && lines > options.collapseLines) {
        element.classList.add('is-code-collapsible')
        element.style.setProperty(
          '--code-collapse-lines',
          String(options.collapseLines),
        )
        const collapse = document.createElement('button')
        collapse.type = 'button'
        collapse.dataset.codeCollapse = ''
        element.append(collapse)
        setCodeExpanded(element, saved === 'true', options.i18n)
      }
    }
  }
  for (const task of root.querySelectorAll<HTMLElement>('[role="checkbox"]')) {
    if (
      options.publicReadonly ||
      task.closest('[data-embed-target], [data-markdown-example]')
    ) {
      task.setAttribute('aria-disabled', 'true')
      task.tabIndex = -1
    } else
      task.setAttribute(
        'aria-label',
        task.closest('li')?.textContent?.trim() ?? '',
      )
  }
  if (options.publicReadonly) {
    for (const element of root.querySelectorAll<HTMLElement>(
      '[data-wikilink], [data-embed-target], [data-tag]',
    )) {
      element.setAttribute('aria-disabled', 'true')
      element.tabIndex = -1
      if (element instanceof HTMLAnchorElement) element.removeAttribute('href')
    }
  }
  for (const image of root.querySelectorAll<HTMLImageElement>('img')) {
    const raw = image.getAttribute('src') ?? ''
    if (!image.dataset.assetResolved) {
      const url = options.services.resolveAssetUrl(raw)
      if (
        !/^(?:https?:|blob:|data:image\/(?:png|gif|jpeg|webp|avif);|\/|\.?\.\/)/i.test(
          url.trim(),
        ) &&
        /^[a-z][a-z\d+.-]*:/i.test(url.trim())
      )
        image.removeAttribute('src')
      else image.src = url
      image.dataset.assetResolved = 'true'
    }
    image.tabIndex = 0
    image.setAttribute('role', 'button')
    image.setAttribute(
      'aria-label',
      image.alt || options.i18n.t('preview.image_preview'),
    )
  }
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (/^https?:/i.test(link.href)) {
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
    }
  }
}

export function bindArticleInteractions(
  root: HTMLElement,
  options: ArticleInteractionOptions,
): () => void {
  let active = true
  const timers = new Set<number>()
  function click(event: Event): void {
    if (!(event.target instanceof Element)) return
    const target = event.target
    const task = target.closest<HTMLElement>(
      '[role="checkbox"][data-task-line]',
    )
    if (task) {
      event.preventDefault()
      if (
        options.publicReadonly ||
        task.closest('[data-embed-target], [data-markdown-example]') ||
        task.getAttribute('aria-disabled') === 'true'
      )
        return
      if (options.source() !== options.renderedSource) {
        options.notifier.toast({
          key: 'preview.the_preview_is_updating_try_again_in_a_moment',
          tone: 'warning',
        })
        return
      }
      const checked = task.getAttribute('aria-checked') !== 'true'
      void options.services
        .toggleTask(Number(task.dataset.taskLine), checked)
        .then(() => {
          if (!active) return
          task.setAttribute('aria-checked', String(checked))
          task.closest('li')?.classList.toggle('done', checked)
        })
        .catch(() =>
          options.notifier.toast({
            key: 'preview.could_not_update_this_task',
            tone: 'warning',
          }),
        )
      return
    }
    const tab = target.closest<HTMLButtonElement>('[data-tab-button]')
    if (tab) {
      event.preventDefault()
      selectMarkdownTab(tab)
      return
    }
    const wiki = target.closest<HTMLElement>('[data-wikilink]')
    if (wiki) {
      event.preventDefault()
      if (options.publicReadonly) return
      const value = decodeDataValue(wiki.dataset.wikilink)
      const localId = value.startsWith('#^')
        ? `^${value.slice(2).split('|')[0]}`
        : ''
      const local = localId
        ? wiki
            .closest('[data-markdown-example]')
            ?.querySelector<HTMLElement>(`#${CSS.escape(localId)}`)
        : null
      if (local) local.scrollIntoView({ block: 'center' })
      else options.services.openNote(value)
      return
    }
    const embedHead = target.closest<HTMLElement>('.note-embed-head')
    if (embedHead) {
      if (!options.publicReadonly)
        options.services.openNote(
          decodeDataValue(embedHead.parentElement?.dataset.embedTarget),
        )
      return
    }
    const tag = target.closest<HTMLElement>('[data-tag]')
    if (tag) {
      if (!options.publicReadonly)
        options.onTag?.(decodeDataValue(tag.dataset.tag))
      return
    }
    const copy = target.closest<HTMLButtonElement>('[data-copy]')
    if (copy) {
      const code =
        copy.closest('.code-block')?.querySelector('pre')?.textContent ?? ''
      void (async () => {
        await navigator.clipboard.writeText(code)
        if (!active) return
        copy.textContent = options.i18n.t('common.copied')
        const timer = window.setTimeout(() => {
          timers.delete(timer)
          if (active) copy.textContent = options.i18n.t('common.copy')
        }, 900)
        timers.add(timer)
      })().catch(() =>
        options.notifier.toast({
          key: 'preview.could_not_copy',
          tone: 'error',
        }),
      )
      return
    }
    const collapse = target.closest<HTMLButtonElement>('[data-code-collapse]')
    const block = collapse?.closest<HTMLElement>('.code-block')
    if (block) {
      setCodeExpanded(
        block,
        !block.classList.contains('is-code-expanded'),
        options.i18n,
      )
      return
    }
    const image = target.closest<HTMLImageElement>('img')
    if (image?.getAttribute('src')) {
      event.preventDefault()
      options.onImage?.(image)
      return
    }
    const anchor = target.closest<HTMLAnchorElement>('a')
    if (anchor?.getAttribute('href')?.startsWith('#')) {
      event.preventDefault()
      let id: string
      try {
        id = decodeURIComponent(anchor.getAttribute('href')!.slice(1))
      } catch {
        return
      }
      root
        .querySelector<HTMLElement>(`#${CSS.escape(id)}`)
        ?.scrollIntoView({ block: 'start' })
    }
  }
  function keydown(event: KeyboardEvent): void {
    if (!(event.target instanceof HTMLElement)) return
    const tab = event.target.closest<HTMLButtonElement>('[data-tab-button]')
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const buttons = [
        ...tab
          .closest('[role="tablist"]')!
          .querySelectorAll<HTMLButtonElement>('[data-tab-button]'),
      ]
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (buttons.indexOf(tab) +
                (event.key === 'ArrowRight' ? 1 : -1) +
                buttons.length) %
              buttons.length
      const next = buttons[index]
      if (next) {
        selectMarkdownTab(next)
        next.focus()
      }
    } else if (
      ['Enter', ' '].includes(event.key) &&
      event.target.matches('[role="checkbox"], [data-tag], img[role="button"]')
    ) {
      event.preventDefault()
      event.target.click()
    }
  }
  root.addEventListener('click', click)
  root.addEventListener('keydown', keydown)
  return () => {
    active = false
    root.removeEventListener('click', click)
    root.removeEventListener('keydown', keydown)
    for (const timer of timers) window.clearTimeout(timer)
  }
}
