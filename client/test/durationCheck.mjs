/**
 * 过渡时长纪律检查：`transition` 声明一律引用 var(--dur-*)，
 * 禁止新写字面量时长（120ms / 0.15s / …）。
 *
 * 背景：2026-10-24 把全站散落的 120/130/140/150/160/180/250/450ms 收口为
 * 四个档位 Token（--dur-1..4，见 docs/UI-Design-Tokens.md §5）。此脚本防止收口成果回潮。
 *
 * 有意例外（白名单，改动需同步 docs/UI-Design-Tokens.md §5）：
 *   - index.css 的 `width 0.6s`（.ant-progress-bg 进度条填充，刻意放慢的结构动画）
 *   - `@keyframes` 相关的 animation 时长不归本脚本管（骨架呼吸、流光、pageFadeIn）
 *
 * 用法（在 client/ 下）：node test/durationCheck.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = resolvePath(here, '..', 'src')

/** 允许出现在 transition 里的字面量时长（有意例外） */
const WHITELIST = new Set(['0.6s'])

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, exts, out)
    else if (exts.some((e) => name.endsWith(e))) out.push(p)
  }
  return out
}

const files = walk(srcRoot, ['.css', '.tsx', '.ts'])
const violations = []
const transitionRe = /transition\s*:\s*([^;{}]+)[;}]|transition\s*:\s*'([^']+)'/g
const durationRe = /\b\d+(?:\.\d+)?m?s\b/g

for (const file of files) {
  const rel = file.slice(srcRoot.length + 1)
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  for (const m of text.matchAll(transitionRe)) {
    const value = m[1] ?? m[2]
    if (!value) continue
    // 跳过 none / 关键帧名等无时长的声明
    if (!/\b\d+(?:\.\d+)?m?s\b/.test(value)) continue
    const lineNo = text.slice(0, m.index).split('\n').length
    for (const d of value.matchAll(durationRe)) {
      if (WHITELIST.has(d[0])) continue
      violations.push(`${rel}:${lineNo}  transition 含字面量时长 "${d[0]}" → ${lines[lineNo - 1].trim().slice(0, 90)}`)
    }
  }
}

if (violations.length === 0) {
  console.log(`✔ 全部 ${files.length} 个源文件的 transition 都引用 var(--dur-*)（白名单例外 ${WHITELIST.size} 处）`)
} else {
  console.log(`✖ ${violations.length} 处 transition 使用了字面量时长（应改为 var(--dur-1..4) + var(--ease-standard)）：\n`)
  for (const v of violations) console.log('  ' + v)
  console.log('\n档位：120ms / 140ms / 200ms / 400ms，拿不准用 var(--dur-2) var(--ease-standard)。')
  process.exitCode = 1
}
