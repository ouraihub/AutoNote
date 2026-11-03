import { truncateText } from '@shared/text-utils'
import { readResponseBytesWithinLimit } from './common'

export async function responseTextWithinLimit(
  response: Response,
  limit: number,
): Promise<string> {
  return new TextDecoder().decode(
    await readResponseBytesWithinLimit(response, limit),
  )
}

export function decodeXmlText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
}

export function escapeXml(value: string): string {
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
      'The service does not support this operation. Enable path-style ' +
      'access',
  }
  const hint = hints[res.status]
  return `HTTP ${res.status}${hint ? ` · ${hint}` : ''}${
    detail ? ` · ${detail}` : ''
  } (${key})`
}
