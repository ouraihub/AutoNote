import { expect, it } from 'vitest'
import { HttpSettingsPort } from './settings'
import type { HttpTransport } from '../transport'
import type { TabMessage } from '../tab-bus'
import type { UserSettings } from '@shared/types'

it('broadcasts only confirmed settings with the real client identity', async () => {
  const messages: TabMessage[] = []
  let finish!: (value: UserSettings) => void
  const port = new HttpSettingsPort({
    transport: {
      json: () =>
        new Promise<UserSettings>((resolve) => {
          finish = resolve
        }),
    } as unknown as HttpTransport,
    bus: { post: (message) => messages.push(message), subscribe: () => () => undefined, close() {} },
    clientId: 'actual-tab',
  })
  const pending = port.save({ appearance: { theme: 'dark' } })
  expect(messages).toEqual([])
  finish({ appearance: { theme: 'dark' } } as UserSettings)
  await pending
  expect(messages).toEqual([{ type: 'settings-changed', clientId: 'actual-tab' }])
})
