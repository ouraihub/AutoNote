import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'svelte/compiler'
import ts from 'typescript'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..', '..')
const DEFAULT_SOURCE_DIRECTORIES = ['packages/app/src', 'web/src/client']
const DEFAULT_LOCALE_FILES = ['packages/shared/src/locales/en-US.ts', 'packages/shared/src/locales/zh-CN.ts']
const VISIBLE_ATTRIBUTE_NAMES = new Set(['aria-label', 'aria-description', 'placeholder', 'title'])
const ALLOWED_TEMPLATE_TEXT = new Set(['AutoNote', ':', '[[ ]]', '#', 'Tab', '000000'])

export async function checkI18n(options = {}) {
  const root = options.root ?? REPOSITORY_ROOT
  const sourceDirectories = options.sourceDirectories ?? DEFAULT_SOURCE_DIRECTORIES
  const localeFiles = options.localeFiles ?? DEFAULT_LOCALE_FILES
  const errors = []
  const locales = await Promise.all(localeFiles.map((file) => readLocale(path.resolve(root, file))))
  const [english, chinese] = locales
  compareLocaleKeys(english, chinese, errors)
  compareLocalePlaceholders(english, chinese, errors)

  const sourceFiles = (
    await Promise.all(sourceDirectories.map((directory) => findSourceFiles(path.resolve(root, directory))))
  ).flat()
  const keys = new Set(english.keys())
  for (const file of sourceFiles) {
    const source = await readFile(file, 'utf8')
    if (file.endsWith('.svelte')) checkSvelteFile(file, source, keys, errors)
    else checkTypeScriptFile(file, source, keys, errors)
  }
  return errors
}

async function readLocale(file) {
  const source = await readFile(file, 'utf8')
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaration = parsed.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) && statement.declarationList.declarations.some((item) => item.name.getText(parsed).endsWith('MESSAGES')),
  )
  if (!declaration || !ts.isVariableStatement(declaration)) throw new Error(`Missing locale message object: ${file}`)
  const object = unwrapLocaleObject(declaration.declarationList.declarations[0]?.initializer)
  if (!object) throw new Error(`Unsupported locale message object: ${file}`)
  const values = new Map()
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.name) || !ts.isStringLiteralLike(property.initializer)) {
      throw new Error(`Locale entries must be static strings: ${formatPosition(file, source, property.getStart(parsed))}`)
    }
    values.set(property.name.text, property.initializer.text)
  }
  return values
}

function unwrapLocaleObject(value) {
  if (!value) return null
  if (ts.isObjectLiteralExpression(value)) return value
  if (ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) return unwrapLocaleObject(value.expression)
  return null
}

function compareLocaleKeys(english, chinese, errors) {
  for (const key of english.keys()) if (!chinese.has(key)) errors.push(`Missing zh-CN key: ${key}`)
  for (const key of chinese.keys()) if (!english.has(key)) errors.push(`Unexpected zh-CN key: ${key}`)
}

function compareLocalePlaceholders(english, chinese, errors) {
  for (const [key, englishText] of english) {
    const chineseText = chinese.get(key)
    if (chineseText === undefined) continue
    const englishPlaceholders = placeholders(englishText)
    const chinesePlaceholders = placeholders(chineseText)
    if (englishPlaceholders.join(',') !== chinesePlaceholders.join(',')) {
      errors.push(`Mismatched placeholders for ${key}: en-US={${englishPlaceholders.join(',')}} zh-CN={${chinesePlaceholders.join(',')}}`)
    }
  }
}

function placeholders(value) {
  return [...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).sort()
}

async function findSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'components' || entry.name === 'editor') return []
        return findSourceFiles(file)
      }
      if (!entry.isFile() || entry.name.endsWith('.test.ts') || entry.name.endsWith('.dom.test.ts')) return []
      return entry.name.endsWith('.ts') || entry.name.endsWith('.svelte') ? [file] : []
    }),
  )
  return nested.flat()
}

function checkTypeScriptFile(file, source, keys, errors) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  visitTypeScript(parsed, (node) => {
    if (!ts.isCallExpression(node) || !isTranslationCall(node.expression)) return
    const key = node.arguments[0]
    if (!key || !ts.isStringLiteralLike(key)) {
      if (key && ts.isAsExpression(key) && key.type.getText(parsed) === "Parameters<I18nState['t']>[0]") return
      errors.push(`${formatPosition(file, source, node.getStart(parsed))}: translation keys must be static`)
      return
    }
    if (!keys.has(key.text)) errors.push(`${formatPosition(file, source, key.getStart(parsed))}: unknown translation key ${key.text}`)
  })
}

function visitTypeScript(node, visit) {
  visit(node)
  ts.forEachChild(node, (child) => visitTypeScript(child, visit))
}

function isTranslationCall(expression) {
  return ts.isIdentifier(expression) && expression.text === 't' || ts.isPropertyAccessExpression(expression) && expression.name.text === 't'
}

function checkSvelteFile(file, source, keys, errors) {
  let tree
  try {
    tree = parse(source, { filename: file, modern: true })
  } catch (error) {
    errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const keyTables = new Set()
  visitSvelte(tree.instance?.content?.body ?? tree.instance, (node) => {
    if (node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier' || !node.init) return
    const annotation = source.slice(node.id.typeAnnotation?.start ?? node.id.end, node.id.typeAnnotation?.end ?? node.id.end)
    const constant = node.init.type === 'TSAsExpression' && source.slice(node.init.typeAnnotation.start, node.init.typeAnnotation.end) === 'const'
    if (!annotation.includes('MessageKey') && !constant) return
    const initializer = constant ? node.init.expression : node.init
    if (initializer.type !== 'ObjectExpression' && initializer.type !== 'ArrayExpression') return
    const literals = []
    visitSvelte(initializer, (child, parent) => {
      if (child.type === 'Literal' && typeof child.value === 'string' && child.value.includes('.') && parent?.type !== 'Property') literals.push(child.value)
      if (parent?.type === 'Property' && parent.value === child && child.type === 'Literal' && typeof child.value === 'string' && child.value.includes('.')) literals.push(child.value)
    })
    if (literals.length && literals.every((value) => keys.has(value))) keyTables.add(node.id.name)
  })
  visitSvelte(tree.fragment, (node, parent) => {
    if (node.type === 'Text' && parent?.type === 'Fragment') {
      const text = node.data.trim()
      if (text.length > 1 && !ALLOWED_TEMPLATE_TEXT.has(text)) {
        errors.push(`${formatPosition(file, source, node.start)}: visible text must use a translation key: ${JSON.stringify(text)}`)
      }
    }
    if (node.type === 'Attribute' && VISIBLE_ATTRIBUTE_NAMES.has(node.name)) {
      const text = staticAttributeText(node)
      if (text && !ALLOWED_TEMPLATE_TEXT.has(text)) {
        errors.push(`${formatPosition(file, source, node.start)}: ${node.name} must use a translation key: ${JSON.stringify(text)}`)
      }
    }
    if (node.type === 'CallExpression' && isSvelteTranslationCall(node)) {
      const key = node.arguments[0]
      if (key?.type === 'Literal' && typeof key.value === 'string') {
        if (!keys.has(key.value)) errors.push(`${formatPosition(file, source, key.start)}: unknown translation key ${key.value}`)
      } else if (!key || !isBoundedTranslation(key, source, keys, keyTables)) {
        errors.push(`${formatPosition(file, source, node.start)}: translation keys must be static or bounded`)
      }
    }
  })
}
function isBoundedTranslation(node, source, keys, tables) {
  if (node.type === 'Literal') return typeof node.value === 'string' && keys.has(node.value)
  if (node.type === 'ConditionalExpression') return isBoundedTranslation(node.consequent, source, keys, tables) && isBoundedTranslation(node.alternate, source, keys, tables)
  if (node.type === 'LogicalExpression' && node.operator === '??') return isBoundedTranslation(node.left, source, keys, tables) && isBoundedTranslation(node.right, source, keys, tables)
  if (node.type === 'CallExpression' && node.callee?.type === 'Identifier') return node.callee.name === 'messageKeyForError' || node.callee.name === 'cloudError'
  if (node.type === 'TSAsExpression' && source.slice(node.typeAnnotation.start, node.typeAnnotation.end) === 'MessageKey') return true
  if (node.type !== 'MemberExpression') return false
  const text = source.slice(node.start, node.end)
  return [...tables].some((table) => text.startsWith(`${table}[`) || text.startsWith(`${table}.`) || text.startsWith(`${table}?.`)) ||
    /^(option|slider|item|scale)\.(label|names\[)/.test(text) && [...tables].some((table) => ['options', 'scales', 'editorSliders', 'editorSwitches', 'previewSwitches', 'filters'].includes(table))
}

function visitSvelte(value, visit, seen = new Set(), parent = null) {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if ('type' in value && typeof value.type === 'string') visit(value, parent)
  if (Array.isArray(value)) {
    for (const item of value) visitSvelte(item, visit, seen, parent)
    return
  }
  for (const child of Object.values(value)) visitSvelte(child, visit, seen, value)
}

function staticAttributeText(attribute) {
  if (!Array.isArray(attribute.value) || attribute.value.length !== 1 || attribute.value[0]?.type !== 'Text') return null
  return attribute.value[0].data.trim() || null
}

function isSvelteTranslationCall(expression) {
  return expression.callee?.type === 'Identifier' && expression.callee.name === 't' || expression.callee?.type === 'MemberExpression' && expression.callee.property?.name === 't'
}

function formatPosition(file, source, offset) {
  const before = source.slice(0, offset)
  const line = before.split('\n').length
  const column = offset - before.lastIndexOf('\n')
  return `${path.relative(REPOSITORY_ROOT, file)}:${line}:${column}`
}

async function main() {
  const errors = await checkI18n()
  if (errors.length === 0) return
  for (const error of errors) process.stderr.write(`${error}\n`)
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main()
