import { describe, expect, test } from 'vitest'
import { I18nState } from './runtime.svelte'
import type { PrefValue, PrefsStore } from '@app/platform'

class MemoryPrefsStore implements PrefsStore {
  #values = new Map<string, PrefValue>()

  async load(key: string): Promise<unknown> {
    return this.#values.get(key)
  }

  async save(key: string, value: PrefValue): Promise<void> {
    this.#values.set(key, value)
  }

  async remove(key: string): Promise<void> {
    this.#values.delete(key)
  }
}

describe('I18nState', () => {
  test('keeps the newest locale when loads resolve out of order', async () => {
    const prefs = new MemoryPrefsStore()
    let resolveChinese:
      | ((messages: Readonly<Record<'app.document_title', string>>) => void)
      | undefined
    const chinese = new Promise<Readonly<Record<'app.document_title', string>>>(
      (resolve) => {
        resolveChinese = resolve
      },
    )
    const state = new I18nState({
      prefs,
      loaders: {
        'en-US': async () => ({ 'app.document_title': 'AutoNote' }) as never,
        'zh-CN': async () => chinese as never,
      },
    })

    const first = state.setLocale('zh-CN')
    await state.setLocale('en-US')
    resolveChinese?.({ 'app.document_title': '自动笔记' })
    await first

    expect(state.locale).toBe('en-US')
    expect(state.t('app.document_title')).toBe('AutoNote')
  })

  test('interpolates without replacing missing parameters', async () => {
    const state = new I18nState({
      prefs: new MemoryPrefsStore(),
      loaders: {
        'en-US': async () =>
          ({
            'app.document_title': 'AutoNote',
            'settings.value0_notes_value1': '{value0} notes, {value1}',
          }) as never,
        'zh-CN': async () => ({ 'app.document_title': '自动笔记' }) as never,
      },
    })

    await state.setLocale('en-US')

    expect(state.t('settings.value0_notes_value1', { value0: 2 })).toBe(
      '2 notes · {value1}',
    )
  })

  test('restores an already loaded language after switching back from English', async () => {
    const state = new I18nState({ prefs: new MemoryPrefsStore() })
    await state.setLocale('zh-CN')
    const chinese = state.t('common.new_note')
    await state.setLocale('en-US')
    expect(state.t('common.new_note')).not.toBe(chinese)
    await state.setLocale('zh-CN')
    expect(state.t('common.new_note')).toBe(chinese)
  })
})
