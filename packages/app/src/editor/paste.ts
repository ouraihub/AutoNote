import createDOMPurify from 'dompurify'
import { EditorSelection, Facet, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { truncateText } from '@shared/text-utils'
import type { Attachment } from '@shared/types'

/** Identifies the document an upload was started for; `generation` changes whenever the editor swaps notes. */
export interface AttachmentTarget {
  readonly noteId: string
  readonly generation: number
}

export type UploadedAttachment = Pick<Attachment, 'id' | 'filename' | 'mime'>

/** Container-provided upload boundary. Implementations go through `Backend.files`, never `fetch`. */
export interface AttachmentServices {
  upload(file: File, noteId: string): Promise<UploadedAttachment>
  /** Reports a failed upload; the editor still replaces its placeholder with a failure marker. */
  uploadFailed(file: File, error: unknown): void
  /** Applies a finished upload to a note that this editor no longer shows. */
  replaceDetached(
    noteId: string,
    placeholder: string,
    replacement: string,
  ): void
}

/** Live view of the owning editor, read when an upload starts and again when it settles. */
export interface PasteContext {
  attachments(): AttachmentServices
  target(): AttachmentTarget
  uploadingLabel(fileName: string): string
  uploadFailedLabel(fileName: string): string
}

const pasteContextFacet = Facet.define<PasteContext, PasteContext | null>({
  combine: (values) => values[0] ?? null,
})

const URL_RE = /^https?:\/\/\S+$/i
const MARKDOWN_HINT = /^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|)/m
const MARKDOWN_LINK_HINT = /\[[^\]]*\]\([^)]*\)/
const purifier = createDOMPurify(window)

export function pasteExtension(context: PasteContext): Extension {
  return [
    pasteContextFacet.of(context),
    EditorView.domEventHandlers({
      paste(event, view) {
        const clipboard = event.clipboardData
        if (!clipboard) return false

        const files = [...clipboard.files]
        if (!files.length) {
          const types = clipboard.types ? Array.from(clipboard.types) : []
          const hasRichText =
            types.includes('text/html') || types.includes('text/plain')
          if (!hasRichText && clipboard.items) {
            for (const item of [...clipboard.items]) {
              if (item.kind !== 'file' || !item.type.startsWith('image/'))
                continue
              const file = item.getAsFile()
              if (file) files.push(file)
            }
          }
        }
        if (files.length) {
          event.preventDefault()
          void insertAttachments(view, files, clipboard.getData('text/plain'))
          return true
        }

        const text = clipboard.getData('text/plain')?.trim()
        const range = view.state.selection.main
        if (text && URL_RE.test(text) && !range.empty) {
          const selected = view.state.sliceDoc(range.from, range.to)
          if (!URL_RE.test(selected.trim())) {
            event.preventDefault()
            replaceSelection(view, markdownLink(selected, text))
            return true
          }
        }

        const html = clipboard.getData('text/html')
        if (
          html &&
          !(text && (MARKDOWN_HINT.test(text) || MARKDOWN_LINK_HINT.test(text)))
        ) {
          const markdown = htmlToMarkdown(html)
          if (markdown && markdown !== text) {
            event.preventDefault()
            replaceSelection(view, markdown)
            return true
          }
        }
        return false
      },
      drop(event, view) {
        const files = [...(event.dataTransfer?.files ?? [])]
        if (!files.length) return false
        event.preventDefault()
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos !== null)
          view.dispatch({ selection: EditorSelection.cursor(pos) })
        void insertAttachments(view, files)
        return true
      },
      dragover(event) {
        if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
        return false
      },
    }),
  ]
}

/**
 * Uploads files at the selection, preserving accompanying clipboard text if the upload
 * fails. The placeholder remains in the note until the result can safely replace it.
 */
export async function insertAttachments(
  view: EditorView,
  files: readonly File[],
  fallbackText = '',
): Promise<void> {
  const context = view.state.facet(pasteContextFacet)
  if (!context)
    throw new Error(
      'insertAttachments requires an editor configured with pasteExtension',
    )
  const target = context.target()
  const pending = files.map((file, index) => {
    const range = view.state.selection.main
    const placeholder = `${context.uploadingLabel(escapeMarkdownLabel(file.name))}${uploadMarker()}`
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: placeholder },
      selection: EditorSelection.cursor(range.from + placeholder.length),
      userEvent: 'input.paste',
    })
    return { file, placeholder, fallback: index === 0 ? fallbackText : '' }
  })

  await Promise.all(
    pending.map(async ({ file, placeholder, fallback }) => {
      let markdown: string
      try {
        markdown = uploadedFileMarkdown(
          await context.attachments().upload(file, target.noteId),
        )
      } catch (error) {
        context.attachments().uploadFailed(file, error)
        markdown =
          fallback || context.uploadFailedLabel(safeHtmlComment(file.name))
      }
      const current = context.target()
      if (
        view.dom.isConnected &&
        current.noteId === target.noteId &&
        current.generation === target.generation
      ) {
        const at = view.state.doc.toString().indexOf(placeholder)
        if (at >= 0) {
          view.dispatch({
            changes: {
              from: at,
              to: at + placeholder.length,
              insert: markdown,
            },
            userEvent: 'input.paste',
          })
        }
        return
      }
      context
        .attachments()
        .replaceDetached(target.noteId, placeholder, markdown)
    }),
  )
}

/** Markdown for a stored attachment; always the logical `/api/files/<id>` URL, never a host-resolved one. */
export function uploadedFileMarkdown(attachment: UploadedAttachment): string {
  const isImage = attachment.mime.startsWith('image/')
  const dot = attachment.filename.lastIndexOf('.')
  const label =
    isImage && dot > 0 ? attachment.filename.slice(0, dot) : attachment.filename
  return markdownLink(
    escapeMarkdownLabel(label),
    `/api/files/${encodeURIComponent(attachment.id)}`,
    isImage,
    true,
  )
}

function replaceSelection(view: EditorView, insert: string): void {
  const range = view.state.selection.main
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(range.from + insert.length),
    userEvent: 'input.paste',
  })
}

function escapeMarkdownLabel(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/[[\]]/g, '\\$&')
}

function safeHtmlComment(value: string): string {
  return truncateText(
    value.replace(/[\r\n<>]+/g, ' ').replace(/--+/g, '\u2014'),
    240,
  )
}

function uploadMarker(): string {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `<!-- autonote-upload:${id} -->`
}

/**
 * Converts clipboard HTML into Markdown. The HTML is first sanitized by DOMPurify into an
 * inert body (scripts, handlers and `javascript:` URLs removed), then walked; only
 * http(s)/mailto/tel links and http(s) images survive into the Markdown source.
 */
export function htmlToMarkdown(html: string): string {
  const body = purifier.sanitize(html, {
    RETURN_DOM: true,
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
  })
  const walk = (node: Node, listIndent = ''): string => {
    if (node.nodeType === Node.TEXT_NODE)
      return (node.textContent ?? '').replace(/\s+/g, ' ')
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    const element = node as HTMLElement
    const tag = element.tagName.toLowerCase()
    const children = (): string =>
      [...element.childNodes].map((child) => walk(child, listIndent)).join('')
    const wrapped = (marker: string): string => {
      const text = children().trim()
      return text ? `${marker}${text}${marker}` : ''
    }
    switch (tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return `\n\n${'#'.repeat(Number(tag[1]))} ${children().trim()}\n\n`
      case 'p':
        return `\n\n${children().trim()}\n\n`
      case 'br':
        return '\n'
      case 'hr':
        return '\n\n---\n\n'
      case 'strong':
      case 'b':
        return wrapped('**')
      case 'em':
      case 'i':
        return wrapped('*')
      case 'del':
      case 's':
      case 'strike':
        return wrapped('~~')
      case 'code':
        return element.closest('pre')
          ? (element.textContent ?? '')
          : inlineCode(element.textContent ?? '')
      case 'pre': {
        const code = element.textContent ?? ''
        const language =
          /language-([a-z0-9+#-]+)/i.exec(
            element.querySelector('code')?.className ?? '',
          )?.[1] ?? ''
        const fence = '`'.repeat(Math.max(3, longestRun(code, '`') + 1))
        return `\n\n${fence}${language}\n${code.replace(/\n$/, '')}\n${fence}\n\n`
      }
      case 'blockquote':
        return `\n\n${children()
          .trim()
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')}\n\n`
      case 'a': {
        const href = safePastedHref(element.getAttribute('href') ?? '', false)
        const label = children().trim() || href || ''
        return href ? markdownLink(label, href) : label
      }
      case 'img': {
        const src = safePastedHref(element.getAttribute('src') ?? '', true)
        return src
          ? markdownLink(element.getAttribute('alt') ?? '', src, true)
          : ''
      }
      case 'ul':
      case 'ol':
        return `\n\n${renderList(element, listIndent)}\n\n`
      case 'table': {
        const rows = [...element.querySelectorAll('tr')]
        const [headerRow, ...bodyRows] = rows
        if (!headerRow) return children()
        const cells = (row: Element): string[] =>
          [...row.querySelectorAll('th, td')].map((cell) =>
            (cell.textContent ?? '').trim().replace(/\|/g, '\\|'),
          )
        const header = cells(headerRow)
        const lines = [
          `| ${header.join(' | ')} |`,
          `| ${header.map(() => '---').join(' | ')} |`,
          ...bodyRows.map((row) => `| ${cells(row).join(' | ')} |`),
        ]
        return `\n\n${lines.join('\n')}\n\n`
      }
      default:
        return children()
    }
  }

  const renderList = (list: HTMLElement, indent: string): string => {
    const ordered = list.tagName.toLowerCase() === 'ol'
    const parsedStart = Number.parseInt(list.getAttribute('start') ?? '1', 10)
    const start = Number.isFinite(parsedStart) ? parsedStart : 1
    const items = [...list.children].filter(
      (child) => child.tagName.toLowerCase() === 'li',
    )
    const lines: string[] = []
    items.forEach((item, index) => {
      const explicit = Number.parseInt(item.getAttribute('value') ?? '', 10)
      const marker = ordered
        ? `${Number.isFinite(explicit) ? explicit : start + index}. `
        : '- '
      const childIndent = indent + ' '.repeat(marker.length)
      const nested: HTMLElement[] = []
      const content = [...item.childNodes]
        .map((child) => {
          if (
            child instanceof HTMLElement &&
            /^(?:ul|ol)$/i.test(child.tagName)
          ) {
            nested.push(child)
            return ''
          }
          return walk(child, childIndent)
        })
        .join('')
        .trim()
        .replace(/\n{2,}/g, '\n')
      const [first = '', ...continuation] = content.split('\n')
      lines.push(`${indent}${marker}${first}`)
      for (const line of continuation) lines.push(`${childIndent}${line}`)
      for (const childList of nested)
        lines.push(renderList(childList, childIndent))
    })
    return lines.join('\n')
  }

  return walk(body)
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

function markdownLink(
  label: string,
  url: string,
  image = false,
  labelEscaped = false,
): string {
  const safeLabel = labelEscaped ? label : escapeMarkdownLabel(label)
  const destination = `<${url.replace(/[\u0000-\u0020<>]/g, (value) => encodeURIComponent(value))}>`
  return `${image ? '!' : ''}[${safeLabel}](${destination})`
}

function safePastedHref(value: string, image: boolean): string | null {
  const href = value.trim()
  if (!href) return null
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase()
  if (
    scheme &&
    !(image ? ['http', 'https'] : ['http', 'https', 'mailto', 'tel']).includes(
      scheme,
    )
  )
    return null
  return href
}

function inlineCode(value: string): string {
  const content = value.replace(/[\r\n]+/g, ' ')
  const fence = '`'.repeat(Math.max(1, longestRun(content, '`') + 1))
  const pad = /^(?:\s|`)|(?:\s|`)$/.test(content) ? ' ' : ''
  return `${fence}${pad}${content}${pad}${fence}`
}

function longestRun(value: string, character: string): number {
  return Math.max(
    0,
    ...[...value.matchAll(new RegExp(`${character}+`, 'g'))].map(
      (match) => match[0].length,
    ),
  )
}
