import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MENU, MENU_GROUPS, MENU_FIXED_TOP, MENU_FIXED_BOTTOM } from '../src/menuConfig'

test('menu: 每个菜单项要么在分组里、要么是固定项（不会从导航里消失）', () => {
  // SiderMenu 只渲染 MENU_FIXED_TOP + MENU_GROUPS + MENU_FIXED_BOTTOM 三处；
  // 新增菜单项若漏挂到任何一处，导航里就静默少一个入口，这里兜住。
  const grouped = new Set(MENU_GROUPS.flatMap((g) => g.items))
  const rendered = new Set([...MENU_FIXED_TOP, ...MENU_FIXED_BOTTOM, ...grouped])
  for (const m of MENU) {
    assert.ok(rendered.has(m.key), `菜单项 ${m.key} 未出现在任何渲染位置`)
  }
})

test('menu: 固定项与分组不重叠，分组内无重复', () => {
  const grouped = MENU_GROUPS.flatMap((g) => g.items)
  for (const k of [...MENU_FIXED_TOP, ...MENU_FIXED_BOTTOM]) {
    assert.ok(!grouped.includes(k), `固定项 ${k} 不应同时出现在分组里`)
  }
  for (const g of MENU_GROUPS) {
    assert.equal(new Set(g.items).size, g.items.length, `分组 ${g.key} 内有重复项`)
  }
})

test('menu: 日历打卡固定在数据概览正下方（每日练习入口置顶）', () => {
  assert.deepEqual(MENU_FIXED_TOP, ['/', '/calendar'])
  // 赛事组不再包含打卡入口
  const contest = MENU_GROUPS.find((g) => g.key === 'contest')!
  assert.ok(!contest.items.includes('/calendar'))
})
