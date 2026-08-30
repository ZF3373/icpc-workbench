/**
 * 外链打开策略：
 * - 浏览器环境：保持原生 <a target="_blank"> / window.open 行为
 * - 桌面壳（Tauri WebView）：target="_blank" 的新窗口请求被默认策略吞掉，
 *   需拦截后委托 opener 插件交系统浏览器打开
 */

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

interface TauriGlobal {
  core?: {
    invoke?: TauriInvoke
  }
}

function tauriInvoke(): TauriInvoke | null {
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__
  return tauri?.core?.invoke ?? null
}

export function isTauriShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 在系统浏览器打开外链（桌面壳走 opener 插件，浏览器回退 window.open） */
export async function openExternal(url: string): Promise<void> {
  const invoke = tauriInvoke()
  if (invoke && /^https?:/i.test(url)) {
    try {
      await invoke('plugin:opener|open_url', { url })
      return
    } catch {
      // 插件调用失败时回退，避免链接彻底失效
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** 桌面壳内全局接管外链点击：所有指向 http(s) 的 <a>（含 Markdown 渲染的）统一走系统浏览器 */
export function setupExternalLinks(): void {
  if (!isTauriShell()) return
  document.addEventListener(
    'click',
    (e) => {
      if (e.button !== 0 || e.defaultPrevented) return
      const target = e.target as Element | null
      const anchor = target?.closest?.('a[href]')
      if (!anchor) return
      const href = anchor.getAttribute('href') ?? ''
      if (!/^https?:/i.test(href)) return
      // 站内路由链接不拦截（SPA 同源跳转由前端路由处理）
      if (new URL(href, window.location.href).origin === window.location.origin) return
      e.preventDefault()
      e.stopPropagation()
      void openExternal(href)
    },
    true,
  )
}
