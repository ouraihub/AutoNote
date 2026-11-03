import { AwsClient } from 'aws4fetch'
import type { S3Config } from '@shared/types'
import {
  normalizeS3Region,
  parseBackupEndpoint,
  validateS3Bucket,
} from './validation'

export interface S3Secret {
  accessKeyId?: string
  secretAccessKey?: string
}

export function client(secret: S3Secret, config: S3Config): AwsClient {
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
      `${endpoint.origin}${prefix}/${encodeURIComponent(bucket)}/` + encodedKey
    )
  }
  const prefix = endpoint.pathname.replace(/\/+$/, '')
  return (
    `${endpoint.protocol}//${bucket}.${endpoint.host}${prefix}/` + encodedKey
  )
}

export function joinKey(...parts: (string | undefined)[]): string {
  return parts
    .filter((p): p is string => Boolean(p && p.trim()))
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}
