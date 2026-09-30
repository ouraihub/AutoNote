import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'svelte/compiler'
import ts from 'typescript'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..', '..')
const DEFAULT_SOURCE_DIRECTORIES = ['packages/app/src', 'web/src']
const DEFAULT_ROOT_FILES = ['web/index.html', 'web/wrangler.toml', 'web/wrangler.kv.toml', 'web/wrangler.demo.toml']
const DEFAULT_ALLOWLIST = 'web/scripts/comment-allowlist.json'

export async function checkComments(options = {}) {
  const root = options.root ?? REPOSITORY_ROOT
  const sourceDirectories = options.sourceDirectories ?? DEFAULT_SOURCE_DIRECTORIES
  const rootFiles = options.rootFiles ?? DEFAULT_ROOT_FILES
  const allowlistFile = path.resolve(root, options.allowlistFile ?? DEFAULT_ALLOWLIST)
  const allowed = await readAllowlist(allowlistFile)
  const sourceFiles = (
    await Promise.all(sourceDirectories.map((directory) => findSourceFiles(path.resolve(root, directory))))
  ).flat()
  for (const relativePath of rootFiles) {
    const file = path.resolve(root, relativePath)
    try {
      await readFile(file)
      sourceFiles.push(file)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  const errors = []
  for (const file of sourceFiles.sort()) {
    const source = await readFile(file, 'utf8')
    for (const comment of extractComments(file, source)) {
      const id = commentId(path.relative(root, file), comment)
      if (!allowed.has(id)) errors.push(`${formatPosition(root, file, source, comment.start)}: unapproved ${comment.kind} comment`)
    }
  }
  return errors
}

export async function createCommentAllowlist(options = {}) {
  const root = options.root ?? REPOSITORY_ROOT
  const sourceDirectories = options.sourceDirectories ?? DEFAULT_SOURCE_DIRECTORIES
  const rootFiles = options.rootFiles ?? DEFAULT_ROOT_FILES
  const sourceFiles = (
    await Promise.all(sourceDirectories.map((directory) => findSourceFiles(path.resolve(root, directory))))
  ).flat()
  for (const relativePath of rootFiles) sourceFiles.push(path.resolve(root, relativePath))

  const entries = []
  for (const file of sourceFiles.sort()) {
    let source
    try {
      source = await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const comment of extractComments(file, source)) {
      entries.push(commentId(path.relative(root, file), comment))
    }
  }
  return { version: 1, entries }
}

async function readAllowlist(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (!Array.isArray(parsed.entries) || !parsed.entries.every((entry) => typeof entry === 'string')) {
      throw new Error(`Invalid comment allowlist: ${file}`)
    }
    return new Set(parsed.entries)
  } catch (error) {
    if (error?.code === 'ENOENT') return new Set()
    throw error
  }
}

async function findSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) return findSourceFiles(file)
      if (!entry.isFile() || entry.name.endsWith('.test.ts') || entry.name.endsWith('.dom.test.ts')) return []
      return /\.(?:ts|svelte|css)$/.test(entry.name) ? [file] : []
    }),
  )
  return nested.flat()
}

function extractComments(file, source) {
  if (file.endsWith('.ts')) return extractTypeScriptComments(source)
  if (file.endsWith('.svelte')) return extractSvelteComments(source)
  if (file.endsWith('.css')) return extractDelimitedComments(source, 'css')
  if (file.endsWith('.html')) return extractHtmlComments(source)
  if (file.endsWith('.toml')) return extractTomlComments(source)
  return []
}

function extractTypeScriptComments(source, offset = 0) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source)
  const comments = []
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue
    comments.push({
      kind: token === ts.SyntaxKind.SingleLineCommentTrivia ? 'line' : 'block',
      start: offset + scanner.getTokenPos(),
      text: scanner.getTokenText(),
    })
  }
  return comments
}

function extractSvelteComments(source) {
  const tree = parse(source, { modern: true })
  const comments = tree.comments.map((comment) => ({ kind: 'html', start: comment.start, text: source.slice(comment.start, comment.end) }))
  const scripts = [tree.instance, tree.module].filter(Boolean)
  for (const script of scripts) {
    comments.push(...extractTypeScriptComments(source.slice(script.content.start, script.content.end), script.content.start))
  }
  if (tree.css) comments.push(...extractDelimitedComments(source.slice(tree.css.start, tree.css.end), 'css', tree.css.start))
  return comments
}

function extractHtmlComments(source) {
  const comments = []
  const pattern = /<!--[\s\S]*?-->/g
  for (const match of source.matchAll(pattern)) comments.push({ kind: 'html', start: match.index, text: match[0] })
  return comments
}

function extractDelimitedComments(source, kind, offset = 0) {
  const comments = []
  let quote = null
  let index = 0
  while (index < source.length) {
    const character = source[index]
    if (quote) {
      if (character === '\\') index += 2
      else {
        if (character === quote) quote = null
        index += 1
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      index += 1
      continue
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      const final = end < 0 ? source.length : end + 2
      comments.push({ kind, start: offset + index, text: source.slice(index, final) })
      index = final
      continue
    }
    index += 1
  }
  return comments
}

function extractTomlComments(source) {
  const comments = []
  let offset = 0
  for (const line of source.split('\n')) {
    const start = tomlCommentStart(line)
    if (start >= 0) comments.push({ kind: 'toml', start: offset + start, text: line.slice(start) })
    offset += line.length + 1
  }
  return comments
}

function tomlCommentStart(line) {
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quote) {
      if (character === '\\') index += 1
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '#') return index
  }
  return -1
}

function commentId(relativePath, comment) {
  const digest = createHash('sha256').update(comment.text).digest('hex').slice(0, 16)
  return `${relativePath.replaceAll('\\', '/')}:${comment.start}:${comment.kind}:${digest}`
}

function formatPosition(root, file, source, offset) {
  const before = source.slice(0, offset)
  return `${path.relative(root, file)}:${before.split('\n').length}:${offset - before.lastIndexOf('\n')}`
}

async function main() {
  const errors = await checkComments()
  if (errors.length === 0) return
  for (const error of errors) process.stderr.write(`${error}\n`)
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
