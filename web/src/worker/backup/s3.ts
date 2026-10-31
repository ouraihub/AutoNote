import { AwsClient } from 'aws4fetch'
import { readResponseBytesWithinLimit } from './common'
import type { S3Config, TestConnectionResult } from '@shared/types'
import type { Snapshot } from './snapshot'
import { backupArchivePath, createBackupArchive } from './archive'
import {
  BACKUP_USER_AGENT,
  friendlyError,
  type DeliverResult,
} from './common'
import {
  normalizeBackupPrefix,
  normalizeS3Region,
  parseBackupEndpoint,
  validateS3Bucket,
} from './validation'
import {
  bytesEqual,
  describeError,
  multipartUpload,
  putArchive,
  readStreamExactly,
  s3ArchiveMatches,
} from './s3-internals'

export interface S3Secret {
  accessKeyId?: string
  secretAccessKey?: string
}

const S3_MULTIPART_PART_BYTES = 8 * 1024 * 1024

function client(secret: S3Secret, config: S3Config): AwsClient {
  if (!secret.accessKeyId || !secret.secretAccessKey) {
    throw new Error('Access Key or Secret Key is missing')
  }
  return new AwsClient({
    accessKeyId: secret.accessKeyId,
    secretAccessKey: secret.secretAccessKey,
    region: normalizeS3Region(config.region),
    service: 's3',
    retries: 2,
    initRetryMs: 100,
  })
}

export function objectUrl(config: S3Config, key: string): string {
  const region = normalizeS3Region(config.region)
  const raw =
    config.endpoint?.trim() ||
    `https://s3.${region === 'auto' ? 'us-east-1' : region}.amazonaws.com`
  const endpoint = parseBackupEndpoint(raw, 'Endpoint')
  const bucket = validateS3Bucket(
    config.bucket ?? '',
    config.pathStyle === true,
  )
  const encodedKey = key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')

  if (config.pathStyle) {
    const prefix = endpoint.pathname.replace(/\/+$/, '')
    return (
      `${endpoint.origin}${prefix}/` +
      `${encodeURIComponent(bucket)}/${encodedKey}`
    )
  }
  const prefix = endpoint.pathname.replace(/\/+$/, '')
  return (
    `${endpoint.protocol}//${bucket}.${endpoint.host}${prefix}/` +
    encodedKey
  )
}

function joinKey(...parts: (string | undefined)[]): string {
  return parts
    .filter((p): p is string => Boolean(p && p.trim()))
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

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
      objectUrl,
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
    await putArchive(aws, config, key, body, snapshot.stamp, signal, objectUrl)
  } else {
    await multipartUpload(
      aws,
      config,
      key,
      archive.stream,
      archive.byteLengthNumber,
      snapshot.stamp,
      signal,
      objectUrl,
    )
  }

  return { files: 1, bytes: archive.byteLengthNumber }
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
          message:
            'Write succeeded but read failed: ' +
            (await describeError(get, key)),
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
