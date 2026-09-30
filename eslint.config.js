import js from '@eslint/js'
import globals from 'globals'
import importX from 'eslint-plugin-import-x'
import svelte from 'eslint-plugin-svelte'
import tseslint from 'typescript-eslint'
import svelteConfig from './desktop/svelte.config.js'

const TAILWIND_COLOR_SCALES = String.raw`(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)`
const COLOR_PREFIXES = String.raw`(?:bg|text|border|ring|outline|divide|from|via|to|shadow|decoration|accent|caret|fill|stroke|placeholder)`
const HARDCODED_COLOR_CLASS = new RegExp(String.raw`\b${COLOR_PREFIXES}-${TAILWIND_COLOR_SCALES}-\d{2,3}\b`)
const ARBITRARY_COLOR_CLASS = new RegExp(
  String.raw`\b${COLOR_PREFIXES}-\[(?:#|rgba?\(|hsla?\(|okl(?:ch|ab)\(|la[bch]\(|white|black|transparent\b)`,
  'i',
)

const noHardcodedColorScale = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      color: 'Use a semantic color token instead of {{value}}.',
    },
  },
  create(context) {
    const check = (node, value) => {
      const match = HARDCODED_COLOR_CLASS.exec(value) ?? ARBITRARY_COLOR_CLASS.exec(value)
      if (match) context.report({ node, messageId: 'color', data: { value: match[0] } })
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value)
      },
      TemplateElement(node) {
        check(node, node.value.raw)
      },
      SvelteLiteral(node) {
        if (typeof node.value === 'string') check(node, node.value)
      },
    }
  },
}

const SHARED_SOURCE = ['packages/app/src/**/*.{ts,svelte}']
const HOST_SOURCE = ['web/src/client/**/*.{ts,svelte}', 'desktop/src/**/*.{ts,svelte}']

export default [
  {
    ignores: [
      '**/build/**',
      '**/dist/**',
      '**/.svelte-kit/**',
      '**/node_modules/**',
      '**/src-tauri/**',
      'packages/app/src/components/ui/**',
      'packages/app/src/editor/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  {
    files: [...SHARED_SOURCE, ...HOST_SOURCE],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        extraFileExtensions: ['.svelte'],
        parser: tseslint.parser,
        project: ['./packages/app/tsconfig.json', './web/tsconfig.client.json', './desktop/tsconfig.json'],
        svelteConfig,
      },
    },
    plugins: {
      'import-x': importX,
      local: { rules: { 'no-hardcoded-color-scale': noHardcodedColorScale } },
    },
    rules: {
      'no-console': 'error',
      'no-empty': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      'local/no-hardcoded-color-scale': 'error',
      'import-x/no-cycle': 'error',
    },
  },
  {
    files: SHARED_SOURCE,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@tauri-apps/*'], message: 'Shared app code cannot depend on Tauri.' },
            {
              group: ['../../web/**', '../../../web/**', '../../desktop/**', '../../../desktop/**'],
              message: 'Shared app code cannot depend on a host.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/app/src/components/**/*.svelte', 'packages/app/src/features/**/*.svelte'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@tauri-apps/*'], message: 'Components cannot call Tauri directly.' },
            { group: ['@app/backend/*'], message: 'Components receive state and callbacks through props.' },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='fetch']",
          message: 'Components cannot call fetch directly; use injected state or callbacks.',
        },
      ],
    },
  },
  {
    files: ['web/src/client/**/*.{ts,svelte}'],
    ignores: [
      'web/src/client/platform/{prefs,timers,page-signals}.ts',
      'web/src/client/runtime.ts',
      'web/src/client/log/console-ring-logger.ts',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Use the injected HttpTransport boundary.' },
        { name: 'indexedDB', message: 'Use the injected KvStore boundary.' },
        { name: 'BroadcastChannel', message: 'Use the injected TabBus boundary.' },
        { name: 'WebSocket', message: 'Use the injected SocketFactory boundary.' },
        { name: 'localStorage', message: 'Use WebPrefsStore or the injected KvStore boundary.' },
        { name: 'navigator', message: 'Use a platform boundary for navigator APIs.' },
      ],
    },
  },
  {
    files: ['web/src/client/platform/{prefs,timers,page-signals}.ts', 'web/src/client/runtime.ts'],
    rules: {
      'no-restricted-globals': 'off',
    },
  },
  {
    files: ['web/src/client/log/console-ring-logger.ts'],
    rules: {
      'no-console': 'off',
    },
  },
]
