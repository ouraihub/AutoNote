import { AwsClient } from 'aws4fetch'
import type { S3Config, TestConnectionResult } from '@shared/types'
import type { Snapshot } from './snapshot'
import { backupArchivePath, createBackupArchive } from './archive'
import {
  BACKUP_USER_AGENT,
  friendlyError,
  readResponseBytesWithinLimit,
  type DeliverResult,
} from './common'
import { normalizeBackupPrefix } from './validation'
import { client, joinKey, objectUrl, type S3Secret } from './s3-client'
import {
  decodeXmlText,
  describeError,
  escapeXml,
  responseTextWithinLimit,
} from './s3-response'
export { objectUrl } from './s3-client'
export type { S3Secret } from './s3-client'

const S3_MULTIPART_PART_BYTES = 8 * 1024 * 1024
const S3_MULTIPART_PARTS_MAX = 10_000

export async function s3Deliver(
  config: S3Config,
  secret: S3Secret,
  snapshot: Snapshot,
  signal?: AbortSignal,
): Promise<DeliverResult> {
  const aws = client(secret, config)
  const prefix = normalizeBackupPrefix(config.prefix ?? '')
  const key = joinKey(prefix, backupArchivePath(snapshot))
  const archive = createBackupArchive(snapshot)
  if (
    await s3ArchiveMatches(
      aws,
      config,
      key,
      archive.byteLengthNumber,
      snapshot.stamp,
      signal,
    )
  ) {
    await archive.stream.cancel().catch(() => {})
    return { files: 1, bytes: archive.byteLengthNumber }
  }

  if (archive.byteLengthNumber <= S3_MULTIPART_PART_BYTES) {
    const body = await readStreamExactly(
      archive.stream,
      archive.byteLengthNumber,
    )
    await putArchive(aws, config, key, body, snapshot.stamp, signal)
  } else {
    await multipartUpload(
      aws,
      config,
      key,
      archive.stream,
      archive.byteLengthNumber,
      snapshot.stamp,
      signal,
    )
  }

  return { files: 1, bytes: archive.byteLengthNumber }
}

async function s3ArchiveMatches(
  aws: AwsClient,
  config: S3Config,
  key: string,
  expectedBytes: number,
  stamp: string,
  signal?: AbortSignal,
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

async function putArchive(
  aws: AwsClient,
  config: S3Config,
  key: string,
  body: Uint8Array,
  stamp: string,
  signal?: AbortSignal,
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

async function multipartUpload(
  aws: AwsClient,
  config: S3Config,
  key: string,
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number,
  stamp: string,
  signal?: AbortSignal,
): Promise<void> {
  let uploadId: string | null = null
  try {
    const started = await aws.fetch(
      multipartUrl(config, key, { uploads: null }),
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
        multipartUrl(config, key, {
          partNumber: String(partNumber),
          uploadId,
        }),
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
            `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(
              part.etag,
            )}</ETag></Part>`,
        )
        .join('')}</CompleteMultipartUpload>`,
    )
    const completed = await aws.fetch(multipartUrl(config, key, { uploadId }), {
      method: 'POST',
      body: completeBody as unknown as BodyInit,
      headers: {
        'Content-Type': 'application/xml',
        'User-Agent': BACKUP_USER_AGENT,
      },
      signal,
      redirect: 'manual',
    })
    const completedBody = await responseTextWithinLimit(completed, 64 * 1024)
    if (!completed.ok || /<Error(?:\s|>)/i.test(completedBody)) {
      const detail = /<Message>([\s\S]*?)<\/Message>/i.exec(completedBody)?.[1]
      throw new Error(
        detail
          ? `S3 could not complete the multipart upload: ${decodeXmlText(
              detail,
            )} (${key})`
          : `S3 could not complete the multipart upload: HTTP ${
              completed.status
            } (${key})`,
      )
    }
    uploadId = null
  } finally {
    if (uploadId) await abortMultipart(aws, config, key, uploadId)
  }
}

async function abortMultipart(
  aws: AwsClient,
  config: S3Config,
  key: string,
  uploadId: string,
): Promise<void> {
  try {
    const response = await aws.fetch(multipartUrl(config, key, { uploadId }), {
      method: 'DELETE',
      headers: { 'User-Agent': BACKUP_USER_AGENT },
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    })
    await response.body?.cancel().catch(() => {})
    if (!response.ok && response.status !== 404) {
      console.warn(
        `[autonote] S3 multipart cleanup failed: HTTP ${response.status} ` +
          `(${key})`,
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

async function readStreamExactly(
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

export async function s3Test(
  config: S3Config,
  secret: S3Secret,
  signal?: AbortSignal,
): Promise<TestConnectionResult> {
  const started = Date.now()
  try {
    if (!config.bucket?.trim())
      return { ok: false, message: 'Enter a bucket name' }
    const aws = client(secret, config)
    const key = joinKey(
      normalizeBackupPrefix(config.prefix ?? ''),
      `.autonote-check-${crypto.randomUUID()}`,
    )
    const url = objectUrl(config, key)
    const payload = new TextEncoder().encode(
      `autonote ${new Date().toISOString()}`,
    )
    let written = false
    let readWriteSucceeded = false
    let primaryFailure: TestConnectionResult | null = null
    try {
      const put = await aws.fetch(url, {
        method: 'PUT',
        body: payload as unknown as BodyInit,
        headers: {
          'Content-Type': 'text/plain',
          'User-Agent': BACKUP_USER_AGENT,
        },
        signal,
        redirect: 'manual',
      })
      if (!put.ok) return { ok: false, message: await describeError(put, key) }
      written = true
      await put.body?.cancel().catch(() => {})

      const get = await aws.fetch(url, {
        method: 'GET',
        signal,
        redirect: 'manual',
      })
      if (!get.ok) {
        primaryFailure = {
          ok: false,
          message: `Write succeeded but read failed: ${await describeError(
            get,
            key,
          )}`,
        }
        return primaryFailure
      }
      const downloaded = await readResponseBytesWithinLimit(get, 1024)
      if (!bytesEqual(downloaded, payload)) {
        primaryFailure = {
          ok: false,
          message:
            'The data read after writing did not match. Check the storage ' +
            'gateway or proxy',
        }
        return primaryFailure
      }

      readWriteSucceeded = true
      return {
        ok: true,
        message: 'Connection succeeded with read and write access',
        latencyMs: Date.now() - started,
      }
    } finally {
      if (written) {
        let cleanupError: Error | null = null
        try {
          const removed = await aws.fetch(url, {
            method: 'DELETE',
            signal: AbortSignal.timeout(5_000),
            redirect: 'manual',
          })
          await removed.body?.cancel().catch(() => {})
          if (!removed.ok && removed.status !== 404) {
            cleanupError = new Error(
              `The test file could not be removed: HTTP ${removed.status}`,
            )
          }
        } catch (error) {
          cleanupError = new Error(
            `The test file could not be removed: ${friendlyError(error)}`,
          )
        }
        if (cleanupError) {
          if (readWriteSucceeded) throw cleanupError
          if (primaryFailure)
            primaryFailure.message += `. ${cleanupError.message}`
          console.warn(
            '[autonote] S3 test object cleanup failed:',
            cleanupError.message,
          )
        }
      }
    }
  } catch (err) {
    return { ok: false, message: friendlyError(err) }
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  return a.every((value, index) => value === b[index])
}
