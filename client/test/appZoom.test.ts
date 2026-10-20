import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getAppZoom, setupAppZoom } from '../src/appZoom'
import { getZoomPreferences, setZoomPreference, subscribeZoomPreferences } from '../src/zoomPreferences'

class WheelTarget {
  constructor(private selectors: string[]) {}
  closest(selector: string) {
    return this.selectors.includes(selector) ? this : null
  }
}

describe('全局缩放快捷键', () => {
  let target: EventTarget
  let styles: Map<string, string>
  let storage: Map<string, string>
  let cleanup: (() => void) | undefined
  const originals = new Map<string, PropertyDescriptor | undefined>()
  beforeEach(() => {
    styles = new Map()
    storage = new Map()
    target = new EventTarget()
    const globals = {
      Element: WheelTarget,
      window: {
        addEventListener: (type: string, listener: EventListener, options: boolean | AddEventListenerOptions) =>
          target.addEventListener(type, listener, typeof options === 'boolean' ? { capture: options } : options),
        removeEventListener: (type: string, listener: EventListener, options: boolean) =>
          target.removeEventListener(type, listener, { capture: options }),
      },
      document: { documentElement: { style: {
        setProperty: (key: string, value: string) => styles.set(key, value),
        getPropertyValue: (key: string) => styles.get(key) ?? '',
      } } },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    }
    for (const [key, value] of Object.entries(globals)) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      Object.defineProperty(globalThis, key, { configurable: true, value })
    }
  })
  afterEach(() => {
    cleanup?.()
    cleanup = undefined
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  function key(key: string, options: Record<string, unknown> = {}) {
    const event = new Event('keydown', { cancelable: true })
    Object.assign(event, { key, ctrlKey: true, ...options })
    target.dispatchEvent(event)
    return event
  }
  function wheel(selectors: string[], deltaY = -100, options: Record<string, unknown> = {}) {
    const event = new Event('wheel', { cancelable: true })
    Object.assign(event, { ctrlKey: true, deltaY, ...options })
    Object.defineProperty(event, 'target', { value: new WheelTarget(selectors) })
    target.dispatchEvent(event)
    return event
  }

  it('仅 AI 助手消息支持滚轮文字缩放，其他页面及非正文区域保持不变', () => {
    cleanup = setupAppZoom()
    const message = ['[data-ai-page]', '.assistant-message-text']
    wheel(message)
    assert.deepEqual(getZoomPreferences(), { global: 100, reply: 110 })
    wheel(message, 100)
    assert.deepEqual(getZoomPreferences(), { global: 100, reply: 100 })

    for (const selectors of [
      ['.markdown-body'], ['.cm-editor'], ['textarea'], ['.ant-table-wrapper'],
      ['.ant-card-body'], ['.page-content'], ['.assistant-message-text'],
      ['[data-ai-page]'],
      [...message, 'button, [role="button"], .md-code-head'],
    ]) {
      assert.equal(wheel(selectors).defaultPrevented, true)
      assert.deepEqual(getZoomPreferences(), { global: 100, reply: 100 })
    }
    assert.equal(wheel(message, -100, { ctrlKey: false }).defaultPrevented, false)
    assert.equal(wheel(message, -100, { altKey: true }).defaultPrevented, false)
    assert.equal(wheel(message, 0).defaultPrevented, false)
    assert.deepEqual(getZoomPreferences(), { global: 100, reply: 100 })
    key('+')
    assert.deepEqual(getZoomPreferences(), { global: 110, reply: 100 })
    cleanup()
    assert.equal(wheel(message).defaultPrevented, false)
    assert.deepEqual(getZoomPreferences(), { global: 110, reply: 100 })
  })

  it('主键盘与小键盘加减、恢复默认，并阻止浏览器重复缩放', () => {
    cleanup = setupAppZoom()
    assert.equal(getAppZoom(), 1)
    assert.equal(key('+').defaultPrevented, true)
    assert.equal(getAppZoom(), 1.1)
    key('=')
    key('Add', { code: 'NumpadAdd' })
    assert.equal(getAppZoom(), 1.3)
    key('-')
    key('Subtract', { code: 'NumpadSubtract' })
    assert.equal(getAppZoom(), 1.1)
    key('0')
    assert.equal(getAppZoom(), 1)
    assert.equal(storage.get('icpc-app-zoom'), '100')
  })
  it('限制 50%–200%，重新初始化时恢复保存的比例', () => {
    storage.set('icpc-app-zoom', '150')
    cleanup = setupAppZoom()
    assert.equal(getAppZoom(), 1.5)
    for (let i = 0; i < 30; i++) key('+')
    assert.equal(getAppZoom(), 2)
    for (let i = 0; i < 30; i++) key('-')
    assert.equal(getAppZoom(), 0.5)
    cleanup()
    cleanup = setupAppZoom()
    assert.equal(getAppZoom(), 0.5)
  })
  it('普通按键、Alt 组合和输入法不触发；支持 macOS Cmd', () => {
    cleanup = setupAppZoom()
    for (const options of [{ ctrlKey: false }, { altKey: true }, { isComposing: true }]) {
      assert.equal(key('+', options).defaultPrevented, false)
    }
    assert.equal(key('k').defaultPrevented, false)
    assert.equal(getAppZoom(), 1)
    key('+', { ctrlKey: false, metaKey: true })
    assert.equal(getAppZoom(), 1.1)
  })
  it('坏存档和存储不可用时仍能缩放，清理后不再响应', () => {
    storage.set('icpc-app-zoom', 'Infinity')
    cleanup = setupAppZoom()
    assert.equal(getAppZoom(), 1)
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('unavailable') } })
    key('+')
    assert.equal(getAppZoom(), 1.1)
    cleanup()
    cleanup = setupAppZoom()
    assert.equal(getAppZoom(), 1)
    cleanup()
    key('+')
    assert.equal(getAppZoom(), 1)
  })
  it('回复字号独立保存、限制上下界、可重置；按钮与快捷键共享状态', () => {
    storage.set('icpc-ai-reply-zoom', '120')
    cleanup = setupAppZoom()
    assert.deepEqual(getZoomPreferences(), { global: 100, reply: 120 })
    let changes = 0
    const unsubscribe = subscribeZoomPreferences(() => changes++)
    try {
      setZoomPreference('reply', 500)
      assert.equal(getZoomPreferences().reply, 200)
      assert.equal(getAppZoom(), 1)
      setZoomPreference('reply', 1)
      assert.equal(getZoomPreferences().reply, 50)
      setZoomPreference('reply', 100)
      assert.equal(storage.get('icpc-ai-reply-zoom'), '100')
      setZoomPreference('global', 130)
      key('-')
      assert.deepEqual(getZoomPreferences(), { global: 120, reply: 100 })
      assert.equal(changes, 5)
      setZoomPreference('reply', NaN)
      assert.equal(changes, 5)
    } finally { unsubscribe() }
  })
})
