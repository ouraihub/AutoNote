import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkComments, createCommentAllowlist } from './check-comments.mjs'

test('comment checker accepts exact allowlisted Svelte and public API comments', async () => {
  await withFixture(
    {
      'packages/app/src/api.ts': '/** Public API contract. */\nexport const value = 1\n',
      'web/src/client/view.svelte': '<!-- Template rationale. --><script>/** Script rationale. */ const value = 1</script><style>/* Style rationale. */</style>{value}',
    },
    async (root) => {
      await writeAllowlist(root)
      assert.deepEqual(await run(root), [])
    },
  )
})

test('comment checker rejects unapproved Svelte template script and style comments', async () => {
  await withFixture(
    {
      'packages/app/src/api.ts': 'export const value = 1\n',
      'web/src/client/view.svelte': '<!-- Template rationale. --><script>// Script rationale\nconst value = 1</script><style>/* Style rationale. */</style>{value}',
    },
    async (root) => {
      assert.equal((await run(root)).filter((error) => error.includes('unapproved')).length, 3)
    },
  )
})

test('comment checker ignores URL and Markdown-like markers in strings', async () => {
  await withFixture(
    {
      'packages/app/src/api.ts': "export const url = 'https://example.test/a//b'\nexport const markdown = '```// not a comment```'\n",
      'web/src/client/view.svelte': '<p title="https://example.test/a//b">AutoNote</p>',
    },
    async (root) => assert.deepEqual(await run(root), []),
  )
})

async function run(root) {
  return checkComments({
    root,
    sourceDirectories: ['packages/app/src', 'web/src/client'],
    rootFiles: [],
    allowlistFile: 'web/scripts/comment-allowlist.json',
  })
}

async function writeAllowlist(root) {
  const allowlist = await createCommentAllowlist({
    root,
    sourceDirectories: ['packages/app/src', 'web/src/client'],
    rootFiles: [],
  })
  const file = path.join(root, 'web/scripts/comment-allowlist.json')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(allowlist))
}

async function withFixture(files, action) {
  const root = await mkdtemp(path.join(tmpdir(), 'autonote-comments-'))
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
