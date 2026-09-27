/**
 * problemSort.ts 纯函数单元测试（node:test 运行）。
 * 排序在服务端做，这里只锁「状态 ↔ 查询参数 / antd sorter」的翻译规则：
 * 不排序时不发参数（默认顺序）、受控 sortOrder 只有一个列亮、第三次点击回默认。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SORT_FIELDS,
  appendSortParams,
  isSortField,
  sortFieldOf,
  sortFromAntd,
  sortTooltip,
  sorterOrderOf,
} from '../src/problemSort.ts'

const qs = (sort: Parameters<typeof appendSortParams>[1]) =>
  appendSortParams(new URLSearchParams(), sort).toString()

describe('problemSort.ts', () => {
  describe('appendSortParams', () => {
    it('未排序（null）时不写任何参数 → 服务端走默认顺序', () => {
      assert.equal(qs(null), '')
    })

    it('排序时同时下发 sort 与 order', () => {
      assert.equal(qs({ field: 'problem_key', order: 'asc' }), 'sort=problem_key&order=asc')
      assert.equal(qs({ field: 'difficulty', order: 'desc' }), 'sort=difficulty&order=desc')
    })

    it('追加到已有查询串（过滤/分页参数不丢）', () => {
      const p = appendSortParams(new URLSearchParams('page=2&bank=1'), { field: 'title', order: 'asc' })
      assert.equal(p.get('page'), '2')
      assert.equal(p.get('bank'), '1')
      assert.equal(p.get('sort'), 'title')
      assert.equal(p.get('order'), 'asc')
    })

    it('白名单外的字段不下发（防手改 URL / 未来字段名漂移）', () => {
      const p = appendSortParams(new URLSearchParams(), { field: 'nope' as never, order: 'asc' })
      assert.equal(p.toString(), '')
    })
  })

  describe('sorterOrderOf（受控 sortOrder）', () => {
    it('只有当前排序列显示箭头', () => {
      const s = { field: 'difficulty', order: 'desc' } as const
      assert.equal(sorterOrderOf(s, 'difficulty'), 'descend')
      assert.equal(sorterOrderOf(s, 'problem_key'), null)
    })

    it('升序 → ascend；未排序 → 全列为 null', () => {
      assert.equal(sorterOrderOf({ field: 'title', order: 'asc' }, 'title'), 'ascend')
      assert.equal(sorterOrderOf(null, 'title'), null)
    })
  })

  describe('sortFromAntd（点击表头的三态：升 → 降 → 取消）', () => {
    it('ascend → asc，descend → desc', () => {
      assert.deepEqual(sortFromAntd('attempts', 'ascend'), { field: 'attempts', order: 'asc' })
      assert.deepEqual(sortFromAntd('attempts', 'descend'), { field: 'attempts', order: 'desc' })
    })

    it('第三次点击（undefined）与 null 都回到默认顺序', () => {
      assert.equal(sortFromAntd('attempts', undefined), null)
      assert.equal(sortFromAntd('attempts', null), null)
    })
  })

  describe('sortFieldOf（从 antd sorter 描述取字段）', () => {
    it('优先 columnKey，其次 dataIndex；数组型 dataIndex 取第一段', () => {
      assert.equal(sortFieldOf({ columnKey: 'problem_key', field: 'title' }), 'problem_key')
      assert.equal(sortFieldOf({ field: ['difficulty', 'x'] }), 'difficulty')
      assert.equal(sortFieldOf({ field: 'last_ac_at' }), 'last_ac_at')
    })

    it('取不到白名单字段时返回 null（调用方按取消排序处理）', () => {
      assert.equal(sortFieldOf(undefined), null)
      assert.equal(sortFieldOf({}), null)
      assert.equal(sortFieldOf({ columnKey: 'nope', field: 'also-nope' }), null)
      assert.equal(sortFieldOf({ field: 'p.id; DROP TABLE problems' }), null)
    })
  })

  describe('SORT_FIELDS / isSortField', () => {
    it('白名单含题号与难度（issue #38 的硬需求）', () => {
      assert.ok(SORT_FIELDS.includes('problem_key'))
      assert.ok(SORT_FIELDS.includes('difficulty'))
      assert.ok(isSortField('title'))
      assert.equal(isSortField('constructor'), false)
      assert.equal(isSortField('__proto__'), false)
      assert.equal(isSortField(1), false)
      assert.equal(isSortField(null), false)
    })
  })

  describe('sortTooltip', () => {
    it('中文说明三态与「全量排序」', () => {
      const t = sortTooltip('题号')
      assert.match(t, /^题号排序/)
      assert.match(t, /升序/)
      assert.match(t, /降序/)
      assert.match(t, /取消排序/)
      assert.match(t, /不只是当前页/)
    })

    it('可附加字段特有的说明（题号自然序 / 难度 NULL 排最后）', () => {
      assert.match(sortTooltip('题号', '题号按自然序：P2 排在 P1001 之前'), /自然序/)
      assert.match(sortTooltip('难度', '未知难度恒排最后'), /恒排最后/)
      assert.equal(sortTooltip('标题', '').endsWith('；'), false)
    })
  })
})
