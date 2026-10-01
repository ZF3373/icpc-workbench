/**
 * 流式收尾的**调用顺序**守卫（源码级不变量测试，node:test）。
 *
 * 背景缺陷（实测于 Assistant.tsx）：停止生成/报错时，收尾标记是在 catch 里追加到消息上的，
 * 而缓冲里最后一批 delta（不足 50ms 攒批窗口的那些字）直到 finally 的 `buf.dispose()`
 * 才落库。JS 保证 catch 先于 finally 执行，于是：
 *   · 停止分支：`> ⏹️ **已停止生成。**` 之后又多出一段正文，看起来像「停止之后还在续写」；
 *   · 报错分支：⚠️ 消息刚被 append 成最后一条，残留正文被写进那个错误气泡里。
 * 成功路径本来就在 stream 结束处 `buf.flush()`，所以只有这两条分支错位。
 *
 * 这类顺序无法用组件测试覆盖（仓库没有组件测试设施），故按 credentialsTable.test.ts 的
 * 同款做法钉住源码结构：停止/报错分支所在 catch 块内，必须先出现 `buf.dispose()`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSISTANT = path.resolve(__dirname, '..', 'src', 'pages', 'Assistant.tsx')

test('停止/报错收尾：必须先落库流缓冲，再写「已停止生成/⚠️」标记', () => {
  const src = fs.readFileSync(ASSISTANT, 'utf8')
  const stopBranch = src.indexOf('if (ac.signal.aborted) {')
  assert.ok(stopBranch > 0, '未找到停止分支：Assistant.tsx 结构已变化，请更新本测试')

  const catchStart = src.lastIndexOf('} catch (e) {', stopBranch)
  assert.ok(catchStart > 0 && catchStart < stopBranch, '未找到停止分支所属的 catch 块')

  const flush = src.indexOf('buf.dispose()', catchStart)
  assert.ok(
    flush > catchStart && flush < stopBranch,
    '流缓冲必须在写收尾标记**之前**落库（catch 开头 buf.dispose()）。' +
      '留在 finally 里会把停止前最后一批正文追加到「已停止生成」标记之后，' +
      '报错时则写进 ⚠️ 气泡（见本测试文件头部说明）。',
  )
})

test('成功路径：stream 结束后立刻 flush，再处理用量/截断/空回复收尾', () => {
  const src = fs.readFileSync(ASSISTANT, 'utf8')
  const flush = src.indexOf('buf.flush()')
  assert.ok(flush > 0, '未找到成功路径的 buf.flush()')
  // 空回复兜底提示必须晚于 flush，否则「有内容却显示空回复提示」
  const emptyNotice = src.indexOf('EMPTY_REPLY_NOTICE, failed: true', flush)
  assert.ok(emptyNotice > flush, '空回复兜底必须在 flush 之后，否则可能误判为「无正文」')
})
