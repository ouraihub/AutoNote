export type WebRoute =
  { kind: 'app'; noteId: string | null } | { kind: 'share'; slug: string } | { kind: 'gallery' } | { kind: 'not-found' }

export function parseRoute(pathname: string, development = false): WebRoute {
  if (pathname === '/') return { kind: 'app', noteId: null }
  const note = /^\/n\/([0-9a-hjkmnp-tv-z]{26})\/?$/i.exec(pathname)
  if (note?.[1]) return { kind: 'app', noteId: note[1].toLowerCase() }
  const share = /^\/s\/([0-9a-hjkmnp-tv-z]{20})\/?$/.exec(pathname)
  if (share?.[1]) return { kind: 'share', slug: share[1] }
  if (development && pathname === '/__gallery') return { kind: 'gallery' }
  return { kind: 'not-found' }
}
