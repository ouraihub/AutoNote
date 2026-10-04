import type { EditorView } from '@codemirror/view'
import type { PrefsStore } from '../../platform/prefs'
import type { CoalescingPrefsWriter } from '../../state/prefs-writer'
import { buildScrollCurve, editorLineAtScroll, editorScrollForLine, measurePreviewAnchors, previewTopForLine, sourceLineForPreviewTop } from './sync-scroll'

export interface ReadingPosition { line: number; offset: number }

export function readingPositionKey(scope: string, noteId: string): string {
  return `reading-position:${encodeURIComponent(scope)}:${encodeURIComponent(noteId)}`
}

export function parseReadingPosition(value: unknown): ReadingPosition | null {
  if (!value || typeof value !== 'object') return null
  const { line, offset } = value as Record<string, unknown>
  return typeof line === 'number' && Number.isInteger(line) && line >= 0 &&
    typeof offset === 'number' && Number.isFinite(offset) && offset >= 0 ? { line, offset } : null
}

export function bindReadingPosition(options: {
  scroller: HTMLElement; view?: EditorView; lineCount: () => number
  key: string; prefs: PrefsStore; writer: CoalescingPrefsWriter; onError: (error: unknown) => void
  registerFlush: (flush: () => Promise<void>) => () => void
}): () => void {
  const { scroller, view, key, prefs, writer, onError } = options
  let alive = true
  let restored = false
  let position: ReadingPosition | null = null
  let loaded = false
  let frame = 0
  const curve = () => buildScrollCurve(measurePreviewAnchors(scroller), options.lineCount(), 0, Math.max(0, scroller.scrollHeight - scroller.clientHeight))
  const lineTop = (line: number) => view ? editorScrollForLine(view, line) : previewTopForLine(curve(), line)
  const restore = () => {
    if (!alive || !loaded || restored || !scroller.clientHeight) return
    restored = true
    if (position) scroller.scrollTop = Math.min(Math.max(0, scroller.scrollHeight - scroller.clientHeight), lineTop(position.line) + position.offset)
  }
  const save = () => {
    if (!restored || !scroller.clientHeight) return
    const line = Math.floor(view ? editorLineAtScroll(view, scroller.scrollTop) : sourceLineForPreviewTop(curve(), scroller.scrollTop))
    position = { line, offset: Math.max(0, scroller.scrollTop - lineTop(line)) }
    writer.schedule(key, { line: position.line, offset: position.offset })
  }
  const interacted = () => { loaded = true; restored = true }
  scroller.addEventListener('scroll', save, { passive: true })
  scroller.addEventListener('wheel', interacted, { passive: true })
  scroller.addEventListener('pointerdown', interacted, { passive: true })
  scroller.addEventListener('keydown', interacted, true)
  const observer = new ResizeObserver(restore)
  observer.observe(scroller)
  const content = scroller.querySelector('[data-preview-content]')
  if (content) observer.observe(content)
  void writer.flush().then(() => prefs.load(key)).then((stored) => {
    if (!alive || restored) return
    position = parseReadingPosition(stored)
    loaded = true
    restore()
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(restore) })
  }).catch((error: unknown) => { loaded = true; restore(); onError(error) })
  window.addEventListener('pagehide', save)
  const unregister = options.registerFlush(async () => { save(); await writer.flush() })
  return () => {
    save()
    unregister()
    alive = false
    cancelAnimationFrame(frame)
    observer.disconnect()
    scroller.removeEventListener('scroll', save)
    scroller.removeEventListener('wheel', interacted)
    scroller.removeEventListener('pointerdown', interacted)
    scroller.removeEventListener('keydown', interacted, true)
    window.removeEventListener('pagehide', save)
  }
}
