/**
 * chunkRecovery 单元测试（issue #65）。
 *
 * 锁三条底线：
 * 1. 只有「chunk 取不到」这一类错误触发自愈，普通业务异常不能被吞掉重载；
 * 2. 冷却窗口内的二次失败不再刷新（防「重载→仍旧资源→再重载」死循环）；
 * 3. Vite 的 vite:preloadError 必须 preventDefault，否则事件派发后仍会再抛一次。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  RELOAD_COOLDOWN_MS,
  RELOAD_STAMP_KEY,
  isChunkLoadError,
  shouldReload,
} from '../src/chunkRecovery'

describe('shouldReload', () => {
  it('本次会话没重载过 → 允许自愈', () => {
    assert.equal(shouldReload(null, 1_000), true)
  })

  it('冷却窗口内 → 拒绝（防死循环）', () => {
    assert.equal(shouldReload(1_000, 1_000 + RELOAD_COOLDOWN_MS - 1), false)
  })

  it('冷却窗口到点 → 再次允许', () => {
    assert.equal(shouldReload(1_000, 1_000 + RELOAD_COOLDOWN_MS), true)
  })

  it('时间戳回拨/脏值不至于永久禁用自愈', () => {
    assert.equal(shouldReload(Number.NaN, 5_000), true)
    assert.equal(shouldReload(Infinity, 5_000), true)
  })
})

describe('isChunkLoadError', () => {
  it('识别 Chromium 的动态 import 失败', () => {
    assert.equal(
      isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:3001/assets/index-AbCd1234.js')),
      true,
    )
  })

  it('识别 Safari/WebKit 与 webpack 形态', () => {
    assert.equal(isChunkLoadError(new Error('Importing a module script failed.')), true)
    assert.equal(isChunkLoadError(new Error('Loading chunk 42 failed.')), true)
    assert.equal(isChunkLoadError(new Error('Unable to preload CSS for /assets/x-AbCd1234.css')), true)
  })

  it('支持字符串入参（未处理 rejection 里可能是字符串）', () => {
    assert.equal(isChunkLoadError('ChunkLoadError: Loading chunk 1 failed'), true)
  })

  it('普通业务错误不触发自愈', () => {
    assert.equal(isChunkLoadError(new Error('接口返回 500')), false)
    assert.equal(isChunkLoadError(null), false)
    assert.equal(isChunkLoadError(undefined), false)
    assert.equal(isChunkLoadError(''), false)
  })
})

/** 最小 window + sessionStorage 替身：模块通过 globalThis 取用，可随时替换 */
function installEnv(): {
  reloads: () => number
  emit: (type: string, ev: Record<string, unknown>) => { defaultPrevented: boolean }
  reset: () => void
} {
  const store = new Map<string, string>()
  ;(globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  }
  const handlers = new Map<string, ((e: Record<string, unknown>) => void)[]>()
  const win = {
    addEventListener: (type: string, fn: (e: Record<string, unknown>) => void) => {
      const list = handlers.get(type) ?? []
      list.push(fn)
      handlers.set(type, list)
    },
    removeEventListener: (type: string, fn: (e: Record<string, unknown>) => void) => {
      const list = handlers.get(type) ?? []
      handlers.set(type, list.filter((h) => h !== fn))
    },
    location: { reload: () => { count += 1 } },
  }
  let count = 0
  ;(globalThis as { window?: unknown }).window = win
  return {
    reloads: () => count,
    emit: (type, ev) => {
      const event = { ...ev, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
      for (const fn of handlers.get(type) ?? []) fn(event)
      return { defaultPrevented: Boolean(event.defaultPrevented) }
    },
    reset: () => {
      count = 0
      handlers.clear()
      store.clear()
    },
  }
}

describe('installChunkRecovery', () => {
  it('preloadError 命中 chunk 失效 → preventDefault 且重载一次', async () => {
    const env = installEnv()
    const { installChunkRecovery } = await import('../src/chunkRecovery')
    const dispose = installChunkRecovery({ now: () => 1_000 })
    const res = env.emit('vite:preloadError', {
      payload: new TypeError('Failed to fetch dynamically imported module'),
    })
    assert.equal(res.defaultPrevented, true, '必须 preventDefault，否则 vite 会再抛一次')
    assert.equal(env.reloads(), 1)
    dispose()
    env.reset()
  })

  it('冷却窗口内再次失败不重载，并回调 onGiveUp', async () => {
    const env = installEnv()
    const { installChunkRecovery } = await import('../src/chunkRecovery')
    let now = 1_000
    const given: unknown[] = []
    const dispose = installChunkRecovery({ now: () => now, onGiveUp: (e) => given.push(e) })
    env.emit('vite:preloadError', { payload: new TypeError('Failed to fetch dynamically imported module') })
    now += 500
    env.emit('vite:preloadError', { payload: new TypeError('Failed to fetch dynamically imported module') })
    assert.equal(env.reloads(), 1, '冷却期内只允许刷新一次')
    assert.equal(given.length, 1, '放弃时要通知调用方')
    dispose()
    env.reset()
  })

  it('普通异常不触发重载', async () => {
    const env = installEnv()
    const { installChunkRecovery } = await import('../src/chunkRecovery')
    const dispose = installChunkRecovery({ now: () => 1_000 })
    env.emit('vite:preloadError', { payload: new Error('接口返回 500') })
    env.emit('unhandledrejection', { reason: new Error('别的业务错误') })
    assert.equal(env.reloads(), 0)
    dispose()
    env.reset()
  })

  it('卸载后不再响应', async () => {
    const env = installEnv()
    const { installChunkRecovery } = await import('../src/chunkRecovery')
    const dispose = installChunkRecovery({ now: () => 1_000 })
    dispose()
    env.emit('vite:preloadError', { payload: new TypeError('Failed to fetch dynamically imported module') })
    assert.equal(env.reloads(), 0)
    env.reset()
  })

  it('冷却时间戳写进 sessionStorage，供重载后的新页面读取', async () => {
    const env = installEnv()
    const { installChunkRecovery } = await import('../src/chunkRecovery')
    const dispose = installChunkRecovery({ now: () => 4_242 })
    env.emit('vite:preloadError', { payload: new TypeError('Failed to fetch dynamically imported module') })
    assert.equal(globalThis.sessionStorage.getItem(RELOAD_STAMP_KEY), '4242')
    dispose()
    env.reset()
  })
})
