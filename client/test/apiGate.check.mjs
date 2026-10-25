/**
 * `apiStartupGate` 的独立验证（不需要真的起 vite / 后端）。
 *
 * 沙箱里跑不了真实 dev 流程（vite 会 spawn esbuild → EPERM），所以这里把
 * vite.config.ts 里的闸门插件单独拿出来，接到一个假的中间件链上，验证三件事：
 *   1. 后端端口没通时：/api 请求被**挂住**（既不进代理也不立刻失败），非 /api 请求照常放行；
 *   2. 后端端口一通：挂住的请求被放行进代理，之后的请求直接放行；
 *   3. 后端始终不通：到 waitMs 后返回可重试的 503（而不是让请求永久挂着）。
 *
 * 用法（在 client/ 下）：node --experimental-transform-types test/apiGate.check.mjs
 */
import net from 'node:net'
import assert from 'node:assert/strict'
import { apiStartupGate } from '../vite.config.ts'

const PORT = 4517
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
let checks = 0
function check(name, fn) {
  checks += 1
  try {
    fn()
    console.log(`  ✔ ${name}`)
  } catch (e) {
    failures += 1
    console.log(`  ✖ ${name}\n      ${e.message}`)
  }
}

/** 按 vite 的方式接线：插件在 configureServer 里注册的中间件跑在代理之前 */
function mount(gate) {
  const logs = []
  const stack = []
  const fake = {
    config: { logger: { info: (m) => logs.push(m) } },
    middlewares: { use: (mw) => stack.push(mw) },
  }
  gate.configureServer(fake)
  const proxyHits = []
  const run = (url) => {
    const state = { url, released: false, status: null, body: null }
    const req = { url }
    const res = {
      setHeader: () => {},
      end: (b) => {
        state.body = b
      },
    }
    let idx = -1
    const step = () => {
      idx += 1
      if (idx >= stack.length) {
        proxyHits.push(url)
        state.released = true
        return
      }
      stack[idx](req, res, step)
    }
    state.start = step
    return state
  }
  return { run, logs, proxyHits }
}

// net.Server 没有 closeAllConnections（那是 http.Server 的）：
// 代理侧 http agent 的 keep-alive 连接会挂住 server.close，手动跟踪并销毁
const backendConns = new Set()
const backend = net.createServer((s) => {
  backendConns.add(s)
  s.on('close', () => backendConns.delete(s))
  s.end()
})

/* ---------- 1. 后端始终不通：先挂住，到点返回 503 ---------- */
{
  const gate = apiStartupGate('127.0.0.1', PORT, 1200)
  const { run, logs, proxyHits } = mount(gate)
  const held = run('/api/health')
  held.start()
  const other = run('/assets/index.js')
  other.start()

  await sleep(300)
  check('后端未就绪：/api 请求被挂住（没进代理、也还没失败）', () => {
    assert.equal(held.released, false, '请求提前进了代理')
    assert.equal(held.body, null, `请求提前返回了响应: ${held.body}`)
  })
  check('后端未就绪：非 /api 请求照常放行', () => {
    assert.deepEqual(proxyHits, ['/assets/index.js'])
  })
  check('后端未就绪：控制台只打一行说明', () => {
    assert.equal(logs.length, 1, `日志条数不对: ${JSON.stringify(logs)}`)
    assert.match(logs[0], /尚未就绪/)
  })

  await sleep(1200)
  check('后端始终不通：到 waitMs 返回可重试的 503（不永久挂着）', () => {
    assert.match(String(held.body), /api-starting/)
    assert.equal(held.released, false, '超时后不该再进代理')
  })
}

/* ---------- 2. 后端就绪后放行 ---------- */
{
  const gate = apiStartupGate('127.0.0.1', PORT, 5000)
  const { run, logs, proxyHits } = mount(gate)
  const held = run('/api/settings')
  held.start()
  await sleep(300)
  check('就绪前：请求仍在挂起', () => {
    assert.equal(held.released, false)
    assert.deepEqual(proxyHits, [])
  })

  await new Promise((r) => backend.listen(PORT, '127.0.0.1', r))
  await sleep(700)
  check('后端一起来：被挂住的请求立刻放行进代理', () => {
    assert.deepEqual(proxyHits, ['/api/settings'])
  })
  check('就绪日志包含放行数量', () => {
    assert.match(logs.join('\n'), /已就绪.*放行 1 个/)
  })
  const after = run('/api/health')
  after.start()
  check('就绪后：新请求直接放行（不再走挂起路径）', () => {
    assert.equal(after.released, true)
  })
  // 代理侧的 http agent 默认 keep-alive（Node 19+），连接不断 close 会一直挂到
  // unsettled top-level await（exit 13，断言全过也报失败）——先显式断干净
  for (const conn of backendConns) conn.destroy()
  await new Promise((r) => backend.close(r))
}

console.log(`\n${failures === 0 ? '全部通过' : '存在失败'}：${checks - failures}/${checks} 项通过\n`)
if (failures > 0) process.exitCode = 1
