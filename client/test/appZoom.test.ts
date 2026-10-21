import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getAppZoom, setupAppZoom } from '../src/appZoom'
import { getZoomPreferences, setZoomPreference, subscribeZoomPreferences, zoomMultipleLabel } from '../src/zoomPreferences'

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
    Object.assign(event, { ctrlKey: true, deltaY })
    // timeStamp 在 Event 上是只读 getter，insky Object.assign 覆盖不了，需单独 defineProperty
    const { timeStamp, ...rest } = options
    Object.assign(event, rest)
    if (timeStamp !== undefined) Object.defineProperty(event, 'timeStamp', { value: timeStamp })
    Object.defineProperty(event, 'target', { value: new WheelTarget(selectors) })
    target.dispatchEvent(event)
    return event
  }

  it('仅 AI 助手消息支持滚轮文字缩放，其他页面及非正文区域保持不变', () => {
    cleanup = setupAppZoom()
    const message = ['[data-ai-page]', '.assistant-message-text']
    wheel(message)
    assert.deepEqual(getZoomPreferences(), { global: 100, reply: 110, note: 100 })
    wheel(message, 100)
    assert.deepEqual(getZoomPreferences(), { global: 100, reply: 100, note: 100 })

    for (const selectors of [
      ['.markdown-body'], ['.cm-editor'], ['textarea'], ['.ant-table-wrapper'],
      ['.ant-card-body'], ['.page-content'], ['.assistant-message-text'],
      ['[data-ai-page]'],
      [...message, 'button, [role="button"], .md-code-head'],
    ]) {
      assert.equal(wheel(selectors).defaultPrevented, true)
      assert.deepEqual(getZoomPreferences(), { global: 100, reply: 100, note: 100 })
    }
    assert.equal(wheel(message, -100, { ctrlKey: false }).defaultPrevented, false)
    assert.equal(wheel(message, -100, { altKey: true }).defaultPrevented, false)
    assert.equal(wheel(message, 0).defaultPrevented, false)
    assert.deepEqual(getZoomPreferences(), { global: 100, reply: 100, note: 100 })
    key('+')
    assert.deepEqual(getZoomPreferences(), { global: 110, reply: 100, note: 100 })
    cleanup()
    assert.equal(wheel(message).defaultPrevented, false)
    assert.deepEqual(getZoomPreferences(), { global: 110, reply: 100, note: 100 })
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
    assert.deepEqual(getZoomPreferences(), { global: 100, reply: 120, note: 100 })
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
      assert.deepEqual(getZoomPreferences(), { global: 120, reply: 100, note: 100 })
      assert.equal(changes, 5)
      setZoomPreference('reply', NaN)
      assert.equal(changes, 5)
    } finally { unsubscribe() }
  })

  it('笔记卡片内滚轮独立缩放 note 字号，与全局/回复互不影响、上下界钳制、可持久化', () => {
    cleanup = setupAppZoom()
    const card = ['[data-note-zoom]']
    wheel(card)
    assert.deepEqual(getZoomPreferences(), { global: 100, reply: 100, note: 110 })
    wheel(card, 100)
    assert.deepEqual(getZoomPreferences(), { global: 100, reply: 100, note: 100 })
    // 连续上滚放大再下滚缩小：同向事件需错开 timeStamp，否则被 80ms 去抖吞掉
    wheel(card, -100, { timeStamp: 100 })
    wheel(card, -100, { timeStamp: 200 })
    assert.equal(getZoomPreferences().note, 120)
    wheel(card, 100, { timeStamp: 300 })
    assert.equal(getZoomPreferences().note, 110)
    // 把 note 拉满/拉到底，验证上下界（重复滚取整到步长，每次错开 80ms 以上绕过去抖）
    for (let i = 0; i < 30; i++) wheel(card, -100, { timeStamp: 400 + i * 100 })
    assert.equal(getZoomPreferences().note, 200)
    for (let i = 0; i < 30; i++) wheel(card, 100, { timeStamp: 3500 + i * 100 })
    assert.equal(getZoomPreferences().note, 50)
    // 笔记在卡片内滚不影响全局与回复字号
    assert.deepEqual(getZoomPreferences(), { global: 100, reply: 100, note: 50 })
    assert.equal(styles.get('--note-text-zoom'), '0.5')
    // 卡片区域之外的 Ctrl+滚轮（如标题栏）不改 note 字号
    const before = getZoomPreferences().note
    assert.equal(wheel([], -100).defaultPrevented, true)
    assert.equal(getZoomPreferences().note, before)
    assert.equal(wheel(['button, [role="button"]'], -100).defaultPrevented, true)
    assert.equal(getZoomPreferences().note, before)
    // 持久化：cleanup 后重新初始化能恢复保存的 note 比例
    cleanup()
    storage.set('icpc-note-text-zoom', '150')
    cleanup = setupAppZoom()
    assert.equal(getZoomPreferences().note, 150)
    assert.equal(storage.get('icpc-note-text-zoom'), '150')
    // 清理后不再响应
    cleanup()
    assert.equal(wheel(card, -100).defaultPrevented, false)
    assert.equal(getZoomPreferences().note, 150)
  })

  it('zoomMultipleLabel: 各档位倍数文案', () => {
    assert.equal(zoomMultipleLabel(100), '1×')
    assert.equal(zoomMultipleLabel(110), '1.1×')
    assert.equal(zoomMultipleLabel(120), '1.2×')
    assert.equal(zoomMultipleLabel(50), '0.5×')
    assert.equal(zoomMultipleLabel(200), '2×')
    assert.equal(zoomMultipleLabel(1), '0.01×')
    assert.equal(zoomMultipleLabel(NaN), '1×')
    assert.equal(zoomMultipleLabel(Infinity), '1×')
  })
})
