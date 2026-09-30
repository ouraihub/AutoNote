import { describe, expect, it } from 'vitest'
import {
  buildObsidianAssetIndex,
  collectObsidianReferences,
  findObsidianAsset,
  mimeForAttachmentName,
  normalizeObsidianPath,
  rewriteObsidianReferences,
  stripObsidianComments,
} from './obsidian-import'

function entry(path: string): { path: string; data: Uint8Array } {
  return { path, data: new Uint8Array([1, 2, 3]) }
}

describe('findObsidianAsset', () => {
  const index = buildObsidianAssetIndex([
    entry('assets/pic.png'),
    entry('notes/guide.pdf'),
    entry('Attachments/photo.JPG'),
  ])

  it('matches by full path ignoring case', () => {
    expect(findObsidianAsset(index, 'assets/pic.png', '')).not.toBeNull()
    expect(findObsidianAsset(index, 'Assets/PIC.PNG', '')).not.toBeNull()
  })

  it('resolves references relative to the note directory', () => {
    const found = findObsidianAsset(index, 'pic.png', 'Notes/sub')
    expect(found?.name).toBe('pic.png')
  })

  it('falls back to a unique basename match', () => {
    const found = findObsidianAsset(index, 'guide.pdf', 'Notes')
    expect(found?.path).toBe('notes/guide.pdf')
  })

  it('returns null for unknown files', () => {
    expect(findObsidianAsset(index, 'missing.png', '')).toBeNull()
  })
})

describe('collectObsidianReferences', () => {
  it('collects markdown image paths and wiki embeds without duplicates', () => {
    const content = '![one](a.png) and ![[b.jpg]] and again ![one](a.png)'
    const refs = collectObsidianReferences(content)
    expect(refs).toEqual(['a.png', 'b.jpg'])
  })

  it('skips remote, data, and managed URLs', () => {
    const content = '![x](https://example.com/a.png) ![y](data:image/png;base64,AA==) ![z](/api/files/123)'
    expect(collectObsidianReferences(content)).toEqual([])
  })

  it('keeps note embeds and heading references as they are', () => {
    const content = '![[my note]] and ![[note#heading]] and ![[note^block]]'
    expect(collectObsidianReferences(content)).toEqual([])
  })
})

describe('rewriteObsidianReferences', () => {
  it('rewrites markdown image references', () => {
    const rewritten = rewriteObsidianReferences('![alt](pic.png)', () => '/api/files/1')
    expect(rewritten).toBe('![alt](/api/files/1)')
  })

  it('rewrites wiki image embeds with alias support', () => {
    const rewritten = rewriteObsidianReferences('![[pic.png]] and ![[pic.png|300]]', () => '/api/files/2')
    expect(rewritten).toBe('![pic](/api/files/2) and ![300](/api/files/2)')
  })

  it('leaves note embeds and remote images untouched', () => {
    const content = '![[my note]] ![x](https://e.com/a.png)'
    expect(rewriteObsidianReferences(content, () => '/api/files/9')).toBe(content)
  })

  it('keeps references that cannot be resolved', () => {
    expect(rewriteObsidianReferences('![alt](missing.png)', () => null)).toBe('![alt](missing.png)')
  })
})

describe('stripObsidianComments', () => {
  it('converts %% comments to HTML comments', () => {
    expect(stripObsidianComments('before %%hidden%% after')).toBe('before <!--hidden--> after')
  })

  it('sanitizes dashes inside comments', () => {
    expect(stripObsidianComments('%%a -- b%%')).toBe('<!--a — b-->')
  })
})

describe('normalizeObsidianPath', () => {
  it('normalizes separators and leading dot slashes', () => {
    expect(normalizeObsidianPath('.\\assets\\pic.png')).toBe('assets/pic.png')
    expect(normalizeObsidianPath(' ./a.png ')).toBe('./a.png')
  })
})

describe('mimeForAttachmentName', () => {
  it('maps known extensions and defaults the rest', () => {
    expect(mimeForAttachmentName('a.PNG')).toBe('image/png')
    expect(mimeForAttachmentName('a.jpeg')).toBe('image/jpeg')
    expect(mimeForAttachmentName('a.pdf')).toBe('application/pdf')
    expect(mimeForAttachmentName('a.xyz')).toBe('application/octet-stream')
  })
})
