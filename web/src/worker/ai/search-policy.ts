import type { SearchPage } from '@ouraihub/aether-contracts'
import { at, KitFailure } from './kit'

function glob(pattern: string, value: string): boolean {
  let p = 0, v = 0, star = -1, retry = 0
  while (v < value.length) {
    if (pattern[p] === '?' || pattern[p] === value[v]) { p++; v++ }
    else if (pattern[p] === '*') { star = p++; retry = v }
    else if (star >= 0) { p = star + 1; v = ++retry }
    else return false
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}
export function blocked(raw: string, rules: string[]): boolean {
  let url: URL
  try { url = new URL(raw) } catch { return true }
  if (!['http:', 'https:'].includes(url.protocol)) return true
  return rules.some((rule) => {
    if (rule.includes('://')) return glob(rule, url.href)
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    return rule.includes('*') || rule.includes('?') ? glob(rule, host) : host === rule || host.endsWith('.' + rule)
  })
}

/** Keep host full-response semantics: Aether's page parser intentionally caps content at 24k. */
export function parsePage(provider: string, body: string, url: string): SearchPage {
  if (provider === 'fetch') {
    const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || url
    const content = body.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<noscript\b[^>]*>[\s\S]*?<\/noscript>|<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    if (!content) throw new KitFailure('upstream', 'page has no content')
    return { title, url, content }
  }
  let payload: unknown
  try { payload = JSON.parse(body) } catch { throw new KitFailure('upstream', `${provider} returned invalid JSON`) }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new KitFailure('upstream', `${provider} returned invalid JSON`)
  if ((provider === 'querit' && typeof at(payload, 'error_code') === 'number' && at(payload, 'error_code') !== 200) || (provider === 'firecrawl' && at(payload, 'success') === false)) throw new KitFailure('upstream', `${provider} returned an error`)
  const data = provider === 'querit' ? at(payload, 'results', 0) : at(payload, 'data') ?? payload
  const meta = at(data, provider === 'querit' ? 'extrasMeta' : 'metadata')
  const title = provider === 'jina' ? pageText(data, 'title') : pageText(meta, 'title')
  const resultUrl = provider === 'firecrawl' ? pageText(meta, 'sourceURL') || url : pageText(data, 'url') || url
  const content = pageText(data, ...(provider === 'firecrawl' ? ['markdown'] : ['content', 'text']))
  if (!content) throw new KitFailure('upstream', `${provider} returned no page content`)
  return { title: title || resultUrl, url: resultUrl, content }
}

function pageText(value: unknown, ...keys: string[]): string {
  for (const key of keys) {
    const field = at(value, key)
    if (typeof field === 'string' && field.trim()) return field.trim()
    if (Array.isArray(field)) { const joined = field.filter((part): part is string => typeof part === 'string').join(' ').trim(); if (joined) return joined }
  }
  return ''
}
