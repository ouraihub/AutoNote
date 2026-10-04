import { expect, test } from 'vitest'
import { BackendError } from '@app/backend/errors'
import { errorFromResponse, offlineError, toBackendError } from './errors'

test('安全提取冲突 server 和删除游标 details', () => {
  const note = {
    id: '0123456789abcdefghjkmnpqrs',
    title: 'title',
    excerpt: 'excerpt',
    folderId: null,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 1,
    charCount: 1,
    rev: 2,
    position: 0,
    createdAt: 1,
    updatedAt: 2,
    deletedAt: null,
    content: 'body',
  }
  const response = new Response(null, { status: 409 })
  const error = errorFromResponse(response, {
    error: {
      code: 'conflict',
      message: 'conflict',
      details: { server: note, deletionCursor: 4, retryAfter: 2, cause: 'secret' },
    },
  })
  expect(error).toBeInstanceOf(BackendError)
  expect(error.details).toEqual({ server: note, deletionCursor: 4, retryAfter: 2 })
})

test('未知 code 不透传 details，HTML 错误按状态回退', () => {
  const unknown = errorFromResponse(new Response(null, { status: 500 }), {
    error: { code: 'database_path', message: 'safe message', details: { cause: '/secret' } },
  })
  expect(unknown.code).toBe('internal')
  expect(unknown.details).toBeUndefined()
  expect(errorFromResponse(new Response('<html>', { status: 401 })).code).toBe('unauthenticated')
})

test('超时、调用方取消和网络离线保持不同 code', () => {
  expect(toBackendError(new DOMException('aborted', 'AbortError'), { timedOut: true }).code).toBe('request_timeout')
  expect(toBackendError(new DOMException('aborted', 'AbortError'), { cancelled: true }).code).toBe('cancelled')
  expect(toBackendError(new TypeError('Failed to fetch')).code).toBe('offline')
  expect(offlineError().code).toBe('offline')
})
