/**
 * 对比度测量：用真实 index.css 的 Token 值，按 WCAG 2.x 公式算出
 * 重点标记 / 粗体 / 标题 在暗、亮两套主题下的实际对比度。
 *
 * 为什么要专门量：亮色主题的 --amber 是给"图表/角标"用的深琥珀，放到淡琥珀底上
 * 可能不足 4.5:1；而 --brand-text 在亮色下也可能偏浅。这两个都是**新增着色**，
 * 不能靠肉眼在截图里判断。
 *
 * 用法（在 client/ 下）：node test/contrastCheck.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = resolvePath(here, '..')
const css = readFileSync(join(clientRoot, 'src', 'index.css'), 'utf8')

/** 从 index.css 的某个主题块里取一个 Token 的原始值 */
function tokenIn(block, name) {
  const re = new RegExp(`--${name}\\s*:\\s*([^;]+);`)
  const m = re.exec(block)
  return m ? m[1].trim() : null
}

/** 切出 :root（暗色）与 [data-theme='light']（亮色）两个块 */
function themeBlocks() {
  const lightAt = css.indexOf("[data-theme='light']")
  const light = css.slice(lightAt, css.indexOf('}', lightAt))
  // :root 块在文件靠前的位置
  const rootAt = css.indexOf(':root')
  const root = css.slice(rootAt, css.indexOf('}', rootAt))
  return { dark: root, light }
}

/** 解析 #rgb / #rrggbb / rgba() / rgb() */
function parseColor(value) {
  const v = value.trim()
  let m = /^#([0-9a-f]{6})$/i.exec(v)
  if (m) {
    const n = parseInt(m[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]
  }
  m = /^#([0-9a-f]{3})$/i.exec(v)
  if (m) {
    const [r, g, b] = [...m[1]].map((c) => parseInt(c + c, 16))
    return [r, g, b, 1]
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
  return null
}

/** 把带透明度的前景色合成到不透明背景上 */
function composite(fg, bg) {
  const a = fg[3]
  return [
    fg[0] * a + bg[0] * (1 - a),
    fg[1] * a + bg[1] * (1 - a),
    fg[2] * a + bg[2] * (1 - a),
    1,
  ]
}

/** WCAG 相对亮度 */
function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** WCAG 对比度 */
function contrast(fg, bg) {
  const l1 = luminance(fg)
  const l2 = luminance(bg)
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

const { dark, light } = themeBlocks()

/** 每种主题要检查的组合：前景 Token / 底色 Token（底色可能是半透明，叠在 surface-2 上） */
const CHECKS = [
  { name: '高亮 ==重点== 文字', fg: 'mark-text', bg: 'amber-soft', base: 'surface-2', min: 4.5 },
  { name: '粗体 **重点** 文字', fg: 'strong-text', bg: null, base: 'surface-2', min: 4.5 },
  { name: '正文（参照基线）', fg: 'text-2', bg: null, base: 'surface-2', min: 4.5 },
  // 高亮还可能落在 surface（页面底）与 surface-inset（代码卡相邻）上，
  // 换底色再量一遍，避免"只在某一个底色上达标"
  { name: '高亮（surface 底）', fg: 'mark-text', bg: 'amber-soft', base: 'surface', min: 4.5 },
  { name: '粗体（surface 底）', fg: 'strong-text', bg: null, base: 'surface', min: 4.5 },
]

let failures = 0
for (const [theme, block] of [['暗色', dark], ['亮色', light]]) {
  console.log(`\n[${theme}]  （底色 surface-2 为基准，半透明底色先做合成）`)
  for (const c of CHECKS) {
    const fgRaw = tokenIn(block, c.fg)
    const baseRaw = tokenIn(block, c.base)
    if (!fgRaw || !baseRaw) {
      console.log(`  ? ${c.name}: 缺 Token（${c.fg} / ${c.base}）`)
      continue
    }
    const base = parseColor(baseRaw)
    let bg = base
    if (c.bg) {
      const bgRaw = tokenIn(block, c.bg)
      const parsed = bgRaw && parseColor(bgRaw)
      if (!parsed) {
        console.log(`  ? ${c.name}: 底色 Token ${c.bg} 缺失`)
        continue
      }
      bg = composite(parsed, base)
    }
    const fg = parseColor(fgRaw)
    const ratio = contrast(fg, bg)
    const ok = ratio >= c.min
    if (!ok) failures += 1
    console.log(
      `  ${ok ? '✔' : '✖'} ${c.name}: ${ratio.toFixed(2)}:1（要求 ≥ ${c.min}）` +
        `  fg=${fgRaw}  bg=${c.bg ? `${tokenIn(block, c.bg)} over ` : ''}${baseRaw}`,
    )
  }
}

console.log(`\n${failures === 0 ? '全部达标' : `${failures} 项不达标`}\n`)
if (failures > 0) process.exitCode = 1
