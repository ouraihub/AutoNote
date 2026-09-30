import { describe, expect, test } from 'vitest'
import { ThemeController, resolveTheme } from './apply'
import type { MediaQueryLike } from './apply'

class MediaQueryStub implements MediaQueryLike {
  matches: boolean
  #listeners = new Set<() => void>()

  constructor(matches: boolean) {
    this.matches = matches
  }

  addEventListener(_type: 'change', listener: () => void): void {
    this.#listeners.add(listener)
  }

  removeEventListener(_type: 'change', listener: () => void): void {
    this.#listeners.delete(listener)
  }

  change(matches: boolean): void {
    this.matches = matches
    for (const listener of this.#listeners) listener()
  }
}

describe('ThemeController', () => {
  test('tracks system theme and releases both media listeners on disposal', () => {
    const root = document.createElement('html')
    const dark = new MediaQueryStub(false)
    const motion = new MediaQueryStub(false)
    const controller = new ThemeController(
      { documentElement: root },
      { theme: 'system', accent: 'cinnabar', background: 'paper' },
      dark,
      motion,
    )

    dark.change(true)
    motion.change(true)
    expect(root.dataset).toMatchObject({ theme: 'dark', accent: 'cinnabar', background: 'paper', motion: 'reduced' })

    controller.dispose()
    dark.change(false)
    motion.change(false)
    expect(root.dataset).toMatchObject({ theme: 'dark', motion: 'reduced' })
  })

  test('uses explicit themes over the system preference', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})
