/**
 * 全局命令面板（UI 优化方案 §4.3）：`Cmd/Ctrl + K` 唤起。
 *
 * 解决「缺少全局搜索与快捷入口」：此前找一道题 / 一个模板 / 一个页面，必须先进入
 * 对应模块再搜一次，跨模块跳转成本高。
 *
 * 四个分组：
 * 1. 最近访问（localStorage，见 recentPages.ts）；
 * 2. 页面跳转（本地关键词匹配，含中英文别名）；
 * 3. 题目（服务端 `GET /api/problems/page?q=`，防抖 200ms，至少 2 个字符）；
 * 4. 模板（首次打开时拉一次 `/api/templates` 建成索引，之后纯本地过滤）。
 *
 * 键盘：↑/↓ 选择、Enter 跳转、Esc 关闭。选中项会自动滚进可视区。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Empty, Input, Modal, Skeleton, Tag } from 'antd'
import { FileTextOutlined, CompassOutlined, CodeOutlined, HistoryOutlined } from '@ant-design/icons'
import type { ReactNode } from 'react'
import { MENU, menuLabel } from '../menuConfig'
import { useRecentPages } from '../useRecentPages'
import { get } from '../api'
import { platformName } from '../ui'
import type { PlatformId } from '../../../shared/src/index.ts'
import type { TemplatesResponse } from '../types'

/** 页面关键词别名：让「找设置」「sync」这类说法都能命中拼音/英文/同义词 */
const PAGE_KEYWORDS: Record<string, string> = {
  '/': '首页 概览 dashboard 统计 overview 数据 主页',
  '/today': '今日 today 每日 训练 今天做什么',
  '/ai': 'ai 助手 chat assistant 对话 提问 解题',
  '/templates': '模板 板子 template 课程 代码 code',
  '/lists': '题单 整理 list 收藏 清单',
  '/problems': '题目 题库 管理 problem 导入 搜索',
  '/mastery': '掌握度 地图 mastery 知识点 弱项 热力',
  '/plans': '计划 训练 plan 规划 安排',
  '/calendar': '日历 打卡 calendar 签到 出勤',
  '/reviews': '复习 review 间隔 记忆 重做',
  '/contests': '赛事 比赛 contest 报名 rating',
  '/settings': '设置 setting 配置 账号 同步 偏好 主题',
  '/about': '关于 about 版本 更新 反馈',
}

interface ProblemHit {
  platform: PlatformId
  problem_key: string
  title: string
  difficulty: number | null
}

interface ProblemsPageResponse {
  items: ProblemHit[]
}

interface TemplateIndexEntry {
  name: string
  categoryKey: string
  categoryName: string
  custom: boolean
}

interface PaletteItem {
  id: string
  group: string
  icon?: ReactNode
  label: string
  hint?: ReactNode
  /** 参与本地模糊匹配的文本（小写） */
  search: string
  run: () => void
}

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  onNavigate: (path: string) => void
}

/** 防抖：题目搜索不要每敲一个字符就打一次服务端 */
function useDebounced(value: string, delay = 200): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

export default function CommandPalette({ open, onClose, onNavigate }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [problems, setProblems] = useState<ProblemHit[] | null>(null)
  const [problemLoading, setProblemLoading] = useState(false)
  const [templates, setTemplates] = useState<TemplateIndexEntry[] | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const recent = useRecentPages()

  const debounced = useDebounced(query)
  const trimmed = debounced.trim()

  // 关闭时清空输入：下次唤起是干净状态，不会残留上一次的搜索结果
  useEffect(() => {
    if (!open) {
      setQuery('')
      setActive(0)
    }
  }, [open])

  // 题目远程搜索（≥2 字符才发请求）
  useEffect(() => {
    if (!open || trimmed.length < 2) {
      setProblems(null)
      setProblemLoading(false)
      return
    }
    let alive = true
    setProblemLoading(true)
    const params = new URLSearchParams({ q: trimmed, page: '1', pageSize: '6' })
    get<ProblemsPageResponse>(`/api/problems/page?${params.toString()}`)
      .then((r) => {
        if (alive) setProblems(r.items)
      })
      .catch(() => {
        // 题目搜索失败不该让整个面板不可用：其余分组照常工作
        if (alive) setProblems([])
      })
      .finally(() => {
        if (alive) setProblemLoading(false)
      })
    return () => {
      alive = false
    }
  }, [open, trimmed])

  // 模板索引：首次需要时拉一次，之后纯本地过滤
  useEffect(() => {
    if (!open || templates !== null) return
    let alive = true
    get<TemplatesResponse>('/api/templates')
      .then((r) => {
        if (!alive) return
        const flat: TemplateIndexEntry[] = []
        for (const c of r.categories) {
          for (const t of c.templates) {
            flat.push({ name: t.name, categoryKey: c.key, categoryName: c.name, custom: Boolean(t.custom) })
          }
        }
        setTemplates(flat)
      })
      .catch(() => {
        if (alive) setTemplates([])
      })
    return () => {
      alive = false
    }
  }, [open, templates])

  const go = useCallback(
    (path: string) => {
      onNavigate(path)
      onClose()
    },
    [onNavigate, onClose],
  )

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const match = (item: PaletteItem) => !needle || item.search.includes(needle)

    const recentItems: PaletteItem[] = recent.map((key) => ({
      id: `recent:${key}`,
      group: '最近访问',
      icon: <HistoryOutlined />,
      label: menuLabel(key),
      hint: key,
      search: `${menuLabel(key)} ${key} ${PAGE_KEYWORDS[key] ?? ''}`.toLowerCase(),
      run: () => go(key),
    }))

    const pageItems: PaletteItem[] = MENU.map((m) => ({
      id: `page:${m.key}`,
      group: '页面',
      icon: <CompassOutlined />,
      label: m.label,
      hint: m.key,
      search: `${m.label} ${m.key} ${PAGE_KEYWORDS[m.key] ?? ''}`.toLowerCase(),
      run: () => go(m.key),
    }))

    const problemItems: PaletteItem[] = (problems ?? []).map((p) => ({
      id: `problem:${p.platform}:${p.problem_key}`,
      group: '题目',
      icon: <FileTextOutlined />,
      label: `${p.problem_key} ${p.title}`,
      hint: (
        <>
          {platformName(p.platform)}
          {p.difficulty != null && <span className="cmdk-hint-dim"> · {p.difficulty}</span>}
        </>
      ),
      // 必须填上可检索文本：push() 会用同一个 match() 再过滤一遍，
      // 留空串会让远程结果被 `''.includes(needle) === false` 全部丢掉
      search: `${p.problem_key} ${p.title} ${platformName(p.platform)}`.toLowerCase(),
      run: () => go(`/problems?q=${encodeURIComponent(p.problem_key)}`),
    }))

    const templateItems: PaletteItem[] = (templates ?? [])
      .filter((t) => !needle || t.name.toLowerCase().includes(needle))
      .slice(0, 6)
      .map((t) => ({
        id: `template:${t.categoryKey}:${t.name}`,
        group: '模板',
        icon: <CodeOutlined />,
        label: t.name,
        hint: (
          <>
            {t.categoryName}
            {t.custom && <Tag style={{ marginLeft: 6 }}>自建</Tag>}
          </>
        ),
        // 同上：模板已按名字预过滤，这里再给出全量可检索文本，避免被 match() 二次丢掉
        search: `${t.name} ${t.categoryName}`.toLowerCase(),
        run: () => go(`/templates?q=${encodeURIComponent(t.name)}`),
      }))

    // 最近访问只在没有输入时展示（有输入时用户是在找东西，不是回访）
    const result: Array<{ title: string; items: PaletteItem[] }> = []
    const push = (title: string, items: PaletteItem[]) => {
      const filtered = items.filter(match)
      if (filtered.length) result.push({ title, items: filtered })
    }
    if (!needle) push('最近访问', recentItems)
    push('页面', pageItems)
    push('题目', problemItems)
    push('模板', templateItems)
    return result
  }, [query, recent, problems, templates, go])

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])

  // 结果集变化后把高亮项收进范围，避免高亮停在已消失的项上
  useEffect(() => {
    setActive((prev) => (prev < flat.length ? prev : Math.max(0, flat.length - 1)))
  }, [flat.length])

  // 高亮项滚进可视区（键盘上下选择时不至于选到看不见的项）
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, flat.length])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (flat.length ? (i + 1) % flat.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      flat[active]?.run()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  let index = -1
  const showProblemLoading = problemLoading && (!problems || problems.length === 0)

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={560}
      maskClosable
      className="cmdk-modal"
      styles={{ body: { padding: 0 } }}
      aria-label="全局命令面板"
    >
      <div className="cmdk">
        <Input
          autoFocus
          size="large"
          variant="borderless"
          placeholder="搜索页面、题目、模板…（↑↓ 选择，Enter 跳转，Esc 关闭）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          prefix={<CompassOutlined style={{ color: 'var(--text-3)' }} />}
          aria-label="搜索页面、题目、模板"
        />
      </div>

      <div className="cmdk-list" ref={listRef} role="listbox" aria-label="搜索结果">
        {flat.length === 0 && !showProblemLoading && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={trimmed.length === 1 ? '再输入一个字符开始搜索题目与模板' : '没有找到匹配的页面、题目或模板'}
            style={{ padding: '24px 0' }}
          />
        )}

        {groups.map((group) => (
          <div key={group.title} className="cmdk-group">
            <div className="cmdk-group-title">{group.title}</div>
            {group.items.map((item) => {
              index += 1
              const isActive = index === active
              const myIndex = index
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  data-active={isActive ? 'true' : undefined}
                  className={`cmdk-item${isActive ? ' is-active' : ''}`}
                  onMouseEnter={() => setActive(myIndex)}
                  onClick={() => item.run()}
                >
                  <span className="cmdk-item-icon">{item.icon}</span>
                  <span className="cmdk-item-label">{item.label}</span>
                  {item.hint && <span className="cmdk-item-hint">{item.hint}</span>}
                </button>
              )
            })}
          </div>
        ))}

        {showProblemLoading && (
          <div className="cmdk-group">
            <div className="cmdk-group-title">题目</div>
            <Skeleton active title={false} paragraph={{ rows: 2, width: '100%' }} style={{ padding: '8px 14px' }} />
          </div>
        )}
      </div>
    </Modal>
  )
}
