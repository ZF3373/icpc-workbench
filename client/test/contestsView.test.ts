/**
 * contestsView.ts 单元测试：赛事中心日历页签的按天分组 / 时:分缩写 / 结束多久。
 *
 * 日期用**不带时区的 ISO 串**（如 2026-10-03T20:00:00）：ES 规范把它按本地时区解析，
 * 测试在任何时区跑结果都一致。锚点：2026-10-03 是周六（02=周五、04=周日、08=周四）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { endedAgo, fmtTimeHm, groupContestsByDay } from '../src/pages/contestsView.ts'

interface Row {
  id: string
  startTimeIso: string | null
}

const c = (id: string, startTimeIso: string | null): Row => ({ id, startTimeIso })
const ids = (groups: ReturnType<typeof groupContestsByDay<Row>>) => groups.map((g) => g.items.map((r) => r.id))

// 「今天」固定为 2026-10-03（周六）正午，隔离真实时钟
const NOW = new Date(2026, 9, 3, 12, 0, 0)

describe('groupContestsByDay', () => {
  it('按本地日历日分组，组内保持传入顺序，组按首次出现排列', () => {
    const groups = groupContestsByDay(
      [
        c('a', '2026-10-03T14:00:00'),
        c('b', '2026-10-03T08:30:00'),
        c('d', '2026-10-04T08:30:00'),
        c('c', '2026-10-03T20:00:00'),
      ],
      NOW,
    )
    assert.deepEqual(ids(groups), [['a', 'b', 'c'], ['d']])
  })

  it('相对日标签：昨天 / 今天 / 明天，其余只写日期与星期', () => {
    const groups = groupContestsByDay(
      [
        c('y', '2026-10-02T20:00:00'),
        c('t', '2026-10-03T20:00:00'),
        c('m', '2026-10-04T20:00:00'),
        c('f', '2026-10-08T14:00:00'),
      ],
      NOW,
    )
    assert.deepEqual(
      groups.map((g) => g.label),
      ['昨天 · 10月2日 周五', '今天 · 10月3日 周六', '明天 · 10月4日 周日', '10月8日 周四'],
    )
  })

  it('无开始时间 / 非法时间归入末尾「时间待定」组，不影响其余分组', () => {
    const groups = groupContestsByDay([c('n', null), c('t', '2026-10-03T20:00:00'), c('x', 'not-a-date')], NOW)
    assert.deepEqual(
      groups.map((g) => [g.key, g.label, g.items.map((r) => r.id)]),
      [
        ['2026-10-03', '今天 · 10月3日 周六', ['t']],
        ['none', '时间待定', ['n', 'x']],
      ],
    )
  })

  it('空列表返回空数组', () => {
    assert.deepEqual(groupContestsByDay([], NOW), [])
  })
})

describe('fmtTimeHm', () => {
  it('只保留 时:分，个位补零', () => {
    assert.equal(fmtTimeHm('2026-10-03T08:30:00'), '08:30')
    assert.equal(fmtTimeHm('2026-10-03T22:05:00'), '22:05')
  })

  it('无时间 / 非法时间显示「时间待定」', () => {
    assert.equal(fmtTimeHm(null), '时间待定')
    assert.equal(fmtTimeHm('not-a-date'), '时间待定')
  })
})

describe('endedAgo', () => {
  const start = '2026-10-03T10:00:00' // 2 小时的比赛，12:00 结束

  it('刚过结束点显示「刚刚结束」', () => {
    assert.equal(endedAgo(start, 120, NOW.getTime()), '刚刚结束')
  })

  it('结束不足一天按 小时/分 计', () => {
    assert.equal(endedAgo(start, 120, new Date(2026, 9, 3, 13, 30).getTime()), '1 小时 30 分前结束')
    assert.equal(endedAgo(start, 120, new Date(2026, 9, 3, 12, 20).getTime()), '20 分钟前结束')
  })

  it('超过一天按 天+小时 计', () => {
    assert.equal(endedAgo(start, 120, new Date(2026, 9, 4, 14, 0).getTime()), '1 天 2 小时前结束')
  })
})
