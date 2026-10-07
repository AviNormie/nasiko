import { afterEach, describe, expect, it } from 'vitest'
import { isTypingTarget, stepFromKey } from './keys'

afterEach(() => {
  document.body.innerHTML = ''
})

/** Dispatches a keydown on `target` and returns what stepFromKey made of it. */
function step(key: string, target: Element, control: Element | null, init: KeyboardEventInit = {}) {
  let out: number | undefined
  const on = (e: KeyboardEvent) => {
    out = stepFromKey(e, control)
  }
  document.addEventListener('keydown', on)
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
  document.removeEventListener('keydown', on)
  return out
}

function el(html: string) {
  document.body.innerHTML = html
  return document.body
}

describe('stepFromKey', () => {
  it('reads j as next and k as previous, anything else as nothing', () => {
    const body = el('<div id="c"></div>')
    const control = body.querySelector('#c')
    expect(step('j', body, control)).toBe(1)
    expect(step('k', body, control)).toBe(-1)
    expect(step('x', body, control)).toBe(0)
    expect(step('J', body, control)).toBe(0)
  })

  it('ignores modifiers and key repeat', () => {
    const body = el('<div id="c"></div>')
    const control = body.querySelector('#c')
    expect(step('j', body, control, { metaKey: true })).toBe(0)
    expect(step('j', body, control, { ctrlKey: true })).toBe(0)
    expect(step('j', body, control, { altKey: true })).toBe(0)
    expect(step('j', body, control, { repeat: true })).toBe(0)
  })

  it('ignores typing and menu or listbox typeahead', () => {
    const body = el(
      '<div id="c"></div><input id="i" /><textarea id="t"></textarea><div role="menu"><div id="m" tabindex="0"></div></div><div role="listbox"><div id="l"></div></div>',
    )
    const control = body.querySelector('#c')
    for (const id of ['#i', '#t', '#m', '#l'])
      expect(step('j', body.querySelector(id)!, control)).toBe(0)
  })

  it('works inside a dialog only when the control is in that dialog', () => {
    const body = el(
      '<div id="page"></div><div role="dialog"><button id="b"></button><div id="c"></div></div>',
    )
    const inDialog = body.querySelector('#b')!
    expect(step('j', inDialog, body.querySelector('#page'))).toBe(0)
    expect(step('j', inDialog, body.querySelector('#c'))).toBe(1)
  })
})

describe('isTypingTarget', () => {
  it('is true inside inputs, textareas and selects', () => {
    const body = el('<label><input id="i" /></label><select id="s"></select><p id="p"></p>')
    expect(isTypingTarget(body.querySelector('#i'))).toBe(true)
    expect(isTypingTarget(body.querySelector('#s'))).toBe(true)
    expect(isTypingTarget(body.querySelector('#p'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})
