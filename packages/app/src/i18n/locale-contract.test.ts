import { expect, test } from 'vitest'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import { ZH_CN_MESSAGES } from '@shared/locales/zh-CN'

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g

test('keeps locale keys and interpolation placeholders aligned', () => {
  const englishKeys = Object.keys(EN_US_MESSAGES).sort()
  const chineseKeys = Object.keys(ZH_CN_MESSAGES).sort()

  expect(chineseKeys).toEqual(englishKeys)

  for (const key of englishKeys) {
    const english = EN_US_MESSAGES[key as keyof typeof EN_US_MESSAGES]
    const chinese = ZH_CN_MESSAGES[key as keyof typeof ZH_CN_MESSAGES]
    expect([...english.matchAll(PLACEHOLDER)].map((match) => match[1]).sort()).toEqual(
      [...chinese.matchAll(PLACEHOLDER)].map((match) => match[1]).sort(),
    )
  }
})
