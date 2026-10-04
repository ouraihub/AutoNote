import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkI18n } from './check-i18n.mjs'

test('i18n checker accepts translated Svelte and TypeScript calls', async () => {
  await withFixture(
    {
      'packages/shared/src/locales/en-US.ts': locale('Open {name}'),
      'packages/shared/src/locales/zh-CN.ts': locale('打开 {name}'),
      'packages/app/src/view.svelte': '<script>const label = t(\'known.key\')</script><button>{label}</button>',
      'web/src/client/use.ts': "const label = t('known.key')\nvoid label\n",
    },
    async (root) => assert.deepEqual(await run(root), []),
  )
})

test('i18n checker rejects unknown translation keys and untranslated aria labels', async () => {
  await withFixture(
    {
      'packages/shared/src/locales/en-US.ts': locale('Open'),
      'packages/shared/src/locales/zh-CN.ts': locale('打开'),
      'packages/app/src/view.svelte': '<button aria-label="Open">AutoNote</button>',
      'web/src/client/use.ts': "const label = t('missing.key')\nvoid label\n",
    },
    async (root) => {
      const errors = await run(root)
      assert.equal(errors.some((error) => error.includes('unknown translation key missing.key')), true)
      assert.equal(errors.some((error) => error.includes('aria-label must use a translation key')), true)
    },
  )
})

test('i18n checker accepts finite typed key tables but rejects unknown entries and unbounded keys', async () => {
  await withFixture(
    {
      'packages/shared/src/locales/en-US.ts': locale('Open'),
      'packages/shared/src/locales/zh-CN.ts': locale('打开'),
      'packages/app/src/view.svelte': `<script lang="ts">
        type MessageKey = 'known.key'
        const labels: Record<string, MessageKey> = { first: 'known.key' }
        const bad: Record<string, MessageKey> = { first: 'missing.key' }
        let arbitrary = 'known.key'
      </script><button>{t(labels['first'])}</button><button>{t(bad['first'])}</button><button>{t(arbitrary)}</button>`,
      'web/src/client/use.ts': "const label = t('known.key')\nvoid label\n",
    },
    async (root) => {
      const errors = await run(root)
      assert.equal(errors.filter((error) => error.includes('translation keys must be static or bounded')).length, 2)
    },
  )
})

test('i18n checker rejects mismatched locale interpolation placeholders', async () => {
  await withFixture(
    {
      'packages/shared/src/locales/en-US.ts': locale('Open {name}'),
      'packages/shared/src/locales/zh-CN.ts': locale('打开 {title}'),
      'packages/app/src/view.svelte': '<p>AutoNote</p>',
      'web/src/client/use.ts': "const label = t('known.key')\nvoid label\n",
    },
    async (root) => {
      const errors = await run(root)
      assert.equal(errors.some((error) => error.includes('Mismatched placeholders for known.key')), true)
    },
  )
})

function locale(value) {
  return `export const EN_US_MESSAGES = { 'known.key': '${value}' } as const\n`
}

async function run(root) {
  return checkI18n({
    root,
    sourceDirectories: ['packages/app/src', 'web/src/client'],
    localeFiles: ['packages/shared/src/locales/en-US.ts', 'packages/shared/src/locales/zh-CN.ts'],
  })
}

async function withFixture(files, action) {
  const root = await mkdtemp(path.join(tmpdir(), 'autonote-i18n-'))
  try {
    await Promise.all(
      Object.entries(files).map(async ([relativePath, content]) => {
        const file = path.join(root, relativePath)
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, content)
      }),
    )
    await action(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
