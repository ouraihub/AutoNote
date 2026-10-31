import Prism from 'prismjs'

export interface PrismHighlight {
  readonly html: string
  readonly language: string
}

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  html: 'markup',
  xml: 'markup',
  js: 'javascript',
  ts: 'typescript',
  sh: 'bash',
  shell: 'bash',
  py: 'python',
  yml: 'yaml',
  dockerfile: 'docker',
  'c++': 'cpp',
  'c#': 'csharp',
}

const LOADERS: Readonly<Record<string, () => Promise<unknown>>> = {
  markup: () => import('prismjs/components/prism-markup'),
  css: () => import('prismjs/components/prism-css'),
  clike: () => import('prismjs/components/prism-clike'),
  javascript: () => import('prismjs/components/prism-javascript'),
  typescript: () => import('prismjs/components/prism-typescript'),
  json: () => import('prismjs/components/prism-json'),
  markdown: () => import('prismjs/components/prism-markdown'),
  bash: () => import('prismjs/components/prism-bash'),
  python: () => import('prismjs/components/prism-python'),
  rust: () => import('prismjs/components/prism-rust'),
  sql: () => import('prismjs/components/prism-sql'),
  yaml: () => import('prismjs/components/prism-yaml'),
}

const loading = new Map<string, Promise<void>>()

export async function highlightWithPrism(
  source: string,
  requestedLanguage: string,
): Promise<PrismHighlight | null> {
  const language =
    LANGUAGE_ALIASES[requestedLanguage.toLowerCase()] ??
    requestedLanguage.toLowerCase()
  const loader = LOADERS[language]
  if (!loader) return null
  await loadLanguage(language, loader)
  const grammar = Prism.languages[language]
  if (!grammar) return null
  return { html: Prism.highlight(source, grammar, language), language }
}

function loadLanguage(
  language: string,
  loader: () => Promise<unknown>,
): Promise<void> {
  const current = loading.get(language)
  if (current) return current
  const pending = (async () => {
    for (const dependency of dependencies(language)) {
      const dependencyLoader = LOADERS[dependency]
      if (dependencyLoader) await loadLanguage(dependency, dependencyLoader)
    }
    await loader()
  })()
  loading.set(language, pending)
  return pending.finally(() => loading.delete(language))
}

function dependencies(language: string): readonly string[] {
  if (language === 'css') return ['markup']
  if (language === 'javascript') return ['markup', 'clike']
  if (language === 'typescript') return ['javascript']
  if (language === 'json') return ['javascript']
  if (language === 'markdown') return ['markup', 'yaml']
  if (language === 'rust' || language === 'sql' || language === 'python')
    return ['clike']
  if (language === 'yaml') return ['markup']
  return []
}
