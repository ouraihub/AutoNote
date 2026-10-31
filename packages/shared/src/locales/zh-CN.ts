import type { MessageKey } from './en-US'
import { ZH_CN_01 } from './zh-CN-01'
import { ZH_CN_02 } from './zh-CN-02'
import { ZH_CN_03 } from './zh-CN-03'
import { ZH_CN_04 } from './zh-CN-04'
import { ZH_CN_05 } from './zh-CN-05'
import { ZH_CN_06 } from './zh-CN-06'
import { ZH_CN_07 } from './zh-CN-07'

export const ZH_CN_MESSAGES = {
  ...ZH_CN_01,
  ...ZH_CN_02,
  ...ZH_CN_03,
  ...ZH_CN_04,
  ...ZH_CN_05,
  ...ZH_CN_06,
  ...ZH_CN_07,
} as const satisfies Record<MessageKey, string>
