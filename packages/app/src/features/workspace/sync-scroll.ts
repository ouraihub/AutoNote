import type { EditorView } from '@codemirror/view'
import { previewSourceAnchors } from '../preview/article'

export interface PreviewAnchor {
  line: number
  top: number
}

type ScrollSide = 'editor' | 'preview'
type ScrollEdge = 'top' | 'bottom' | null

const EDGE_EPSILON = 2
const DRIVER_IDLE_MS = 160

export function bindSyncScroll(view: EditorView, preview: HTMLElement): () => void {
  let anchors: PreviewAnchor[] | null = null
  let driver: ScrollSide | null = null
  let frame = 0
  let release = 0
  const invalidate = () => { anchors = null }

    const editor = view.scrollDOM
    driver = null
    anchors = null

    const getCurve = (): PreviewAnchor[] => {
      anchors ??= measurePreviewAnchors(preview)
      if (anchors.length === 0) return []
      return buildScrollCurve(
        anchors,
        view.state.doc.lines,
        previewPaddingTop(preview),
        maxScroll(preview),
      )
    }

    const syncFromEditor = () => {
      const edge = scrollEdge(editor.scrollTop, maxScroll(editor))
      if (edge === 'top') {
        setScrollTop(preview, 0)
        return
      }
      if (edge === 'bottom') {
        setScrollTop(preview, maxScroll(preview))
        return
      }

      const paddingTop = previewPaddingTop(preview)
      const curve = getCurve()
      if (curve.length === 0) return
      const target = previewTopForLine(curve, editorLineAtScroll(view, editor.scrollTop))
      setScrollTop(preview, target - paddingTop)
    }

    const syncFromPreview = () => {
      const edge = scrollEdge(preview.scrollTop, maxScroll(preview))
      if (edge === 'top') {
        setScrollTop(editor, 0)
        return
      }
      if (edge === 'bottom') {
        setScrollTop(editor, maxScroll(editor))
        return
      }

      const curve = getCurve()
      if (curve.length === 0) return
      const line = sourceLineForPreviewTop(
        curve,
        preview.scrollTop + previewPaddingTop(preview),
      )
      setScrollTop(editor, editorScrollForLine(view, line))
    }

    const releaseLater = (side: ScrollSide) => {
      window.clearTimeout(release)
      release = window.setTimeout(() => {
        if (driver === side) driver = null
      }, DRIVER_IDLE_MS)
    }

    const claim = (side: ScrollSide) => {
      if (driver !== side) cancelAnimationFrame(frame)
      driver = side
      releaseLater(side)
    }

    const schedule = (side: ScrollSide) => {
      if (driver !== side) return
      window.clearTimeout(release)
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (driver !== side) return
        if (side === 'editor') syncFromEditor()
        else syncFromPreview()
        releaseLater(side)
      })
    }

    const bindings = ([
      [editor, 'editor'],
      [preview, 'preview'],
    ] as const).map(([element, side]) => {
      const claimSide = () => claim(side)
      const onScroll = () => schedule(side)
      element.addEventListener('wheel', claimSide, { passive: true })
      element.addEventListener('pointerdown', claimSide, { passive: true })
      element.addEventListener('keydown', claimSide, true)
      element.addEventListener('scroll', onScroll, { passive: true })
      return { element, claimSide, onScroll }
    })

    const mutationObserver = new MutationObserver(invalidate)
    mutationObserver.observe(preview, { childList: true, subtree: true, attributes: true })
    const resizeObserver = new ResizeObserver(invalidate)
    resizeObserver.observe(preview)
    const content = preview.querySelector<HTMLElement>('[data-preview-content]')
    if (content) resizeObserver.observe(content)

    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(release)
      driver = null
      bindings.forEach(({ element, claimSide, onScroll }) => {
        element.removeEventListener('wheel', claimSide)
        element.removeEventListener('pointerdown', claimSide)
        element.removeEventListener('keydown', claimSide, true)
        element.removeEventListener('scroll', onScroll)
      })
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
}

export function measurePreviewAnchors(preview: HTMLElement): PreviewAnchor[] {
  const previewRect = preview.getBoundingClientRect()
  const anchors: PreviewAnchor[] = []
  let previousLine = -1
  let previousTop = Number.NEGATIVE_INFINITY

  for (const element of previewSourceAnchors(preview)) {
    const line = Number(element.dataset.line)
    const measuredTop = element.getBoundingClientRect().top - previewRect.top + preview.scrollTop
    if (!Number.isInteger(line) || line < 0 || !Number.isFinite(measuredTop)) continue
    if (line <= previousLine || measuredTop + 0.5 < previousTop) continue

    const top = Math.max(previousTop, measuredTop)
    anchors.push({ line, top })
    previousLine = line
    previousTop = top
  }

  return anchors
}

export function buildScrollCurve(
  measured: PreviewAnchor[],
  lineCount: number,
  paddingTop: number,
  previewMaxScroll: number,
): PreviewAnchor[] {
  const endLine = Math.max(1, Math.floor(Number.isFinite(lineCount) ? lineCount : 1))
  const startTop = Math.max(0, Number.isFinite(paddingTop) ? paddingTop : 0)
  const endTop = startTop + Math.max(0, Number.isFinite(previewMaxScroll) ? previewMaxScroll : 0)
  const curve: PreviewAnchor[] = [{ line: 0, top: startTop }]
  let previousLine = 0
  let previousTop = startTop

  for (const anchor of measured) {
    if (!Number.isFinite(anchor.line) || !Number.isFinite(anchor.top)) continue
    const line = Math.floor(anchor.line)
    const top = clamp(anchor.top, startTop, endTop)
    if (line <= previousLine || line >= endLine || top < previousTop) continue
    curve.push({ line, top })
    previousLine = line
    previousTop = top
  }

  curve.push({ line: endLine, top: endTop })
  return curve
}

export function previewTopForLine(curve: PreviewAnchor[], line: number): number {
  return interpolateAnchors(curve, line, 'line', 'top')
}

export function sourceLineForPreviewTop(curve: PreviewAnchor[], top: number): number {
  return interpolateAnchors(curve, top, 'top', 'line')
}

export function scrollEdge(scrollTop: number, maximum: number): ScrollEdge {
  if (scrollTop <= EDGE_EPSILON) return 'top'
  if (maximum > EDGE_EPSILON && scrollTop >= maximum - EDGE_EPSILON) return 'bottom'
  return null
}

export function editorLineAtScroll(view: EditorView, top: number): number {
  const block = view.lineBlockAtHeight(Math.max(0, top))
  const line = view.state.doc.lineAt(block.from).number - 1
  const lastLine = view.state.doc.lineAt(block.to).number
  const fraction = block.height > 0 ? clamp((top - block.top) / block.height, 0, 1) : 0
  return clamp(line + fraction * Math.max(1, lastLine - line), 0, view.state.doc.lines)
}

export function editorScrollForLine(view: EditorView, exactLine: number): number {
  const doc = view.state.doc
  if (exactLine <= 0) return 0
  if (exactLine >= doc.lines) return maxScroll(view.scrollDOM)

  const lineIndex = Math.floor(exactLine)
  const lineNumber = Math.min(doc.lines, lineIndex + 1)
  const block = view.lineBlockAt(doc.line(lineNumber).from)
  const startLine = doc.lineAt(block.from).number - 1
  const endLine = doc.lineAt(block.to).number
  return block.top + clamp((exactLine - startLine) / Math.max(1, endLine - startLine), 0, 1) * block.height
}

function interpolateAnchors(
  anchors: PreviewAnchor[],
  value: number,
  input: keyof PreviewAnchor,
  output: keyof PreviewAnchor,
): number {
  const first = anchors[0]
  const last = anchors[anchors.length - 1]
  if (!first || !last) return 0
  if (value <= first[input]) return first[output]
  if (value >= last[input]) return last[output]

  const index = upperBoundAnchor(anchors, value, (anchor) => anchor[input])
  const before = anchors[index - 1]!
  const after = anchors[index]!
  const span = after[input] - before[input]
  if (span <= 0) return after[output]
  const progress = (value - before[input]) / span
  return before[output] + progress * (after[output] - before[output])
}

function upperBoundAnchor(
  anchors: PreviewAnchor[],
  value: number,
  select: (anchor: PreviewAnchor) => number,
): number {
  let low = 0
  let high = anchors.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (select(anchors[middle]!) <= value) low = middle + 1
    else high = middle
  }
  return low
}

function maxScroll(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight)
}

function setScrollTop(element: HTMLElement, value: number): void {
  const target = clamp(value, 0, maxScroll(element))
  if (Math.abs(element.scrollTop - target) > 0.5) element.scrollTop = target
}

function previewPaddingTop(preview: HTMLElement): number {
  const value = Number.parseFloat(getComputedStyle(preview).paddingTop)
  return Number.isFinite(value) ? value : 0
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
