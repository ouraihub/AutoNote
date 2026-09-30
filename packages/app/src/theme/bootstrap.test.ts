import { expect, test } from 'vitest'
import { themeBootstrapScript } from './bootstrap'

test('generates a self-contained bootstrap with the canonical defaults', () => {
  const script = themeBootstrapScript('autonote.ui')

  expect(script).toContain('autonote.ui')
  expect(script).toContain('"cinnabar"')
  expect(script).toContain('"paper"')
  expect(script).toContain("root.dataset.motion='full'")
})
