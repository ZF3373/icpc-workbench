/**
 * 主题色值一致性检查：tokens.ts 的配对表必须与 index.css 的
 * :root（暗色）/ [data-theme='light']（亮色）逐项相等。
 *
 * 背景：antd Token（ConfigProvider）与 CSS 变量（:root）是两套必然并存的实现，
 * 历史上靠「改色记得改两边」的人肉纪律，漂移过（亮色 antd 语义色一直是暗色粉彩值，
 * 而 CSS 侧已按亮色底校准）。tokens.ts 成为 ts 侧唯一来源后，本脚本守住另一半：
 * 配对表里的值改了、index.css 没跟上（或反之）时在 CI 拦下。
 *
 * 亮色块未覆盖的 CSS 变量按级联继承 :root 值——配对表 light 侧也应写 :root 的值，
 * 本脚本按同一口径比对。
 *
 * 用法（在 client/ 下）：node --experimental-transform-types test/tokenCheck.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { TOKEN_PAIRS } from '../src/tokens.ts'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(resolve(here, '../src/index.css'), 'utf8')

/** 取选择器声明块的内部文本（花括号配平，容忍嵌套） */
function extractBlock(source, selector) {
  const start = source.indexOf(selector)
  if (start === -1) throw new Error(`index.css 中找不到选择器 ${selector}`)
  const open = source.indexOf('{', start)
  let depth = 1
  let i = open + 1
  while (depth > 0 && i < source.length) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    i++
  }
  return source.slice(open + 1, i - 1)
}

/** 块内 CSS 自定义属性 → 值（去注释；跨行值按分号截断后折叠空白） */
function collectVars(block) {
  const map = new Map()
  const clean = block.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of clean.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(m[1], m[2].replace(/\s+/g, ' ').trim())
  }
  return map
}

const norm = (v) => v.replace(/\s+/g, ' ').trim()
const rootVars = collectVars(extractBlock(css, ':root'))
const lightVars = collectVars(extractBlock(css, "[data-theme='light']"))

const problems = []
for (const [key, pair] of Object.entries(TOKEN_PAIRS)) {
  const cssDark = rootVars.get(pair.cssVar)
  // 亮色未覆盖的变量按 CSS 级联取 :root 值（配对表口径一致）
  const cssLight = lightVars.get(pair.cssVar) ?? rootVars.get(pair.cssVar)
  if (cssDark === undefined) {
    problems.push(`${key}: index.css :root 缺少 ${pair.cssVar}`)
    continue
  }
  if (cssLight === undefined) {
    problems.push(`${key}: index.css 两套主题块都没有 ${pair.cssVar}`)
    continue
  }
  if (norm(pair.dark) !== norm(cssDark)) {
    problems.push(`${key} 暗色漂移：tokens.ts "${pair.dark}" ≠ index.css "${cssDark}"`)
  }
  if (norm(pair.light) !== norm(cssLight)) {
    problems.push(`${key} 亮色漂移：tokens.ts "${pair.light}" ≠ index.css "${cssLight}"`)
  }
}

if (problems.length === 0) {
  console.log(`✔ ${Object.keys(TOKEN_PAIRS).length} 组主题色配对全部与 index.css 一致`)
} else {
  console.error(`✖ ${problems.length} 组主题色配对与 index.css 不一致（改色须 tokens.ts 与 index.css 同步改）：\n`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
