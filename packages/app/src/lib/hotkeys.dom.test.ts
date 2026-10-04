import { afterEach, expect, test, vi } from 'vitest'
import { createHotkeys } from './hotkeys'

const targets: HTMLElement[] = []
afterEach(() => targets.splice(0).forEach((target) => target.remove()))

function target(): HTMLElement {
  const element = document.createElement('div')
  document.body.append(element)
  targets.push(element)
  return element
}

test('isolates targets, binds registerAll to its instance, and removes listeners on dispose', () => {
  const first = target()
  const second = target()
  const left = createHotkeys({ target: first })
  const right = createHotkeys({ target: second })
  const firstHandler = vi.fn()
  const secondHandler = vi.fn()
  left.registerAll([{ id: 'first', combo: 'ctrl+k', description: 'First', group: 'Test', handler: firstHandler }])
  right.registerAll([{ id: 'second', combo: 'ctrl+k', description: 'Second', group: 'Test', handler: secondHandler }])

  first.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true }))
  expect(firstHandler).toHaveBeenCalledOnce()
  expect(secondHandler).not.toHaveBeenCalled()
  second.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true }))
  expect(secondHandler).toHaveBeenCalledOnce()

  left.dispose()
  first.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true }))
  expect(firstHandler).toHaveBeenCalledOnce()
})

test('does not steal ordinary input or CodeMirror editor shortcuts', () => {
  const host = target()
  const hotkeys = createHotkeys({ target: host })
  const handler = vi.fn()
  hotkeys.register({ id: 'save', combo: 'ctrl+s', description: 'Save', group: 'Test', handler })
  const input = document.createElement('input')
  host.append(input)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true }))
  expect(handler).not.toHaveBeenCalled()

  const editor = document.createElement('div')
  editor.className = 'cm-editor'
  const content = document.createElement('div')
  editor.append(content)
  host.append(editor)
  content.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true }))
  expect(handler).not.toHaveBeenCalled()

  hotkeys.register({ id: 'palette', combo: 'ctrl+p', description: 'Palette', group: 'Test', handler, allowInInput: true })
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }))
  expect(handler).toHaveBeenCalledOnce()
})
