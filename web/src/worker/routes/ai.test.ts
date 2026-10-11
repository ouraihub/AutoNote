import { expect, it } from 'vitest'
import { extractDelta, normalizeBaseUrl, writeSystem } from './ai'

it('uses one /v1 path for bare, trailing-slash, and previously saved URLs', () => {
  expect(normalizeBaseUrl('https://api.fenno.ai')).toBe('https://api.fenno.ai/v1')
  expect(normalizeBaseUrl('https://api.fenno.ai/')).toBe('https://api.fenno.ai/v1')
  expect(normalizeBaseUrl('https://api.fenno.ai//v1')).toBe('https://api.fenno.ai/v1')
  expect(normalizeBaseUrl('https://api.fenno.ai/v1')).toBe('https://api.fenno.ai/v1')
})

it('retains whitespace-only and surrounding spaces from streamed model text', () => {
  expect(extractDelta('openai-chat', 'data: {"choices":[{"delta":{"content":" first "}}]}')).toBe(' first ')
  expect(extractDelta('openai-chat', 'data: {"choices":[{"delta":{"content":" "}}]}')).toBe(' ')
  expect(extractDelta('openai-chat', 'data: {"choices":[{"delta":{"content":"\\n"}}]}')).toBe('\n')
})

it('asks for the selected UI language and uses continuation rather than polishing when no text is selected', () => {
  const continuation = writeSystem({ action: 'continue', noteId: 'note', selectedText: '', beforeText: '秋天来了。', afterText: '', cursorOffset: 5, language: 'zh-CN', title: '' })
  expect(continuation).toContain('Continue writing naturally')
  expect(continuation).toContain('Write in Simplified Chinese')
  expect(continuation).not.toContain('Polish')
  expect(writeSystem({ action: 'polish', noteId: 'note', selectedText: 'Hello.', beforeText: '', afterText: '', cursorOffset: 0, language: 'en-US', title: '' })).toContain('Write in English')
})
