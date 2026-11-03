import { countText, deriveExcerpt, extractTags } from '@shared/markdown-utils'
import type { Note } from '@shared/types'

export function derivedText(
  content: string,
): Pick<Note, 'content' | 'excerpt' | 'tags' | 'wordCount' | 'charCount'> {
  const { words, chars } = countText(content)
  return {
    content,
    excerpt: deriveExcerpt(content),
    tags: extractTags(content),
    wordCount: words,
    charCount: chars,
  }
}
