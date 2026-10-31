declare module 'markdown-it-footnote' {
  import type MarkdownIt from 'markdown-it'
  const plugin: MarkdownIt.PluginSimple
  export default plugin
}

declare module 'markdown-it-mark' {
  import type MarkdownIt from 'markdown-it'
  const plugin: MarkdownIt.PluginSimple
  export default plugin
}

declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it'
  const plugin: MarkdownIt.PluginWithOptions<{
    enabled?: boolean
    label?: boolean
  }>
  export default plugin
}

declare module 'prismjs/components/prism-markup' {
  const component: unknown
  export default component
}
declare module 'prismjs/components/prism-css' {
  const component: unknown
  export default component
}
declare module 'prismjs/components/prism-clike' {
  const component: unknown
  export default component
}
declare module 'prismjs/components/prism-javascript' {
  const component: unknown
  export default component
}
declare module 'prismjs/components/prism-typescript' {
  const component: unknown
  export default component
}
declare module 'prismjs/components/prism-json' {
  const component: unknown
  export default component
}
declare module 'prismjs/components/prism-markdown' {
  const component: unknown
  export default component
}
declare module 'prismjs/components/prism-bash' {
  const component: unknown
  export default component
}
declare module 'prismjs/components/prism-python' {
  const component: unknown
  export default component
}
declare module 'prismjs/components/prism-rust' {
  const component: unknown
  export default component
}
declare module 'prismjs/components/prism-sql' {
  const component: unknown
  export default component
}
declare module 'prismjs/components/prism-yaml' {
  const component: unknown
  export default component
}
