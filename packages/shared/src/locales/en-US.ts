import { EN_US_01 } from './en-US-01'
import { EN_US_02 } from './en-US-02'
import { EN_US_03 } from './en-US-03'
import { EN_US_04 } from './en-US-04'
import { EN_US_05 } from './en-US-05'
import { EN_US_06 } from './en-US-06'
import { EN_US_07 } from './en-US-07'

export const EN_US_MESSAGES = {
  ...EN_US_01,
  ...EN_US_02,
  ...EN_US_03,
  ...EN_US_04,
  ...EN_US_05,
  ...EN_US_06,
  ...EN_US_07,
} as const
export type MessageKey = keyof typeof EN_US_MESSAGES
