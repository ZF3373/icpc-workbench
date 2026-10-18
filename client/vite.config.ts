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

/**
 * 构建后剥离字体里的 woff / ttf 回退格式。
 *
 * @fontsource 与 katex 的 CSS 给每个字重同时声明 woff2 + woff (+ ttf)，Vite 会把
 * 三种格式都复制进 assets（共 ~1.4 MB 的 woff/ttf 是死重量）。现代浏览器与
 * WebView2 一律支持 woff2，且 @font-face 的 src 是按顺序取第一个**支持的格式**，
 * woff2 排在首位时后面的 woff/ttf 永远不会被请求 —— 文件删掉后 CSS 里的 url
 * 虽然指向不存在的路径，浏览器也不会去 404。
 *
 * 实现上没有直接按扩展名全删，而是逐个 @font-face 块判定：只有同一块里已经声明了
 * woff2（外链文件或内联 data URI 皆可）时才删它的 woff/ttf。KaTeX_Size3 的 woff2
 * 被 Vite 内联成 data URI，block 里仍留着 woff/ttf 两个外链 —— 这种也算安全可删。
 * 万一某个块的 woff2 排在 woff/ttf 之后（顺序决定选型），保留不动并告警。
 */
function stripLegacyFontFormats(): Plugin {
  let outDir = ''

  return {
    name: 'strip-legacy-font-formats',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        const assetsDir = path.join(outDir, 'assets')
        if (!fs.existsSync(assetsDir)) return

        const cssFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.css'))
        // woff2 是本块字体的主力格式时，该块里其余 woff/ttf 文件即可删除
        const deletable = new Set<string>()
        const required = new Set<string>()
        const outOfOrder: string[] = []
        let inlineWoff2Blocks = 0

        for (const css of cssFiles) {
          const text = fs.readFileSync(path.join(assetsDir, css), 'utf8')
          for (const block of text.matchAll(/@font-face\s*\{[^}]*\}/g)) {
            const urls = [...block[0].matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1])
            const woff2At = urls.findIndex((u) => u.startsWith('data:font/woff2') || u.endsWith('.woff2'))
            if (woff2At === -1) continue
            if (urls[woff2At].startsWith('data:font/woff2')) inlineWoff2Blocks += 1

            urls.forEach((u, i) => {
              if (u.startsWith('data:') || !/\.(woff|ttf)$/i.test(u)) return
              const name = path.basename(u)
              // woff2 必须排在回退格式之前，否则浏览器可能先选中它俩
              if (i > woff2At) deletable.add(name)
              else {
                required.add(name)
                outOfOrder.push(`${css}: ${name}`)
              }
            })
          }
        }

        if (outOfOrder.length > 0) {
          console.warn(
            `\x1b[33m[fonts]\x1b[0m ${outOfOrder.length} 个 woff/ttf 排在 woff2 之前，已保留不删：`,
          )
          for (const line of outOfOrder) console.warn(`  - ${line}`)
        }

        const removed: string[] = []
        let bytes = 0
        for (const name of deletable) {
          if (required.has(name)) continue
          const file = path.join(assetsDir, name)
          if (!fs.existsSync(file)) continue
          bytes += fs.statSync(file).size
          fs.rmSync(file)
          removed.push(name)
        }

        if (removed.length === 0) return
        const kb = (bytes / 1024).toFixed(0)
        console.log(
          `\x1b[36m[fonts]\x1b[0m 删除 ${removed.length} 个未被请求的 woff/ttf（${kb} KB）` +
            (inlineWoff2Blocks > 0 ? `，其中 ${inlineWoff2Blocks} 个字体用内联 woff2` : ''),
        )
        for (const name of removed.sort()) console.log(`  - assets/${name}`)
      },
    },
  }
}

export default defineConfig({
  plugins: [react(), apiStartupGate('127.0.0.1', apiPort), stripLegacyFontFormats()],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
    },
  },
  build: {
    // Vite 8 的打包器是 Rolldown：旧的 manualChunks 虽仍可传，但函数形式会被整体
    // 转成一个 codeSplitting group，且默认 includeDependenciesRecursively 会把依赖
    // 递归吞进该组。实测这样分组时 react 整个被并进 antd 组、jsx-runtime 落进
    // codemirror 组，首屏反而要静态下载 718 KB 的编辑器，chunk 间还出现
    // react ⇄ PageHeader 的静态循环依赖（页面直接白屏）。所以这里用
    // codeSplitting.groups 显式分组：保留默认的依赖递归以保证 chunk 自洽无循环，
    // 靠 priority 让 react 先被认领，而不是靠关闭递归去抢模块。
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // react 优先级最高：先于 antd / codemirror 认领 react 家族模块，
            // 避免 jsx-runtime 被大组的依赖递归顺带吞走。
            {
              name: 'react',
              test: /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/,
              priority: 100,
            },
            {
              name: 'antd',
              test: /[\\/]node_modules[\\/](antd|@ant-design|@rc-component|rc-[^\\/]*|antd-style)[\\/]/,
              priority: 90,
            },
            {
              name: 'recharts',
              test: /[\\/]node_modules[\\/](recharts|d3-[^\\/]*|victory-vendor)[\\/]/,
              priority: 90,
            },
            {
              name: 'codemirror',
              test: /[\\/]node_modules[\\/](@codemirror|@uiw|@lezer|codemirror)[\\/]/,
              priority: 90,
            },
            {
              name: 'markdown',
              test: /[\\/]node_modules[\\/](react-markdown|katex|rehype-[^\\/]*|remark-[^\\/]*|micromark[^\\/]*|mdast-util[^\\/]*|unified|hast|hast-util-[^\\/]*|highlight\.js|lowlight|vfile[^\\/]*)[\\/]/,
              priority: 90,
            },
          ],
        },
      },
    },
  },
})
