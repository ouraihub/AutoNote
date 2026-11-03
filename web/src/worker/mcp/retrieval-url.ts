export function noteUrl(origin: string, noteId: string): string {
  return `${origin.replace(/\/$/, '')}/n/${encodeURIComponent(noteId)}`
}
