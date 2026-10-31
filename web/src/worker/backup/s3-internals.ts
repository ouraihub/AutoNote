import { AwsClient } from 'aws4fetch'
import { truncateText } from '@shared/text-utils'
import type { S3Config } from '@shared/types'
import {
  BACKUP_USER_AGENT,
  friendlyError,
  readResponseBytesWithinLimit,
} from './common'

export type S3ObjectUrl = (config: S3Config, key: string) => string

const S3_MULTIPART_PART_BYTES = 8 * 1024 * 1024
const S3_MULTIPART_PARTS_MAX = 10_000

export async function s3ArchiveMatches(
  aws: AwsClient,
  config: S3Config,
  key: string,
  expectedBytes: number,
  stamp: string,
  signal: AbortSignal | undefined,
  objectUrl: S3ObjectUrl,
): Promise<boolean> {
  const response = await aws.fetch(objectUrl(config, key), {
    method: 'HEAD',
    signal,
    redirect: 'manual',
  })
  if (response.status === 403 || response.status === 404) {
    await response.body?.cancel().catch(() => {})
    return false
  }
  if (!response.ok) throw new Error(await describeError(response, key))
  const size = Number(response.headers.get('Content-Length'))
  const storedStamp = response.headers.get('X-Amz-Meta-AutoNote-Snapshot')
  await response.body?.cancel().catch(() => {})
  return size === expectedBytes && (!storedStamp || storedStamp === stamp)
}

function archiveHeaders(stamp: string): Record<string, string> {
  return {
    'Content-Type': 'application/zip',
    'X-Amz-Meta-AutoNote-Backup': 'markdown-v3',
    'X-Amz-Meta-AutoNote-Snapshot': stamp,
    'User-Agent': BACKUP_USER_AGENT,
  }
}

export async function putArchive(
  aws: AwsClient,
  config: S3Config,
  key: string,
  body: Uint8Array,
  stamp: string,
  signal: AbortSignal | undefined,
  objectUrl: S3ObjectUrl,
): Promise<void> {
  const response = await aws.fetch(objectUrl(config, key), {
    method: 'PUT',
    body: body as unknown as BodyInit,
    headers: archiveHeaders(stamp),
    signal,
    redirect: 'manual',
  })
  if (!response.ok) throw new Error(await describeError(response, key))
  await response.body?.cancel().catch(() => {})
}

interface UploadedPart {
  partNumber: number
  etag: string
}

export async function multipartUpload(
  aws: AwsClient,
  config: S3Config,
  key: string,
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number,
  stamp: string,
  signal: AbortSignal | undefined,
  objectUrl: S3ObjectUrl,
): Promise<void> {
  let uploadId: string | null = null
  try {
    const started = await aws.fetch(
      multipartUrl(config, key, { uploads: null }, objectUrl),
      {
        method: 'POST',
        headers: archiveHeaders(stamp),
        signal,
        redirect: 'manual',
      },
    )
    if (!started.ok) throw new Error(await describeError(started, key))
    const startBody = await responseTextWithinLimit(started, 64 * 1024)
    uploadId = decodeXmlText(
      /<UploadId>([\s\S]*?)<\/UploadId>/i.exec(startBody)?.[1] ?? '',
    )
    if (!uploadId)
      throw new Error(`S3 did not return a multipart upload ID (${key})`)

    const parts: UploadedPart[] = []
    let uploadedBytes = 0
    for await (const body of streamParts(stream, S3_MULTIPART_PART_BYTES)) {
      const partNumber = parts.length + 1
      if (partNumber > S3_MULTIPART_PARTS_MAX) {
        throw new Error(
          `The backup needs more than ${S3_MULTIPART_PARTS_MAX} S3 parts`,
        )
      }
      const uploaded = await aws.fetch(
        multipartUrl(
          config,
          key,
          { partNumber: String(partNumber), uploadId },
          objectUrl,
        ),
        {
          method: 'PUT',
          body: body as unknown as BodyInit,
          headers: { 'User-Agent': BACKUP_USER_AGENT },
          signal,
          redirect: 'manual',
        },
      )
      if (!uploaded.ok) throw new Error(await describeError(uploaded, key))
      const etag = uploaded.headers.get('ETag')
      await uploaded.body?.cancel().catch(() => {})
      if (!etag)
        throw new Error(
          `S3 did not return an ETag for part ${partNumber} (${key})`,
        )
      parts.push({ partNumber, etag })
      uploadedBytes += body.byteLength
    }
    if (!parts.length) throw new Error(`The backup ZIP was empty (${key})`)
    if (uploadedBytes !== expectedBytes)
      throw new Error('The generated backup ZIP size changed')

    const completeBody = new TextEncoder().encode(
      `<CompleteMultipartUpload>${parts
        .map(
          (part) =>
            `<Part><PartNumber>${part.partNumber}</PartNumber>` +
              `<ETag>${escapeXml(part.etag)}</ETag></Part>`,
        )
        .join('')}</CompleteMultipartUpload>`,
    )
    const completed = await aws.fetch(
      multipartUrl(config, key, { uploadId }, objectUrl),
      {
        method: 'POST',
        body: completeBody as unknown as BodyInit,
        headers: {
          'Content-Type': 'application/xml',
          'User-Agent': BACKUP_USER_AGENT,
        },
        signal,
        redirect: 'manual',
      },
    )
    const completedBody = await responseTextWithinLimit(completed, 64 * 1024)
    if (!completed.ok || /<Error(?:\s|>)/i.test(completedBody)) {
      const detail = /<Message>([\s\S]*?)<\/Message>/i.exec(completedBody)?.[1]
      throw new Error(
        detail
          ? 'S3 could not complete the multipart upload: ' +
            `${decodeXmlText(detail)} (${key})`
          : 'S3 could not complete the multipart upload: HTTP ' +
            `${completed.status} (${key})`,
      )
    }
    uploadId = null
  } finally {
    if (uploadId) await abortMultipart(aws, config, key, uploadId, objectUrl)
  }
}

async function abortMultipart(
  aws: AwsClient,
  config: S3Config,
  key: string,
  uploadId: string,
  objectUrl: S3ObjectUrl,
): Promise<void> {
  try {
    const response = await aws.fetch(
      multipartUrl(config, key, { uploadId }, objectUrl),
      {
        method: 'DELETE',
        headers: { 'User-Agent': BACKUP_USER_AGENT },
        signal: AbortSignal.timeout(10_000),
        redirect: 'manual',
      },
    )
    await response.body?.cancel().catch(() => {})
    if (!response.ok && response.status !== 404) {
      console.warn(
        '[autonote] S3 multipart cleanup failed: HTTP ' +
          `${response.status} (${key})`,
      )
    }
  } catch (error) {
    console.warn(
      '[autonote] S3 multipart cleanup failed:',
      friendlyError(error),
    )
  }
}

function multipartUrl(
  config: S3Config,
  key: string,
  query: Record<string, string | null>,
  objectUrl: S3ObjectUrl,
): string {
  const url = new URL(objectUrl(config, key))
  const entries = Object.entries(query)
  if (entries.length === 1 && entries[0]![1] === null) {
    url.search = entries[0]![0]
  } else {
    for (const [name, value] of entries) {
      if (value !== null) url.searchParams.set(name, value)
    }
  }
  return url.toString()
}

async function* streamParts(
  stream: ReadableStream<Uint8Array>,
  partBytes: number,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  let buffer = new Uint8Array(partBytes)
  let used = 0
  let completed = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      let offset = 0
      while (offset < value.byteLength) {
        const copied = Math.min(partBytes - used, value.byteLength - offset)
        buffer.set(value.subarray(offset, offset + copied), used)
        used += copied
        offset += copied
        if (used === partBytes) {
          yield buffer
          buffer = new Uint8Array(partBytes)
          used = 0
        }
      }
    }
    if (used) yield buffer.slice(0, used)
    completed = true
  } finally {
    if (!completed) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function readStreamExactly(
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number,
): Promise<Uint8Array> {
  const output = new Uint8Array(expectedBytes)
  const reader = stream.getReader()
  let offset = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (offset + value.byteLength > output.byteLength) {
        throw new Error('The generated backup ZIP exceeded its predicted size')
      }
      output.set(value, offset)
      offset += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  if (offset !== expectedBytes)
    throw new Error('The generated backup ZIP size changed')
  return output
}

async function responseTextWithinLimit(
  response: Response,
  limit: number,
): Promise<string> {
  return new TextDecoder().decode(
    await readResponseBytesWithinLimit(response, limit),
  )
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export async function describeError(
  res: Response,
  key: string,
): Promise<string> {
  let detail = ''
  try {
    const text = truncateText(
      new TextDecoder().decode(await readResponseBytesWithinLimit(res, 4096)),
      800,
    )
    detail =
      /<Message>([\s\S]*?)<\/Message>/.exec(text)?.[1] ??
      text.replace(/<[^>]+>/g, ' ').trim()
  } catch {}

  const hints: Record<number, string> = {
    301: 'The bucket region does not match. Check region and endpoint',
    400: 'The request was rejected. Check region and endpoint',
    403: 'The key is invalid or lacks write access to this bucket',
    404: 'The bucket does not exist or the endpoint is incorrect',
    501:
      'The service does not support this operation. Enable path-style access',
  }
  const hint = hints[res.status]
  return (
    `HTTP ${res.status}${hint ? ` · ${hint}` : ''}` +
    `${detail ? ` · ${detail}` : ''} (${key})`
  )
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  return a.every((value, index) => value === b[index])
}
