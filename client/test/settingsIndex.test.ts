/**
 * 设置页「分区锚点 / 搜索索引」一致性守卫（node:test，源码级不变量）。
 *
 * 为什么用源码级检查：`SETTINGS_INDEX` / `SETTINGS_SECTIONS` 都定义在 `Settings.tsx` 内部，
 * 而该文件是组件文件（import 它会拖进 antd / 主题 / 路由），仓库没有组件测试设施，
 * 所以照 `credentialsTable.test.ts` 的做法，直接对源码做结构断言。
 *
 * 钉住的三类真实缺陷（都属于「加了东西但没加全」的静默失效）：
 *   1. 新增分区却忘了在 DOM 上写 `id="settings-xxx"` —— 导航/搜索点了不滚动，没有任何报错；
 *   2. 新增设置项却忘了补 `SETTINGS_INDEX` —— 该项搜不到（P5 要防的就是这个）；
 *   3. `sectionId` 拼错或分区被改名 —— 搜索结果里的「所属分区」变空，条目点进去落回原地。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SETTINGS_TSX = path.resolve(__dirname, '..', 'src', 'pages', 'Settings.tsx')
const source = fs.readFileSync(SETTINGS_TSX, 'utf8')

interface Section {
  id: string
  label: string
}
interface IndexEntry {
  sectionId: string
  label: string
  keywords: string
}

/** 取 `const NAME ... = [` 到与之配对的第一个 `]` 之间的文本 */
function arrayLiteralText(name: string): string {
  const start = source.indexOf(`const ${name}`)
  assert.notEqual(start, -1, `Settings.tsx 里找不到 ${name}`)
  const open = source.indexOf('[', start)
  assert.notEqual(open, -1, `${name} 后面没有数组字面量`)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '[') depth += 1
    else if (source[i] === ']') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error(`${name} 的数组字面量没有闭合`)
}

const sections: Section[] = [
  ...arrayLiteralText('SETTINGS_SECTIONS').matchAll(
    /\{\s*id:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'\s*\}/g,
  ),
].map((m) => ({ id: m[1], label: m[2] }))

const indexEntries: IndexEntry[] = [
  ...arrayLiteralText('SETTINGS_INDEX').matchAll(
    /\{\s*sectionId:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'\s*,\s*keywords:\s*'([^']*)'\s*\}/g,
  ),
].map((m) => ({ sectionId: m[1], label: m[2], keywords: m[3] }))

/** 页面上真实存在的锚点：JSX 里的 id="settings-xxx" 与 sectionAnchor('settings-xxx') */
const anchorIds = new Set<string>([
  ...[...source.matchAll(/id="(settings-[a-z-]+)"/g)].map((m) => m[1]),
  ...[...source.matchAll(/sectionAnchor\('(settings-[a-z-]+)'\)/g)].map((m) => m[1]),
])

describe('设置页分区与索引的一致性', () => {
  it('解析器没有漏项（提取条数 = 源码里的条目数，换了写法就会红）', () => {
    // 不用「数量 >= N」这种魔数哨兵：条目数会随功能增删正常变化。
    // 真正要防的是「正则跟不上源码写法」导致的静默漏项 —— 所以拿原始出现次数对账。
    const rawSections = [...arrayLiteralText('SETTINGS_SECTIONS').matchAll(/\bid:\s*'/g)].length
    const rawEntries = [...arrayLiteralText('SETTINGS_INDEX').matchAll(/\bsectionId:\s*'/g)].length
    assert.equal(sections.length, rawSections, 'SETTINGS_SECTIONS 有条目没被解析出来')
    assert.equal(indexEntries.length, rawEntries, 'SETTINGS_INDEX 有条目没被解析出来')
    assert.ok(sections.length >= 3, `只解析到 ${sections.length} 个分区，明显偏少`)
    assert.ok(indexEntries.length >= 20, `只解析到 ${indexEntries.length} 条索引，明显偏少`)
  })

  it('每个分区都在 DOM 上有锚点（否则导航/搜索点了不滚动且无报错）', () => {
    const missing = sections.filter((s) => !anchorIds.has(s.id)).map((s) => s.id)
    assert.deepEqual(missing, [], `分区缺少 DOM 锚点 id：\n  ${missing.join('\n  ')}`)
  })

  it('索引里的 sectionId 都是真实分区（拼错/改名后会导致「所属分区」为空）', () => {
    const known = new Set(sections.map((s) => s.id))
    const unknown = [...new Set(indexEntries.filter((e) => !known.has(e.sectionId)).map((e) => e.sectionId))]
    assert.deepEqual(unknown, [], `索引引用了不存在的分区：\n  ${unknown.join('\n  ')}`)
  })

  it('每个分区都至少有一条索引（否则该分区的设置项全都搜不到）', () => {
    const covered = new Set(indexEntries.map((e) => e.sectionId))
    const uncovered = sections.filter((s) => !covered.has(s.id)).map((s) => s.id)
    assert.deepEqual(uncovered, [], `这些分区在搜索索引里一条都没有：\n  ${uncovered.join('\n  ')}`)
  })

  it('索引条目都有非空 label 与 keywords（关键字为空 = 只能靠名字搜到）', () => {
    const bad = indexEntries.filter((e) => e.label.trim() === '' || e.keywords.trim() === '')
    assert.deepEqual(bad, [], `label/keywords 为空的索引条目：\n  ${JSON.stringify(bad, null, 2)}`)
  })

  it('索引 label 不重复（重复项会在结果列表里出现两遍）', () => {
    const seen = new Map<string, number>()
    for (const e of indexEntries) seen.set(e.label, (seen.get(e.label) ?? 0) + 1)
    const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([l]) => l)
    assert.deepEqual(dup, [], `重复的索引 label：\n  ${dup.join('\n  ')}`)
  })

  it('SETTINGS_SECTIONS 的 id/label 与 DOM 上的无多余锚点', () => {
    const known = new Set(sections.map((s) => s.id))
    const orphans = [...anchorIds].filter((id) => !known.has(id))
    assert.deepEqual(orphans, [], `DOM 上有多余的 settings-* 锚点（未登记成分区）：\n  ${orphans.join('\n  ')}`)
  })
})
