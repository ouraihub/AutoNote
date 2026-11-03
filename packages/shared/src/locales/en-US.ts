import { EN_US_MESSAGES_1 } from './en-US-01'
import { EN_US_MESSAGES_2 } from './en-US-02'
import { EN_US_MESSAGES_3 } from './en-US-03'
import { EN_US_MESSAGES_4 } from './en-US-04'
import { EN_US_MESSAGES_5 } from './en-US-05'
import { EN_US_MESSAGES_6 } from './en-US-06'

export const EN_US_MESSAGES = {
  ...EN_US_MESSAGES_1,
  ...EN_US_MESSAGES_2,
  ...EN_US_MESSAGES_3,
  ...EN_US_MESSAGES_4,
  ...EN_US_MESSAGES_5,
  ...EN_US_MESSAGES_6,
} as const

export type MessageKey = keyof typeof EN_US_MESSAGES
