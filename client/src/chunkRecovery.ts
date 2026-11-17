/**
 * 懒加载 chunk 失效的自愈（issue #65）。
 *
 * 现象：桌面版一键更新后，WebView2 里仍是旧页面文档，模块图也停在旧版；升级前
 * 没访问过的页面（路由级 React.lazy）会按**旧哈希**去要 chunk，而新 dist 里那些
 * 文件已被替换——请求落空，动态 import 直接失败，路由整片渲染不出来，表现为黑屏。
 *
 * 兜底策略：
 * 1. 服务端已把「资源路径缺失」改回 404（见 server/src/spa-static.ts），不会再拿
 *    index.html 冒充 JS；
 * 2. 这里接住 Vite 在预取/动态 import 失败时派发的 `vite:preloadError`，preventDefault
 *    后**整页重载一次**——重载会重新取 no-cache 的 index.html，也就拿到新哈希。
 * 3. 用 sessionStorage 记时间戳做冷却：短时间内只自愈一次，避免「重载→还是旧资源→
 *    再重载」的死循环把页面刷成走马灯。冷却期内的再次失败交给调用方的报错提示。
 */

/** 自动重载的冷却窗口：窗口内重复失败不再刷新（防死循环） */
export const RELOAD_COOLDOWN_MS = 10_000

/** sessionStorage 键：上次自动重载的时间戳 */
export const RELOAD_STAMP_KEY = 'icpc:chunk-recovery-at'

/**
 * 是否该自动重载。
 * @param lastAt 上次自动重载的时间戳（ms）；null 表示本次会话尚未重载过
 * @param now 当前时间戳（ms）
 * @param cooldownMs 冷却窗口
 */
export function shouldReload(lastAt: number | null, now: number, cooldownMs: number = RELOAD_COOLDOWN_MS): boolean {
  if (lastAt === null) return true
  if (!Number.isFinite(lastAt)) return true
  return now - lastAt >= cooldownMs
}

/**
 * 判断错误是否属于「chunk 取不到」这一类。浏览器引擎（Chromium / WebKit）与
 * 打包器给出的文案不一致，所以按已验证的几种前缀匹配，而不是只认一种。
 */
export function isChunkLoadError(err: unknown): boolean {
  const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : ''
  if (!msg) return false
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /Unable to preload (CSS|module) for/i.test(msg) ||
    /Loading chunk \S+ failed/i.test(msg) ||
    /ChunkLoadError/i.test(msg)
  )
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function storage(): StorageLike | null {
  try {
    return (globalThis as { sessionStorage?: StorageLike }).sessionStorage ?? null
  } catch {
    // 隐私模式 / 被禁用时访问即抛错：没有存储也能工作，只是退化成「不冷却」
    return null
  }
}

/** 读上次自动重载时间戳：脏值一律当作「没重载过」 */
function readStamp(store: StorageLike | null): number | null {
  if (!store) return null
  try {
    const raw = store.getItem(RELOAD_STAMP_KEY)
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function writeStamp(store: StorageLike | null, at: number): void {
  try {
    store?.setItem(RELOAD_STAMP_KEY, String(at))
  } catch {
    /* 写不进去就算了：下次仍按「没重载过」处理，最坏是多刷一次 */
  }
}

export interface ChunkRecoveryOptions {
  /** 取当前时间（测试注入） */
  now?: () => number
  /** 执行重载（测试注入；生产为 window.location.reload） */
  reload?: () => void
  /** 冷却期内再次失败时的回调（调用方可据此提示用户手动刷新） */
  onGiveUp?: (err: unknown) => void
}

/**
 * 安装自愈监听。返回卸载函数（HMR / 测试用）。
 * 在 main.tsx 里于首帧渲染前调用，保证首个懒加载失败也能被接住。
 */
export function installChunkRecovery(opts: ChunkRecoveryOptions = {}): () => void {
  if (typeof window === 'undefined') return () => {}
  const now = opts.now ?? (() => Date.now())
  const reload = opts.reload ?? (() => window.location.reload())
  const store = storage()

  const handle = (err: unknown): void => {
    if (!isChunkLoadError(err)) return
    const at = now()
    if (!shouldReload(readStamp(store), at)) {
      opts.onGiveUp?.(err)
      return
    }
    writeStamp(store, at)
    reload()
  }

  // Vite 的预取/动态 import 失败会派发该事件；必须 preventDefault，否则它还会再抛一次
  const onPreloadError = (e: Event): void => {
    const payload = (e as Event & { payload?: unknown }).payload
    if (!isChunkLoadError(payload)) return
    e.preventDefault()
    handle(payload)
  }

  // 兜底：有些路径（例如手写 import() 且未走 Vite 预取助手）不会派发事件，
  // 只体现为未处理的 rejection。这里不吞异常（不 preventDefault 语义），仅在判定
  // 为 chunk 失效时补一次重载。
  const onRejection = (e: PromiseRejectionEvent): void => {
    handle(e.reason)
  }

  window.addEventListener('vite:preloadError', onPreloadError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    window.removeEventListener('vite:preloadError', onPreloadError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
