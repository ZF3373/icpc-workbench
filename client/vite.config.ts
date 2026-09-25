import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// 服务端端口可用 PORT 环境变量覆盖（dev:server 同读该变量）——
// Windows 上 3000-3xxx 段被 Hyper-V/winnat 动态保留时（listen EACCES），换端口即可继续开发。
// 没设 PORT 时兜底链必须和后端 loadConfig 逐级一致：config.json 的 port → 3001。
// 不能在这里单独硬编码：config.json 换端口绕保留段后两边就会分叉——后端监听 config 的
// 端口，而闸门/代理仍探测旧端口，永远不就绪，/api 全部挂 20s 再 503（页面无限加载）。
const SERVER_CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../server/config.json',
)

function resolveApiPort(): number {
  if (process.env.PORT) return Number(process.env.PORT)
  try {
    const file = JSON.parse(fs.readFileSync(SERVER_CONFIG_PATH, 'utf8')) as { port?: number }
    if (file.port) return Number(file.port)
  } catch {
    /* 新克隆没有 config.json（可复制 config.example.json），落到默认 3001 */
  }
  return 3001
}

const apiPort = resolveApiPort()

/**
 * 后端就绪前的请求闸门。
 *
 * `npm run dev` 前后端同时起，但两者启动时间不在一个量级：vite 约 1.3s 就绪，
 * 后端要引导完 express + 20 多个路由模块 + 打开 SQLite + 适配器（实测 node 直跑
 * 约 1.6s，`tsx watch` 下更久），这段时间端口还没监听。
 * 代理 `/api/*` 会拿到 ECONNREFUSED，而 vite 自己的错误处理器会**无条件**把整段
 * 堆栈打到控制台（见 vite 源码 `proxy.on('error', ...)`；它在 `configure` 之后注册，
 * 所以没法从 configure 里屏蔽）。结果就是启动时刷一屏 AggregateError 堆栈。
 *
 * 所以在代理之前加一层闸门：后端端口没通时**把请求挂住**（首屏的 /api 请求只是慢一点，
 * 不会变成"加载失败"），端口一通就放行走代理；万一后端始终起不来，最多挂
 * WAIT_MS 再返回可重试的 503。探测在后台定时做，连通后永久放行，稳态零开销。
 *
 * 中间件顺序有保障：vite 会先 await 所有 `configureServer` 钩子，之后才装
 * cachedTransformMiddleware / proxyMiddleware（见 node_modules/vite 的 dist 中
 * `for (const hook of config.getSortedPluginHooks("configureServer"))` 那一段），
 * 所以这里同步注册的中间件一定跑在代理前面。
 */
// 导出供 test/apiGate.check.mjs 做独立验证（vite 只取 default export，多导出一个无副作用）
export function apiStartupGate(host: string, port: number, waitMs = 20000): Plugin {
  return {
    name: 'api-startup-gate',
    configureServer(server) {
      const log = (msg: string) => server.config.logger.info(`\x1b[36m[api-gate]\x1b[0m ${msg}`)
      let ready = false
      let warned = false
      let probes = 0
      /** 被挂住的请求：后端就绪后统一放行 */
      const pending = new Map<() => void, NodeJS.Timeout>()

      const probe = (): Promise<boolean> =>
        new Promise((resolve) => {
          const socket = net.connect({ host, port })
          const done = (ok: boolean) => {
            socket.destroy()
            resolve(ok)
          }
          socket.once('connect', () => done(true))
          socket.once('error', () => done(false))
          socket.setTimeout(300, () => done(false))
        })

      const release = (): void => {
        for (const [next, timer] of pending) {
          clearTimeout(timer)
          next()
        }
        pending.clear()
      }

      const tick = async (): Promise<void> => {
        if (ready) return
        probes += 1
        if (await probe()) {
          ready = true
          log(`后端 ${host}:${port} 已就绪（探测 ${probes} 次），放行 ${pending.size} 个等待中的请求`)
          // 端口通了 ≠ 通的是开发后端：已安装的桌面版（SEA）同样默认监听 3001，
          // 而 dev 后端会因 EADDRINUSE 直接退出 —— 此时这里探测到的是桌面版，
          // /api 被静默代理到旧应用，新接口全部 404 且极难排查。health 里的
          // sea 标记能区分两者，发现即大声警告（仍放行，不阻塞使用）。
          try {
            const res = await fetch(`http://${host}:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
            const info = (await res.json()) as { sea?: boolean; version?: string }
            if (info.sea) {
              log(
                `\x1b[33m⚠ 端口 ${port} 上是「已安装的桌面版」（v${info.version ?? '?'}），不是本仓库开发后端：` +
                  `/api 将代理到桌面版，新增接口会 404。请关闭桌面版后重新运行 npm run dev。\x1b[0m`,
              )
            }
          } catch {
            /* health 探测失败不影响放行 */
          }
          release()
          return
        }
        if (!warned) {
          warned = true
          log(`后端 ${host}:${port} 尚未就绪（引导中）：/api 请求先挂起，就绪后自动放行`)
        }
        setTimeout(() => void tick(), 300)
      }
      void tick()

      // configureServer 里同步注册的中间件跑在 vite 内部中间件（含代理）之前
      server.middlewares.use((req, res, next) => {
        if (ready || !req.url?.startsWith('/api')) return next()
        const timer = setTimeout(() => {
          if (!pending.delete(next)) return
          // 客户端可能在这期间断开了：对已结束/已销毁的响应再写会抛错
          if (res.writableEnded || res.destroyed) return
          res.statusCode = 503
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Retry-After', '1')
          res.end(JSON.stringify({ error: 'api-starting', message: '后端仍未就绪，请稍后重试' }))
        }, waitMs)
        pending.set(next, timer)
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), apiStartupGate('127.0.0.1', apiPort)],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
    },
  },
})
