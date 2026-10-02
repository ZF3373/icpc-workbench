import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  App as AntdApp,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  TreeSelect,
  Upload,
} from 'antd'
import type { TableProps, TreeSelectProps } from 'antd'
import { ApartmentOutlined, CheckOutlined, ClearOutlined, CloudDownloadOutlined, DeleteOutlined, DownOutlined, EditOutlined, HistoryOutlined, InboxOutlined, PlusOutlined, ReadOutlined, RestOutlined, TagsOutlined, UpOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { useSearchParams } from 'react-router-dom'
import SyncProgressHint from '../components/SyncProgressHint'
import SyncHistoryDrawer from '../components/SyncHistoryDrawer'
import { useSyncProgress } from '../syncProgressContext'
import type { KnowledgeCoverage, KnowledgePointEntry, PlatformId } from '../../../shared/src/index.ts'
import { PLATFORMS } from '../../../shared/src/index.ts'
import IntentPopover from '../components/IntentPopover'
import PageHeader from '../components/PageHeader'
import PlatformTag from '../components/PlatformTag'
import { difficultyColor, formatDifficulty, OFFICIAL_NO_DIFFICULTY_TEXT, PLATFORM_COLOR, platformName, tagColor } from '../ui'
import { DIFFICULTY_BUCKETS as DIFF_BUCKETS, type DifficultyBucket } from '../problemFilter'
import { appendSortParams, sortFieldOf, sortFromAntd, sorterOrderOf, sortTooltip, type SortState } from '../problemSort'
import { codeOptionsFromTags } from '../intentOptions'
import { del, get, patch, post, put } from '../api'
import {
  progressText,
  resultText,
  type BackfillResponse,
  type BackfillRunStatus,
} from '../backfillProgress'

/** GET /api/knowledge/taxonomy 响应（服务端 taxonomy.json 结构） */
interface TaxonomyDoc {
  version: number
  categories: Array<{
    key: string
    name: string
    points: Array<{ code: string; name: string; fullName?: string }>
  }>
}

/** POST /api/knowledge/build 响应（L1 摘要 + 最新覆盖率） */
interface BuildResp {
  ok: boolean
  // ruleMissed 可选：这是 74116c5 才改出的新字段名，旧版 SEA 服务端在响应里没有它
  l1?: { scanned: number; annotated: number; tagAnnotated: number; ruleMissed?: number; skippedManual: number }
  conceptStats?: number
  coverage: KnowledgeCoverage
}

/** POST /api/import/preview 响应：变更预览（不写库） */
interface ImportPreviewResp {
  total: number
  valid: number
  invalid: Array<{ line: number; error: string }>
  preview: {
    newSubmissions: number
    duplicateSkips: number
    manualSkips: number
    /** 命中删除墓碑（回收站）且非 manual: 来源：实际导入会静默丢弃这些行 */
    tombstoneSkips: number
    problemCreates: number
    problemUpdates: number
  }
}

/** GET /api/problems/duplicates 条目：「平台 + 标题 + 归一化题号（去空格、忽略大小写）完全相同」的重复题分组（合并与过滤的预览） */
interface DuplicateGroup {
  platform: string
  title: string
  keep: { id: number; problemKey: string; attempts: number }
  remove: Array<{ id: number; problemKey: string; attempts: number }>
}

/** GET /api/problems/deleted 条目：删除墓碑（回收站），title/difficulty 为删除时刻快照，旧墓碑可为 null */
interface DeletedRow {
  platform: string
  problem_key: string
  title: string | null
  difficulty: number | null
  deleted_at: string
}

interface ProblemRow {
  id: number
  platform: PlatformId
  problem_key: string
  title: string
  difficulty: number | null
  /** 平台原生难度原文（服务端下发的 nativeDifficulty；未知为 null） */
  nativeDifficulty?: string | null
  /** 原生难度所属标度（服务端下发的 difficultyScale） */
  difficultyScale?: string | null
  /** 服务端按标度派生的原生档位名（如洛谷「提高」/ 力扣「中等」；原生难度未知时为 null） */
  difficultyLabel?: string | null
  /** 负缓存：回填问过上游、上游明确给不出该题难度（显示「无官方难度」而不是横杠） */
  difficultyGap?: boolean
  /**
   * 难度来源（服务端下发的 difficultySource）：'manual' = 用户在界面上手动标定。
   * 手动值优先级最高（manual > backfill > sync > bank），回填与同步都不会覆盖它。
   */
  difficultySource?: string | null
  url: string | null
  tags: string[]
  attempts: number
  ac_count: number
  last_ac_at: string | null
  status: 'ac' | 'tried' | 'none'
  /** 已在复习队列时为复习条目 id（用于移出），旧服务端可能缺省 */
  reviewItemId?: number | null
}

type StatusFilter = 'all' | 'ac' | 'tried' | 'none'

/** 服务端分页响应（GET /api/problems/page） */
interface ProblemsPage {
  items: ProblemRow[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

/**
 * 分面统计（GET /api/problems/facets）：难度分桶 / 平台分布 / 标签计数。
 * 由服务端聚合，前端不再持有全量行——原先侧边栏统计要求 1.9 万行全在内存里。
 */
interface ProblemsFacets {
  total: number
  difficulty: Record<string, number>
  platforms: Array<{ id: string; name: string; count: number }>
  tags: Array<{ tag: string; count: number }>
}

const STATUS_TABS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'ac', label: '已 AC' },
  { key: 'tried', label: '已尝试' },
  { key: 'none', label: '未做' },
]

const TAXONOMY_MAX = 60

/** 每页条数（服务端分页） */
const PAGE_SIZE = 50

export default function Problems() {
  // React 19 下 antd 静态 message/Modal.confirm 静默失效，必须用 App 上下文实例
  const { message, modal } = AntdApp.useApp()
  const [searchParams] = useSearchParams()
  const [rows, setRows] = useState<ProblemRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  /**
   * 排序状态（issue #38）：null = 不排序，走服务端默认顺序（难度降序、未知最后）。
   * 排序由服务端 ORDER BY 全量完成（本页只持有当前页 50 行，前端排序只能排当前页，是错的）。
   */
  const [sort, setSort] = useState<SortState | null>(null)
  // 全部题目的分面（右侧「难度/平台分布」用）与当前筛选后的分面（侧边栏标签计数用）
  const [facets, setFacets] = useState<ProblemsFacets | null>(null)
  const [unfilteredFacets, setUnfilteredFacets] = useState<ProblemsFacets | null>(null)
  const loadRef = useRef<() => void>(() => {})
  const [loading, setLoading] = useState(false)
  const [platform, setPlatform] = useState<string>()
  // 所选标签按「逻辑或」组合；支持从其它页面带 ?tag= 跳入（如掌握度地图「查看全部」）
  const [tagFilters, setTagFilters] = useState<string[]>(() => {
    const t = searchParams.get('tag')
    return t ? [t] : []
  })
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [q, setQ] = useState<string>()
  const [qInput, setQInput] = useState('')
  // 难度区间（CF rating 标尺，闭区间；未知难度的题在设置区间后不显示）
  const [diffMin, setDiffMin] = useState<number | undefined>()
  const [diffMax, setDiffMax] = useState<number | undefined>()
  /** 「未知」难度桶：与 diffMin/diffMax 互斥（服务端 difficulty=未知 → IS NULL 分支） */
  const [diffUnknown, setDiffUnknown] = useState(false)
  // 「过滤问题」面板：编辑草稿，点「应用」才生效（展开时以已生效条件为初值）
  const [filterOpen, setFilterOpen] = useState(false)
  // 顶部概览条（难度/平台分布）折叠：偏好写入 localStorage，收起后只留一行标签
  const [distCollapsed, setDistCollapsed] = useState(
    () => localStorage.getItem('problems.distCollapsed') === '1',
  )
  const toggleDistCollapsed = () =>
    setDistCollapsed((c) => {
      localStorage.setItem('problems.distCollapsed', c ? '0' : '1')
      return !c
    })
  const [draftTags, setDraftTags] = useState<string[]>([])
  const [draftDiffMin, setDraftDiffMin] = useState<number | undefined>()
  const [draftDiffMax, setDraftDiffMax] = useState<number | undefined>()
  // 内置题库开箱即用：默认包含未做题库题（否则题库再大默认视图也只有做过的题）
  const [includeBank, setIncludeBank] = useState(true)
  const [importOpen, setImportOpen] = useState(() => searchParams.get('import') === 'sync')
  /** 「导入刷题记录」弹窗当前页签（受控：SyncTab 用它判断自己是否活跃，从而刷新/轮询续拉状态） */
  const [importTab, setImportTab] = useState('sync')
  const [cleaning, setCleaning] = useState(false)
  // 回收站（issue #27 误删恢复）：null = 旧服务端无此接口 → 隐藏入口；否则为墓碑清单
  const [trash, setTrash] = useState<DeletedRow[] | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [manualForm] = Form.useForm()
  // 知识点管线（P4）：覆盖率 + 批跑/无 Key 导出入口
  const [pipelineOpen, setPipelineOpen] = useState(false)
  const [coverage, setCoverage] = useState<KnowledgeCoverage | null>(null)
  const [pipelineBusy, setPipelineBusy] = useState(false)

  // 批跑后抽检清单（GET /api/knowledge/sample）
  const [sample, setSample] = useState<{ sampleSize: number; items: Array<{ platform: string; problemKey: string; code: string; name: string; confidence: number; source: string; method: string }> } | null>(null)

  // 单题知识点人工校正（L3）
  const [kpEditRow, setKpEditRow] = useState<ProblemRow | null>(null)
  const [kpTree, setKpTree] = useState<NonNullable<TreeSelectProps['treeData']>>([])
  const [kpCodes, setKpCodes] = useState<string[]>([])
  const [kpSaving, setKpSaving] = useState(false)

  // 手动标定难度（上游给不出的题：已删除 / 私有 / 永久未评级 / gym 官方 Unrated）
  const [diffEditRow, setDiffEditRow] = useState<ProblemRow | null>(null)
  const [diffEditValue, setDiffEditValue] = useState<number | null>(null)
  const [diffSaving, setDiffSaving] = useState(false)

  // 过滤条件 → 查询串（服务端过滤；分页参数单独拼，便于翻页时复用同一组条件）
  const buildFilterParams = useCallback(() => {
    const params = new URLSearchParams()
    if (platform) params.set('platform', platform)
    if (q) params.set('q', q)
    if (includeBank) params.set('bank', '1')
    if (statusFilter !== 'all') params.set('status', statusFilter)
    // 难度：「未知」桶直接下发桶名（服务端 IS NULL 分支）；命中区间桶时用桶名，否则用显式区间
    const bucket = DIFF_BUCKETS.find((b) => b.min === (diffMin ?? null) && b.max === (diffMax ?? null))
    if (diffUnknown) {
      params.set('difficulty', '未知')
    } else if (diffMin === undefined && diffMax === undefined) {
      /* 不限难度 */
    } else if (bucket) {
      params.set('difficulty', bucket.key)
    } else {
      if (diffMin != null) params.set('diffMin', String(diffMin))
      if (diffMax != null) params.set('diffMax', String(diffMax))
    }
    // 标签多选按「或」：重复 tag 参数，服务端展开同义别名后取并集
    for (const t of tagFilters) params.append('tag', t)
    // 排序（issue #38）：sort/order 下推到服务端 ORDER BY；未排序时不写参数 = 默认顺序
    appendSortParams(params, sort)
    return params
  }, [platform, q, includeBank, statusFilter, diffMin, diffMax, diffUnknown, tagFilters, sort])

  // 只允许「最新一次请求」落地：连点筛选/翻页时多个请求在途，晚到的旧响应若照常写回，
  // 会把旧条件的行连同它的 total/page 一起盖上去，之后没有新请求来自愈（界面长期停在错数据上）
  const reqSeq = useRef(0)
  // 分面统计各自一个序号：它们与列表是两个独立请求（分面按筛选条件、分布图只按 includeBank），
  // 共用 reqSeq 会互相作废。缺护栏时后到的旧响应会把侧栏计数盖成上一个条件的口径，
  // 而「共 N 题」来自当前条件 —— 同一屏两个数互相矛盾且不再自愈
  const facetsSeq = useRef(0)
  const unfilteredFacetsSeq = useRef(0)

  const load = useCallback((nextPage: number) => {
    const seq = (reqSeq.current += 1)
    setLoading(true)
    const params = buildFilterParams()
    params.set('page', String(nextPage))
    params.set('pageSize', String(PAGE_SIZE))
    get<ProblemsPage>(`/api/problems/page?${params.toString()}`)
      .then((res) => {
        if (seq !== reqSeq.current) return
        setRows(res.items)
        setTotal(res.total)
        setPage(res.page)
      })
      .catch((e: Error) => {
        if (seq === reqSeq.current) message.error(e.message)
      })
      .finally(() => {
        if (seq === reqSeq.current) setLoading(false)
      })
  }, [buildFilterParams, message])

  // 当前生效条件（翻页/变更都按它取数）；loadRef 让事件回调始终调用最新版本
  const queryKey = buildFilterParams().toString()
  loadRef.current = () => load(page)

  // 条件变化 → 回到第 1 页重新取数
  useEffect(() => {
    load(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey])

  // 分面统计：侧边栏标签计数随筛选联动；右侧分布图始终按全部题目口径
  const reloadFacets = useCallback(() => {
    const seq = (facetsSeq.current += 1)
    const params = buildFilterParams()
    get<ProblemsFacets>(`/api/problems/facets?${params.toString()}`)
      .then((res) => {
        if (seq === facetsSeq.current) setFacets(res)
      })
      .catch(() => { /* 服务端未升级时静默：分面缺失仅影响侧栏计数 */ })
  }, [buildFilterParams])

  useEffect(() => {
    reloadFacets()
  }, [reloadFacets])

  // 右侧分布图用「不带筛选、但同样遵守『含题库未做题』开关」的口径。
  // 必须与列表的候选集一致：服务端缺省只显示做过的题，若这里漏掉 bank=1，
  // 分布合计会与「共 N 题」对不上（默认 includeBank=true，差异约 1.8 万）。
  // 提取成函数：删除/清洗会改变全库口径的计数，须与 reloadFacets 一并刷新
  const reloadUnfilteredFacets = useCallback(() => {
    const seq = (unfilteredFacetsSeq.current += 1)
    get<ProblemsFacets>(`/api/problems/facets${includeBank ? '?bank=1' : ''}`)
      .then((res) => {
        if (seq === unfilteredFacetsSeq.current) setUnfilteredFacets(res)
      })
      .catch(() => { /* 同上 */ })
  }, [includeBank])

  useEffect(() => {
    reloadUnfilteredFacets()
  }, [reloadUnfilteredFacets])

  // 回收站墓碑清单：旧服务端 GET /deleted 404 → 置 null 隐藏入口（与分面同口径静默降级）
  const loadTrash = useCallback(() => {
    get<DeletedRow[]>('/api/problems/deleted')
      .then(setTrash)
      .catch(() => setTrash(null))
  }, [])

  useEffect(() => {
    loadTrash()
  }, [loadTrash])

  // ---------- 知识点管线 ----------

  const loadCoverage = useCallback(() => {
    get<KnowledgeCoverage>('/api/knowledge/coverage')
      .then(setCoverage)
      .catch(() => { /* 服务端未升级时静默 */ })
  }, [])

  useEffect(() => {
    loadCoverage()
  }, [loadCoverage])

  /** 跑管线：L1 规则批跑 / 版本差量重跑（单请求，秒级） */
  const runPipeline = async (body: { mode: 'l1'; rerun?: boolean }) => {
    setPipelineBusy(true)
    try {
      const r = await post<BuildResp>('/api/knowledge/build', body)
      if (r.l1) {
        // 口径：ruleMissed 只数「规则未命中」，与 gapReport 的词表缺口不是同一集合
        // （规则没打中的题仍可能被题源标签完整标注）。这条口径只留在代码注释里，
        // 用户可见文案保持简洁；与 gen-knowledge.ts 的同名计数用词一致。
        // ?? 0：新版前端可能连到旧版 SEA 服务端，该字段尚不存在，直接插值会显示 undefined。
        message.success(
          `L1 扫描 ${r.l1.scanned} 题：规则命中落库 ${r.l1.annotated}，题源标签映射 ${r.l1.tagAnnotated}，` +
            `规则未命中 ${r.l1.ruleMissed ?? 0}` +
            (r.l1.skippedManual ? `，跳过人工标注 ${r.l1.skippedManual}` : ''),
        )
      }
      setCoverage(r.coverage)
      loadRef.current()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setPipelineBusy(false)
    }
  }

  /** 批跑后随机抽检 1%：生成核对清单，人工复核驱动规则迭代 */
  const loadSample = async () => {
    setPipelineBusy(true)
    try {
      setSample(
        await get<{ sampleSize: number; items: Array<{ platform: string; problemKey: string; code: string; name: string; confidence: number; source: string; method: string }> }>(
          '/api/knowledge/sample',
        ),
      )
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setPipelineBusy(false)
    }
  }

  /** 打开单题知识点校正弹窗：首次加载体系树，再取当前标注预填 */
  const openKpEditor = async (r: ProblemRow) => {
    setKpEditRow(r)
    setKpCodes([])
    try {
      if (kpTree.length === 0) {
        const doc = await get<TaxonomyDoc>('/api/knowledge/taxonomy')
        setKpTree(
          doc.categories.map((c) => ({
            title: c.name,
            value: `cat:${c.key}`,
            selectable: false,
            children: c.points.map((p) => ({
              title: p.fullName && p.fullName !== p.name ? `${p.name}（${p.fullName}）` : p.name,
              value: p.code,
            })),
          })),
        )
      }
      const cur = await get<{ knowledgePoints: KnowledgePointEntry[] }>(
        `/api/knowledge/problem/${r.platform}/${encodeURIComponent(r.problem_key)}`,
      )
      setKpCodes(cur.knowledgePoints.map((p) => p.code))
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /** 保存人工标注：整题覆盖写 source=manual，重跑管线不覆盖 */
  const saveKp = async () => {
    if (!kpEditRow) return
    setKpSaving(true)
    try {
      await put(`/api/knowledge/${kpEditRow.platform}/${encodeURIComponent(kpEditRow.problem_key)}`, { codes: kpCodes })
      message.success('已保存人工标注（重跑管线不会覆盖）')
      setKpEditRow(null)
      loadCoverage()
      loadRef.current()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setKpSaving(false)
    }
  }

  /**
   * 打开手动难度弹窗（预填库内当前值）。
   * 入口在难度单元格上：上游确实给不出难度的题（负缓存「无官方难度」、洛谷永久未评级、
   * gym 官方 Unrated）永远等不到回填结果，只能由用户自己标定。
   */
  const openDiffEditor = (r: ProblemRow) => {
    setDiffEditRow(r)
    setDiffEditValue(r.difficulty)
  }

  /**
   * 保存/清除手动难度（PATCH /api/problems/:platform/:key/difficulty）。
   * 服务端把 difficulty_source 置 'manual'（回填与同步都不再覆盖），并连带写同源的原生值与标度、
   * 清掉「平台无公开难度」负缓存；`null` = 清除，恢复「未知」并重新成为回填目标。
   * 就地更新当前页那一行（不整页重取），保证用户停在原页码与滚动位置。
   */
  const saveDiff = async (value: number | null) => {
    if (!diffEditRow) return
    setDiffSaving(true)
    try {
      const res = await patch<{
        ok: boolean
        difficulty: number | null
        difficultySource: string | null
        nativeDifficulty: string | null
        difficultyScale: string | null
        difficultyLabel: string | null
      }>(
        `/api/problems/${diffEditRow.platform}/${encodeURIComponent(diffEditRow.problem_key)}/difficulty`,
        { difficulty: value },
      )
      const id = diffEditRow.id
      setRows((prev) =>
        prev.map((x) =>
          x.id === id
            ? {
                ...x,
                difficulty: res.difficulty,
                difficultySource: res.difficultySource,
                nativeDifficulty: res.nativeDifficulty,
                difficultyScale: res.difficultyScale,
                difficultyLabel: res.difficultyLabel,
                difficultyGap: false,
              }
            : x,
        ),
      )
      message.success(
        value === null
          ? `已清除 ${diffEditRow.problem_key} 的难度（恢复「未知」，下次回填会重新查）`
          : `已保存手动难度 ${value}（回填不会覆盖；难度分布与弱项分析已同步）`,
      )
      setDiffEditRow(null)
      reloadFacets()
      reloadUnfilteredFacets()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setDiffSaving(false)
    }
  }

  // 一键清洗：归并英文别名为中文规范名 + 清除噪声标签 + 删除「平台 + 标题 + 归一化题号完全
  // 相同」的重复题（issue #27，写入数据库，全站生效）。先取重复题分组做确认预览；
  // 旧版服务端没有预览接口时静默按「无重复」处理，只做标签清洗。
  const cleanTags = async () => {
    setCleaning(true)
    let dupes: DuplicateGroup[] = []
    try {
      dupes = await get<DuplicateGroup[]>('/api/problems/duplicates')
    } catch {
      dupes = []
    }
    setCleaning(false)
    modal.confirm({
      title: dupes.length > 0 ? '合并标签并删除重复题目？' : '合并与过滤所有标签？',
      width: 520,
      content: (
        <div style={{ fontSize: 13 }}>
          <p style={{ margin: '4px 0' }}>
            将把库内全部题目的英文别名归并为中文规范名（dp → 动态规划、binary search → 二分），
            并清除年份、赛事、地区等噪声标签。掌握度地图、数据概览、弱项分析会自动同步。
          </p>
          {dupes.length > 0 && (
            <>
              <p style={{ margin: '4px 0' }}>
                另发现 <b>{dupes.length}</b> 组「平台 + 标题 + 题号（忽略空格与大小写）完全相同」的重复题目：
                每组保留 1 条（优先保留有提交记录的），其余删除——提交 / 卡点 / 计划任务并入保留题，
                复习条目与保留题冲突时丢弃重复行的。同标题但题号不同的题（CF 各轮撞名）不算重复，不会被动。
              </p>
              <ul style={{ paddingLeft: 18, margin: '4px 0' }}>
                {dupes.slice(0, 5).map((g) => (
                  <li key={`${g.platform}/${g.title}/${g.keep.problemKey}`}>
                    {platformName(g.platform as PlatformId)}「{g.title}」：保留 {g.keep.problemKey}，删除{' '}
                    {g.remove.map((d) => d.problemKey).join('、')}
                  </li>
                ))}
              </ul>
              {dupes.length > 5 && <span style={{ color: '#8993a2' }}>… 共 {dupes.length} 组</span>}
            </>
          )}
        </div>
      ),
      okText: dupes.length > 0 ? `开始清洗（去重 ${dupes.length} 组）` : '开始清洗',
      cancelText: '取消',
      onOk: async () => {
        setCleaning(true)
        try {
          const r = await post<{ total: number; problemsCleaned: number; tagsRemoved: number; duplicatesRemoved: number }>(
            '/api/problems/clean-tags',
            {},
          )
          const parts: string[] = []
          if (r.problemsCleaned > 0) parts.push(`${r.problemsCleaned} 道题的标签已更新，共清除/归并 ${r.tagsRemoved} 个标签`)
          // 旧版服务端无 duplicatesRemoved 字段（undefined），不会误报 0
          if (r.duplicatesRemoved > 0) parts.push(`删除重复题目 ${r.duplicatesRemoved} 道（引用已并入保留题）`)
          message.success(
            parts.length > 0
              ? `清洗完成：${parts.join('；')}`
              : `所有 ${r.total} 道题的标签已经是干净的，也没有重复题目`,
          )
          loadRef.current()
          reloadFacets()
          // 去重会改变全库题数：右侧分布图（无筛选口径）也要刷新
          reloadUnfilteredFacets()
        } catch (e) {
          message.error((e as Error).message)
        } finally {
          setCleaning(false)
        }
      },
    })
  }

  // 标签计数由服务端分面给出（已按同口径滤噪声 + 归并规范名），前端不再遍历全量行。
  // facets 随当前筛选联动，语义与改版前「基于 rows 统计」一致，但不需要把整库放进内存。
  const tagCountEntries = useMemo<Array<[string, number]>>(
    () => (facets?.tags ?? []).map((t) => [t.tag, t.count] as [string, number]),
    [facets],
  )
  const tagCounts = useMemo(() => tagCountEntries.slice(0, TAXONOMY_MAX), [tagCountEntries])

  // 已生效的面板条件数（用于面板收起时的角标提示）
  const activeFilterCount =
    tagFilters.length + (diffUnknown || diffMin != null || diffMax != null ? 1 : 0)

  const toggleFilterPanel = () => {
    if (!filterOpen) {
      setDraftTags(tagFilters)
      setDraftDiffMin(diffMin)
      setDraftDiffMax(diffMax)
    }
    setFilterOpen(!filterOpen)
  }

  const applyPanelFilters = () => {
    setTagFilters(draftTags)
    setDiffMin(draftDiffMin)
    setDiffMax(draftDiffMax)
    // 面板里的手动区间优先：显式区间与「未知」桶互斥
    setDiffUnknown(false)
  }

  const clearPanelFilters = () => {
    setDraftTags([])
    setDraftDiffMin(undefined)
    setDraftDiffMax(undefined)
    setTagFilters([])
    setDiffMin(undefined)
    setDiffMax(undefined)
    setDiffUnknown(false)
  }

  // 侧边栏标签点击 = 加入 / 移出多选（再点一次取消）
  const toggleSidebarTag = (t: string) =>
    setTagFilters((arr) => (arr.includes(t) ? arr.filter((x) => x !== t) : [...arr, t]))

  // 概览面板：难度 / 平台分布（全部题目口径，由服务端分面聚合；点击分桶即设难度区间）
  const diffDist = useMemo(
    () =>
      DIFF_BUCKETS.map((b) => ({
        ...b,
        count: unfilteredFacets?.difficulty[b.key] ?? 0,
      })).map((b) => ({
        ...b,
        color: b.min == null ? '#8993a2' : difficultyColor((b.min + (b.max ?? b.min + 199)) / 2),
      })),
    [unfilteredFacets],
  )

  const platDist = useMemo(
    () =>
      PLATFORMS.map((p) => ({
        id: p.id,
        name: p.name,
        count: unfilteredFacets?.platforms.find((x) => x.id === p.id)?.count ?? 0,
      }))
        .filter((x) => x.count > 0)
        .sort((a, b) => b.count - a.count),
    [unfilteredFacets],
  )

  /** 分桶是否选中（「未知」桶 min/max 均为 null，走 diffUnknown 状态） */
  const isBucketActive = (b: DifficultyBucket) =>
    b.min == null
      ? diffUnknown
      : !diffUnknown && diffMin === b.min && (diffMax ?? null) === b.max

  /** 点难度分桶 = 把该桶区间设为筛选条件（再点一次取消）；「未知」桶走难度未知分支 */
  const toggleDiffBucket = (b: DifficultyBucket) => {
    if (isBucketActive(b)) {
      setDiffMin(undefined)
      setDiffMax(undefined)
      setDiffUnknown(false)
      return
    }
    if (b.min == null) {
      setDiffUnknown(true)
      setDiffMin(undefined)
      setDiffMax(undefined)
      return
    }
    setDiffUnknown(false)
    setDiffMin(b.min)
    setDiffMax(b.max ?? undefined)
  }

  const resetFilters = () => {
    setPlatform(undefined)
    setTagFilters([])
    setStatusFilter('all')
    setDiffMin(undefined)
    setDiffMax(undefined)
    setDiffUnknown(false)
    setDraftTags([])
    setDraftDiffMin(undefined)
    setDraftDiffMax(undefined)
    setQ(undefined)
    setQInput('')
    setIncludeBank(true)
  }

  const markAc = async (r: ProblemRow) => {
    try {
      await post('/api/import/manual', {
        platform: r.platform,
        rows: [
          {
            problemKey: r.problem_key,
            title: r.title,
            verdict: 'AC',
            difficulty: r.difficulty ?? undefined,
            tags: r.tags,
            url: r.url ?? undefined,
          },
        ],
      })
      message.success(`已标记 ${r.problem_key} 为 AC`)
      loadRef.current()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const addToReview = async (r: ProblemRow) => {
    try {
      const res = await post<{ alreadyInQueue: boolean; nextDueOn: string }>('/api/reviews', {
        platform: r.platform,
        problemKey: r.problem_key,
      })
      // 新条目按题目 id 错峰 0–3 天到期（批量加入时不再同日堆满），所以要把日期念出来
      message.success(
        `「${r.problem_key}」${res.alreadyInQueue ? '已在复习队列' : '已加入复习队列'}，下次到期 ${res.nextDueOn}`,
      )
      loadRef.current()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const removeFromReview = async (r: ProblemRow) => {
    if (r.reviewItemId == null) return
    try {
      await del(`/api/reviews/${r.reviewItemId}`)
      message.success(`「${r.problem_key}」已移出复习队列`)
      loadRef.current()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // 删除题目（issue #27：题库重复题目没有删除入口）。用于清理跨平台镜像/误导入的行；
  // 服务端连带删除该题的提交、复习条目、卡点与知识点标注，此处把代价讲清楚再让用户确认。
  const removeProblem = (r: ProblemRow) => {
    modal.confirm({
      title: `删除题目 ${r.problem_key}？`,
      content: (
        <div style={{ fontSize: 13 }}>
          <p style={{ margin: '4px 0' }}>
            将一并删除该题的提交记录（{r.attempts} 条）、复习条目（{r.reviewItemId != null ? 1 : 0} 条）、
            卡点与知识点标注，相关统计同步减少且<b>不可恢复</b>；训练计划里引用该题的任务仅解除关联。
          </p>
          <p style={{ margin: '4px 0', color: '#8993a2' }}>
            仅用于清理重复 / 误导入的题目；如需隐藏题库未做题，关掉「含题库未做题」即可。
            删除后同步与题库拉取不再重建该题；题目行可在工具栏「回收站」恢复（提交 / 复习 /
            卡点 / 人工知识点标注不会找回）。
          </p>
        </div>
      ),
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await del<{ ok: boolean; deletedSubmissions: number; deletedReviewItems: number }>(
            `/api/problems/${r.id}`,
          )
          message.success(
            `已删除 ${r.problem_key}（含提交 ${res.deletedSubmissions} 条、复习条目 ${res.deletedReviewItems} 条）`,
          )
          loadRef.current()
          reloadFacets()
          reloadUnfilteredFacets()
          loadTrash()
        } catch (e) {
          message.error((e as Error).message)
        }
      },
    })
  }

  // 回收站恢复：服务端按墓碑快照重建题目行并清墓碑；提交/复习/卡点不复活，弹窗里再确认一次
  const restoreProblem = (t: DeletedRow) => {
    modal.confirm({
      title: `恢复题目 ${t.problem_key}？`,
      content: (
        <div style={{ fontSize: 13 }}>
          <p style={{ margin: '4px 0' }}>
            将按删除时刻的快照重建题目行（标题 / 难度 / 标签），此后同步与题库拉取恢复正常收录。
          </p>
          <p style={{ margin: '4px 0', color: '#8993a2' }}>
            删除时清掉的提交、复习条目、卡点与人工知识点标注不会找回；同步平台题目下次同步会拉回提交记录。
          </p>
        </div>
      ),
      okText: '恢复',
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await post<{ ok: boolean; recreated: boolean }>(
            '/api/problems/deleted/restore',
            { platform: t.platform, problemKey: t.problem_key },
          )
          message.success(res.recreated ? `已恢复 ${t.problem_key}` : `${t.problem_key} 已在库中（墓碑已清除）`)
          loadTrash()
          loadRef.current()
          reloadFacets()
          reloadUnfilteredFacets()
        } catch (e) {
          message.error((e as Error).message)
        }
      },
    })
  }

  const uploadProps = {
    beforeUpload: (file: File) => {
      if (!platform) {
        message.warning('请先选择平台')
        return false
      }
      const reader = new FileReader()
      reader.onload = async () => {
        const text = String(reader.result ?? '')
        try {
          const isCsv = file.name.endsWith('.csv')
          const endpoint = isCsv ? '/api/import/csv' : '/api/import/manual'
          const body = isCsv ? { platform, csv: text } : { platform, rows: JSON.parse(text) as unknown[] }
          // 变更预览：先看不写库，确认后才真正导入
          const pv = await post<ImportPreviewResp>('/api/import/preview', body)
          modal.confirm({
            title: '导入预览（未写入任何数据）',
            width: 520,
            content: (
              <div style={{ fontSize: 13 }}>
                <p>共 {pv.total} 行：合法 {pv.valid} 行，非法 {pv.invalid.length} 行</p>
                <ul style={{ paddingLeft: 18, margin: '4px 0' }}>
                  <li>将新增提交：<b>{pv.preview.newSubmissions}</b> 条</li>
                  <li>
                    重复跳过：{pv.preview.duplicateSkips} 条；同题同结果跳过：{pv.preview.manualSkips} 条
                    {pv.preview.tombstoneSkips > 0 && <>；已被删除（回收站）跳过：{pv.preview.tombstoneSkips} 条</>}
                  </li>
                  <li>题目新建 {pv.preview.problemCreates} 个 / 更新 {pv.preview.problemUpdates} 个</li>
                </ul>
                {pv.invalid.length > 0 && (
                  <div style={{ color: '#d4380d' }}>
                    非法行示例：
                    <ul style={{ paddingLeft: 18 }}>
                      {pv.invalid.slice(0, 3).map((r) => (
                        <li key={r.line}>第 {r.line} 行：{r.error}</li>
                      ))}
                    </ul>
                    {pv.invalid.length > 3 && <span>… 共 {pv.invalid.length} 条</span>}
                  </div>
                )}
              </div>
            ),
            okText: pv.invalid.length ? `仍要导入（${pv.valid} 条合法）` : '确认导入',
            cancelText: '取消',
            onOk: async () => {
              // 失败必须报出来：不 catch 时 antd 只把确认框留着，用户看到的是「点了没反应」
              try {
                await post(endpoint, body)
                message.success('导入成功')
                setImportOpen(false)
                loadRef.current()
              } catch (e) {
                message.error((e as Error).message)
              }
            },
          })
        } catch (e) {
          message.error((e as Error).message)
        }
      }
      reader.readAsText(file)
      return false
    },
  }

  /**
   * 表头排序（issue #38）：antd 只负责给出「点了几次」，带箭头显示与取数都由这里的状态决定。
   * 排序变化会改变 queryKey → 下面那个 useEffect 回到第 1 页重取：
   * 否则「第 3 页 + 新排序」会落到全量结果的第 3 页，看起来像排错了或空白。
   * 翻页同样触发 onChange（sorter 为当前排序）—— next 与现状相同时保持原对象，避免多余请求。
   */
  const onTableChange: TableProps<ProblemRow>['onChange'] = (_pagination, _filters, sorter) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter
    const field = s?.order ? sortFieldOf(s) : null
    const next = field ? sortFromAntd(field, s.order) : null
    setSort((prev) => (prev?.field === next?.field && prev?.order === next?.order ? prev : next))
  }

  const cols: ColumnsType<ProblemRow> = [
    {
      title: '平台',
      dataIndex: 'platform',
      width: 110,
      // sorter: true = 服务端排序（数据源只是当前页，antd 的本地比较函数在这里没有意义）；
      // sortOrder 受控：只有当前排序列亮箭头，null 表示该列未参与排序
      sorter: true,
      sortOrder: sorterOrderOf(sort, 'platform'),
      showSorterTooltip: { title: sortTooltip('平台') },
      render: (v: PlatformId) => <PlatformTag id={v} />,
    },
    {
      title: '题号',
      dataIndex: 'problem_key',
      width: 120,
      sorter: true,
      sortOrder: sorterOrderOf(sort, 'problem_key'),
      // 题号是「形状各异」的字符串（P1001 / abc321_a / 1919C），服务端按长度+字典序近似自然序
      showSorterTooltip: { title: sortTooltip('题号', '题号按自然序，P2 排在 P1001 之前') },
      render: (v: string, r) => (r.url ? <a className="mono" href={r.url} target="_blank" rel="noreferrer">{v}</a> : <span className="mono">{v}</span>),
    },
    {
      title: '标题',
      dataIndex: 'title',
      ellipsis: true,
      sorter: true,
      sortOrder: sorterOrderOf(sort, 'title'),
      showSorterTooltip: { title: sortTooltip('标题') },
      render: (v: string, r) => (r.url ? <a href={r.url} target="_blank" rel="noreferrer">{v}</a> : v),
    },
    {
      title: '难度',
      dataIndex: 'difficulty',
      width: 88,
      align: 'right',
      sorter: true,
      sortOrder: sorterOrderOf(sort, 'difficulty'),
      // 未评级（无难度）的行不参与难度比较，统一排在最后（升/降序都一样，见服务端 SORT_KEYS）
      showSorterTooltip: { title: sortTooltip('难度', '未知难度恒排最后') },
      // 单元格只放 CF 标尺数值（列宽有限）；悬停给出「数值 · 平台 原生档位」双标度，
      // 原生档位名直接用服务端下发的 difficultyLabel（前端不重算档位映射表）。
      // 空值分两种：`-` = 还没查过/查失败；`无官方难度` = 回填问过上游、上游确实不给评级
      // （负缓存，见服务端 gap_state）—— 二者对用户是完全不同的两件事，不能都显示一个横杠。
      // 单元格整体是「手动填写难度」的入口：上游给不出的题（已删除/私有/永久未评级/gym Unrated）
      // 永远等不到回填结果，用户只能自己标定（manual 优先级最高，回填不会覆盖）。
      render: (v: number | null, r) => {
        const manual = r.difficultySource === 'manual'
        return (
          <Tooltip
            title={
              <>
                <div>{formatDifficulty(
                  v,
                  r.difficultyLabel,
                  r.difficultyScale,
                  r.difficultyGap ? OFFICIAL_NO_DIFFICULTY_TEXT : undefined,
                )}</div>
                <div style={{ color: '#c9d4e0' }}>
                  {manual ? '手动标定（回填与同步不会覆盖）' : '点击这一格可手动填写难度'}
                </div>
              </>
            }
          >
            <button
              type="button"
              className="difficulty-edit"
              aria-label={`手动填写难度：${r.problem_key}`}
              onClick={() => openDiffEditor(r)}
            >
              {v == null ? (
                <span style={{ color: '#4e5a68' }}>{r.difficultyGap ? '无官方难度' : '-'}</span>
              ) : (
                <span className={`rating-pill mono${manual ? ' is-manual' : ''}`} style={{ color: difficultyColor(v) }}>{v}</span>
              )}
            </button>
          </Tooltip>
        )
      },
    },
    {
      title: '标签',
      dataIndex: 'tags',
      width: 230,
      render: (tags: string[]) =>
        tags.length ? (
          <Space size={4} wrap>
            {tags.slice(0, 3).map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
            {tags.length > 3 && <span className="tag-more">+{tags.length - 3}</span>}
          </Space>
        ) : (
          <span style={{ color: '#4e5a68' }}>-</span>
        ),
    },
    {
      title: '提交',
      dataIndex: 'attempts',
      width: 70,
      align: 'right',
      sorter: true,
      sortOrder: sorterOrderOf(sort, 'attempts'),
      showSorterTooltip: { title: sortTooltip('提交次数') },
    },
    {
      title: '操作',
      // 5 个按钮最小内容宽约 214px + 单元格内边距，150 会把「卡在哪」裁出列外
      width: 232,
      fixed: 'right',
      render: (_v, r) => (
        <Space size={4}>
          {r.status !== 'ac' && (
            <Button size="small" onClick={() => markAc(r)}>
              标记 AC
            </Button>
          )}
          {r.reviewItemId != null ? (
            <Tooltip title="已加入复习队列，点击移出">
              <Button
                size="small"
                type="text"
                className="review-added-btn"
                icon={<CheckOutlined />}
                onClick={() => removeFromReview(r)}
              />
            </Tooltip>
          ) : (
            <Tooltip title="加入复习队列（间隔复习）">
              <Button size="small" type="text" icon={<ReadOutlined />} onClick={() => addToReview(r)} />
            </Tooltip>
          )}
          <Tooltip title="人工校正知识点（L3，重跑管线不覆盖）">
            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => void openKpEditor(r)} />
          </Tooltip>
          <Tooltip title="记录你卡在哪，用于弱项判断">
            <span>
              <IntentPopover
                platform={r.platform}
                problemKey={r.problem_key}
                codeOptions={codeOptionsFromTags(r.tags)}
                onSuccess={(m) => message.success(m)}
                onError={(m) => message.error(m)}
              />
            </span>
          </Tooltip>
          <Tooltip title="删除题目（清理重复 / 误导入；连带删除其提交与复习记录）">
            <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeProblem(r)} />
          </Tooltip>
        </Space>
      ),
    },
  ]

  const diffDistMax = Math.max(1, ...diffDist.map((d) => d.count))
  const platMax = Math.max(1, ...platDist.map((d) => d.count))

  return (
    <div>
      <PageHeader
        title="题目管理"
        description="管理和导入你在各平台的刷题记录"
        extra={
          <Space>
            <Tooltip title="自建知识点管线：L1 规则 + 题源标签映射，替代题源 tag 统计口径">
              <Button icon={<ApartmentOutlined />} onClick={() => { setPipelineOpen(true); loadCoverage() }}>
                知识点管线
              </Button>
            </Tooltip>
            <Tooltip title="归并英文别名为中文规范名、清除噪声标签，并删除平台 + 标题 + 题号（忽略空格与大小写）相同的重复题（写入数据库）">
              <Button icon={<TagsOutlined />} loading={cleaning} onClick={cleanTags}>
                合并与过滤
              </Button>
            </Tooltip>
            {trash !== null && trash.length > 0 && (
              <Tooltip title="回收站：误删的题目可在此恢复题目行（提交/复习/卡点不找回）">
                <Button icon={<RestOutlined />} onClick={() => setTrashOpen(true)}>
                  回收站 · {trash.length}
                </Button>
              </Tooltip>
            )}
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setImportOpen(true)}>
              导入题目
            </Button>
          </Space>
        }
      />

      {/* 顶部概览条：难度分布 + 平台分布（点击难度区间可筛选；右上角按钮可折叠成一行标签） */}
      <aside className={`side-panel${distCollapsed ? ' is-collapsed' : ''}`}>
        <button
          type="button"
          className="side-panel__toggle"
          title={distCollapsed ? '展开分布概览' : '收起分布概览'}
          onClick={toggleDistCollapsed}
        >
          {distCollapsed ? <DownOutlined /> : <UpOutlined />}
        </button>
        <div className="panel-block">
          <div className="section-label">难度分布</div>
          <div className="dist-list">
            {diffDist.map((d) => (
              <button
                type="button"
                className={`dist-row${isBucketActive(d) ? ' is-active' : ''}`}
                key={d.key}
                onClick={() => toggleDiffBucket(d)}
                title="点击按该难度区间筛选（再点一次取消）"
              >
                <span className="dist-row__label mono">{d.key}</span>
                <span className="dist-row__track">
                  <i style={{ width: `${(d.count / diffDistMax) * 100}%`, background: d.color }} />
                </span>
                <span className="dist-row__count mono">{d.count}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="panel-block">
          <div className="section-label">平台分布</div>
          <div className="dist-list">
            {platDist.map((p) => (
              <div className="dist-row" key={p.id}>
                <span className="dist-row__label">
                  <i className="platform-dot" style={{ background: PLATFORM_COLOR[p.id] }} />
                  {p.name}
                </span>
                <span className="dist-row__track">
                  <i
                    style={{
                      width: `${(p.count / platMax) * 100}%`,
                      background: PLATFORM_COLOR[p.id],
                      opacity: 0.75,
                    }}
                  />
                </span>
                <span className="dist-row__count mono">{p.count}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>

      <div className="workbench">
        {/* 左栏：标签分类 */}
        <aside className="taxonomy-panel">
          <div className="section-label">
            算法标签
            <span className="section-label-count">{facets?.total ?? total} 题</span>
          </div>
          <div className="taxonomy-list">
            <button
              type="button"
              className={`taxonomy-item${tagFilters.length === 0 ? ' is-active' : ''}`}
              onClick={() => setTagFilters([])}
            >
              <span className="taxonomy-item__marker" style={{ background: '#86a8ff' }} />
              <span className="taxonomy-item__name">全部标签</span>
              <span className="taxonomy-item__count">{facets?.total ?? total}</span>
            </button>
            {tagCounts.map(([t, n]) => (
              <button
                key={t}
                type="button"
                className={`taxonomy-item${tagFilters.includes(t) ? ' is-active' : ''}`}
                onClick={() => toggleSidebarTag(t)}
              >
                <span className="taxonomy-item__marker" style={{ background: tagColor(t) }} />
                <span className="taxonomy-item__name">{t}</span>
                <span className="taxonomy-item__count">{n}</span>
              </button>
            ))}
          </div>
          <div className="taxonomy-footer">点击标签加入筛选（再点一次取消），多选按「或」组合</div>
        </aside>

        {/* 中栏：题目工作区 */}
        <section className="problem-workspace">
          <div className="workspace-topline">
            <div>
              <span className="workspace-kicker">PROBLEM LIBRARY</span>
              <h2>
                {tagFilters.length === 0
                  ? '全部题目'
                  : tagFilters.length === 1
                    ? tagFilters[0]
                    : `已选 ${tagFilters.length} 个标签`}
              </h2>
            </div>
            <span className="result-count">
              共 <strong>{total}</strong> 题
            </span>
          </div>
          <div className="filter-row">
            <Select
              allowClear
              placeholder="平台"
              style={{ width: 120 }}
              value={platform}
              onChange={setPlatform}
              options={PLATFORMS.map((p) => ({ value: p.id, label: p.name }))}
            />
            <Input.Search
              allowClear
              placeholder="搜索题号 / 标题"
              style={{ width: 200 }}
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              onSearch={(v) => setQ(v || undefined)}
            />
            <Button icon={<ClearOutlined />} onClick={resetFilters}>
              重置
            </Button>
            <Checkbox checked={includeBank} onChange={(e) => setIncludeBank(e.target.checked)}>
              含题库未做题
            </Checkbox>
          </div>
          {/* 「过滤问题」面板（CF 风格）：难度区间 + 标签多选，点「应用」生效 */}
          <div className={`filter-panel${filterOpen ? ' is-open' : ''}`}>
            <button type="button" className="filter-panel__toggle" onClick={toggleFilterPanel}>
              <span className="filter-panel__arrow">→</span>
              过滤问题
              {activeFilterCount > 0 && <span className="filter-panel__badge">{activeFilterCount}</span>}
            </button>
            {filterOpen && (
              <div className="filter-panel__body">
                <div className="filter-panel__field">
                  <span className="filter-panel__label">难度:</span>
                  <InputNumber
                    size="small"
                    min={0}
                    max={4000}
                    placeholder="最低"
                    style={{ width: 90 }}
                    value={draftDiffMin}
                    onChange={(v) => setDraftDiffMin(v ?? undefined)}
                  />
                  <span className="filter-panel__dash">—</span>
                  <InputNumber
                    size="small"
                    min={0}
                    max={4000}
                    placeholder="最高"
                    style={{ width: 90 }}
                    value={draftDiffMax}
                    onChange={(v) => setDraftDiffMax(v ?? undefined)}
                  />
                </div>
                <div className="filter-panel__field">
                  <span className="filter-panel__label">标签:</span>
                  <Select
                    mode="multiple"
                    allowClear
                    showSearch
                    placeholder="选择标签（可多选）"
                    style={{ flex: 1, minWidth: 0 }}
                    value={draftTags}
                    onChange={setDraftTags}
                    options={tagCountEntries.map(([t]) => ({ value: t, label: t }))}
                  />
                </div>
                <div className="filter-panel__note">
                  *所选标签按逻辑「或」组合，同义标签自动归并（二分 ↔ binary search）；设置难度区间后未知难度的题不显示
                </div>
                <div className="filter-panel__actions">
                  <Button type="primary" size="small" onClick={applyPanelFilters}>
                    应用
                  </Button>
                  <Button size="small" onClick={clearPanelFilters}>
                    清除
                  </Button>
                </div>
              </div>
            )}
          </div>
          <div className="status-row">
            <div className="status-tabs">
              {STATUS_TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={statusFilter === t.key ? 'is-active' : ''}
                  onClick={() => setStatusFilter(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {(tagFilters.length > 0 || diffUnknown || diffMin != null || diffMax != null) && (
              <div className="status-chips">
                {tagFilters.map((t) => (
                  <Tag key={t} closable onClose={() => toggleSidebarTag(t)}>
                    {t}
                  </Tag>
                ))}
                {diffUnknown && (
                  <Tag closable onClose={() => setDiffUnknown(false)}>
                    难度未知
                  </Tag>
                )}
                {(diffMin != null || diffMax != null) && (
                  <Tag
                    closable
                    onClose={() => {
                      setDiffMin(undefined)
                      setDiffMax(undefined)
                    }}
                  >
                    {diffMin != null && diffMax != null
                      ? `难度 ${diffMin}–${diffMax}`
                      : diffMin != null
                        ? `难度 ≥ ${diffMin}`
                        : `难度 ≤ ${diffMax}`}
                  </Tag>
                )}
              </div>
            )}
          </div>
          <div className="problem-table">
            <Table
              rowKey="id"
              size="small"
              loading={loading}
              columns={cols}
              dataSource={rows}
              // 表头点击排序（受控 sortOrder）：onChange 里只处理排序，翻页仍走下面的 pagination.onChange
              onChange={onTableChange}
              // 固定列宽合计 850px；概览条已移到页顶不再占宽度，两栏布局下中栏
              // 一般足够 970px，更窄的窗口才出横向滚动条，操作列吸附右缘始终可见
              scroll={{ x: 970 }}
              // 服务端分页：当前页 50 行由后端过滤 + LIMIT 得出，前端不再持有全量数据
              pagination={{
                current: page,
                pageSize: PAGE_SIZE,
                total,
                showSizeChanger: false,
                showTotal: (t) => `共 ${t} 题`,
                onChange: (next) => load(next),
              }}
            />
          </div>
        </section>
      </div>

      <Modal title="导入刷题记录" open={importOpen} onCancel={() => setImportOpen(false)} footer={null} width={620}>
        <Tabs
          // 受控页签：把「弹窗打开 + 当前是平台同步页签」作为 SyncTab 的 active，
          // 打开弹窗/切回该页签时重新拉续拉状态（组件本身不随弹窗关闭卸载）
          activeKey={importTab}
          onChange={setImportTab}
          items={[
            {
              key: 'sync',
              label: '平台同步',
              children: (
                <SyncTab
                  active={importOpen && importTab === 'sync'}
                  onDone={() => { setImportOpen(false); loadRef.current() }}
                />
              ),
            },
            {
              key: 'bank',
              label: '拉取题库',
              children: <BankTab onDone={() => { setImportOpen(false); loadRef.current() }} />,
            },
            {
              key: 'file',
              label: '上传文件',
              children: (
                <div>
                  <p>选择平台后上传 JSON 数组或 CSV（表头：{['problemKey', 'title', 'verdict', 'difficulty', 'tags', 'url', 'submittedAt', 'language', 'externalId'].join(', ')}）。</p>
                  <Select placeholder="平台" style={{ width: 200, marginBottom: 12 }} value={platform} onChange={setPlatform} options={PLATFORMS.map((p) => ({ value: p.id, label: p.name }))} />
                  <Upload.Dragger {...uploadProps} multiple={false} showUploadList={false}>
                    <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                    <p className="ant-upload-text">点击或拖拽文件上传</p>
                  </Upload.Dragger>
                </div>
              ),
            },
            {
              key: 'form',
              label: '逐条录入',
              children: (
                <Form
                  form={manualForm}
                  layout="vertical"
                  onFinish={async (v) => {
                    try {
                      await post('/api/import/manual', {
                        platform: v.platform,
                        rows: [
                          {
                            problemKey: v.problemKey,
                            title: v.title,
                            verdict: v.verdict ?? 'AC',
                            difficulty: v.difficulty,
                            tags: v.tags ? String(v.tags).split('|').map((t) => t.trim()).filter(Boolean) : [],
                          },
                        ],
                      })
                      message.success('录入成功')
                      manualForm.resetFields()
                      setImportOpen(false)
                      loadRef.current()
                    } catch (e) {
                      message.error((e as Error).message)
                    }
                  }}
                >
                  <Form.Item name="platform" label="平台" rules={[{ required: true }]}>
                    <Select options={PLATFORMS.map((p) => ({ value: p.id, label: p.name }))} />
                  </Form.Item>
                  <Form.Item name="problemKey" label="题号（如 P1001 / 1919C）" rules={[{ required: true }]}>
                    <Input />
                  </Form.Item>
                  <Form.Item name="title" label="标题">
                    <Input />
                  </Form.Item>
                  <Form.Item name="verdict" label="结果" initialValue="AC">
                    <Select options={['AC', 'WA', 'TLE', 'RE', 'MLE', 'CE', 'SKIPPED'].map((v) => ({ value: v, label: v }))} />
                  </Form.Item>
                  <Form.Item name="difficulty" label="难度（数值）">
                    <InputNumber min={0} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name="tags" label="标签（| 分隔）">
                    <Input placeholder="dp|图论" />
                  </Form.Item>
                  <Button type="primary" htmlType="submit">提交</Button>
                </Form>
              ),
            },
          ]}
        />
      </Modal>

      {/* 知识点管线面板：覆盖率 + L1 批跑 + 抽检 */}
      <Modal title="知识点管线" open={pipelineOpen} onCancel={() => setPipelineOpen(false)} footer={null} width={660}>
        {coverage && (
          <div style={{ marginBottom: 12 }}>
            <Space wrap size={16}>
              <span>
                覆盖 <strong>{coverage.annotated}</strong> / {coverage.total} 题（{coverage.coverage.toFixed(1)}%）
              </span>
              <span>
                规则 {coverage.bySource.rule ?? 0} · 题源标签 {coverage.bySource.tag ?? 0} · 人工 {coverage.bySource.manual ?? 0}
              </span>
            </Space>
            <p style={{ margin: '8px 0 0', color: '#8993a2', fontSize: 12 }}>
              taxonomy v{coverage.taxonomyVersion} · pipeline v{coverage.pipelineVersion}
              {coverage.rulesVersion ? `（规则表 v${coverage.rulesVersion}）` : ''} · 统计阈值 {coverage.threshold}
              {coverage.lowConfidenceOnly > 0 ? ` · ${coverage.lowConfidenceOnly} 题仅有低置信标注` : ''}
            </p>
          </div>
        )}
        <Space wrap style={{ marginBottom: 12 }}>
          <Button type="primary" loading={pipelineBusy} onClick={() => void runPipeline({ mode: 'l1' })}>
            跑 L1 规则
          </Button>
          <Tooltip title="只重扫规则/体系版本过期、或标题已修复的标注，人工校正不受影响">
            <Button loading={pipelineBusy} onClick={() => void runPipeline({ mode: 'l1', rerun: true })}>
              版本差量重跑
            </Button>
          </Tooltip>
          <Tooltip title="随机抽 1% 已标注题生成核对清单，复核后在题目行内校正">
            <Button loading={pipelineBusy} onClick={() => void loadSample()}>
              生成抽检清单
            </Button>
          </Tooltip>
        </Space>
        <p style={{ color: '#8993a2', fontSize: 12 }}>
          AI 已退出清洗模块；未覆盖题目进入「词表缺口」报告，补齐 tags.ts 同义组是提升覆盖率的唯一手段。
          离线批跑可用 <span className="mono">npx tsx scripts/gen-knowledge.ts</span>。
        </p>
        {sample && (
          <div style={{ marginTop: 12 }}>
            <div style={{ marginBottom: 4, fontWeight: 600 }}>抽检清单（{sample.sampleSize} 题）</div>
            <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid #2a323d', borderRadius: 6, padding: 8 }}>
              {Object.entries(
                sample.items.reduce<Record<string, typeof sample.items>>((acc, it) => {
                  const k = `${it.platform}/${it.problemKey}`
                  ;(acc[k] ||= []).push(it)
                  return acc
                }, {}),
              ).map(([k, pts]) => (
                <div key={k} style={{ marginBottom: 6 }}>
                  <span className="mono" style={{ marginRight: 8 }}>{k}</span>
                  {pts.map((p) => (
                    <Tag key={p.code} style={{ marginBottom: 2 }}>
                      {p.name} {p.confidence.toFixed(2)}
                      <span style={{ opacity: 0.6 }}>（{p.source === 'rule' ? p.method : p.source}）</span>
                    </Tag>
                  ))}
                </div>
              ))}
            </div>
            <p style={{ color: '#8993a2', fontSize: 12, marginBottom: 0 }}>
              发现错标：关闭本面板，在题目列表对应行的「校正知识点」中修正（人工标注永久置顶）。
            </p>
          </div>
        )}
      </Modal>

      {/* 单题知识点人工校正（L3）：体系树多选，保存为 manual 永久置顶 */}
      <Modal
        title={kpEditRow ? `校正知识点：${kpEditRow.problem_key} ${kpEditRow.title}` : '校正知识点'}
        open={kpEditRow !== null}
        onCancel={() => setKpEditRow(null)}
        onOk={() => void saveKp()}
        confirmLoading={kpSaving}
        okText="保存为人工标注"
        width={560}
      >
        <p style={{ color: '#8993a2', fontSize: 12 }}>
          从知识点体系选择（可多选；清空保存 = 人工确认「无知识点」）。人工标注永久置顶，重跑管线不会覆盖。
        </p>
        <TreeSelect
          treeData={kpTree}
          value={kpCodes}
          onChange={(v) => setKpCodes(v as string[])}
          multiple
          treeDefaultExpandAll
          showSearch
          allowClear
          placeholder="选择知识点"
          style={{ width: '100%' }}
          maxTagCount={8}
          filterTreeNode={(input, node) => String(node?.title ?? '').toLowerCase().includes(input.toLowerCase())}
        />
      </Modal>

      {/* 手动填写难度：上游确实给不出难度的题（已删除 / 私有 / 洛谷「暂无评定」/ gym 官方 Unrated）
          由用户自行标定。服务端置 difficulty_source='manual'（优先级最高，回填与同步都不覆盖），
          并连带写同源原生值/标度、清掉「平台无公开难度」负缓存 */}
      <Modal
        title={diffEditRow ? `手动填写难度：${diffEditRow.problem_key} ${diffEditRow.title}` : '手动填写难度'}
        open={diffEditRow !== null}
        onCancel={() => setDiffEditRow(null)}
        onOk={() => void saveDiff(diffEditValue)}
        confirmLoading={diffSaving}
        okText="保存为手动难度"
        width={480}
      >
        <p style={{ color: '#8993a2', fontSize: 12, marginTop: 0 }}>
          CF rating 统一标尺（800–3500，步长 100）。手动值优先级最高：回填、同步与题库拉取都不会覆盖它，
          并会清掉「平台无公开难度」的记录。留空或点「清除」= 恢复「未知」，该题下次回填会重新查上游。
        </p>
        {diffEditRow && (
          <p style={{ fontSize: 12, margin: '0 0 12px' }}>
            库内现状：{diffEditRow.difficulty == null ? '难度未知' : `难度 ${diffEditRow.difficulty}`}
            {diffEditRow.difficultySource === 'manual' ? '（手动标定）' : ''}
            {diffEditRow.difficultyGap ? '；回填已确认上游未给该题评级' : ''}
            {diffEditRow.nativeDifficulty ? `；原生值 ${diffEditRow.nativeDifficulty}${diffEditRow.difficultyLabel ? `（${diffEditRow.difficultyLabel}）` : ''}` : ''}
          </p>
        )}
        <Space wrap style={{ marginBottom: 12 }}>
          <InputNumber
            min={800}
            max={3500}
            step={100}
            value={diffEditValue}
            onChange={(v) => setDiffEditValue(typeof v === 'number' ? v : null)}
            placeholder="如 1800"
            style={{ width: 140 }}
          />
          {[800, 1200, 1500, 1800, 2200, 2600, 3000].map((v) => (
            <Button key={v} size="small" onClick={() => setDiffEditValue(v)}>
              {v}
            </Button>
          ))}
        </Space>
        {diffEditRow?.difficulty != null && (
          <div>
            <Button
              danger
              type="text"
              size="small"
              loading={diffSaving}
              onClick={() => {
                const row = diffEditRow
                modal.confirm({
                  title: `清除 ${row.problem_key} 的难度？`,
                  content: '该题会恢复为「难度未知」，并在下次回填时重新查上游（手动标定随之丢失）。',
                  okText: '清除',
                  okButtonProps: { danger: true },
                  cancelText: '取消',
                  onOk: () => saveDiff(null),
                })
              }}
            >
              清除难度（恢复「未知」）
            </Button>
          </div>
        )}
      </Modal>

      {/* 回收站（issue #27 误删恢复）：列出带快照的墓碑，恢复仅重建题目行 */}
      <Modal
        title="回收站"
        open={trashOpen}
        onCancel={() => setTrashOpen(false)}
        footer={null}
        width={720}
      >
        <p style={{ color: '#8993a2', fontSize: 12 }}>
          恢复只按删除时刻的快照重建题目行；其提交、复习条目、卡点与人工知识点标注不会找回。
          题目行留在回收站不会污染统计，不恢复可放着不管。
        </p>
        <Table<DeletedRow>
          size="small"
          rowKey={(t) => `${t.platform}/${t.problem_key}`}
          dataSource={trash ?? []}
          pagination={false}
          scroll={{ y: 360 }}
          columns={[
            {
              title: '题目',
              render: (_v, t) => (
                <Space size={6}>
                  <PlatformTag id={t.platform as PlatformId} />
                  <span className="mono">{t.problem_key}</span>
                  <span style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.title ?? '（无快照）'}
                  </span>
                  {t.difficulty != null && (
                    <span className="rating-pill mono" style={{ color: difficultyColor(t.difficulty) }}>
                      {t.difficulty}
                    </span>
                  )}
                </Space>
              ),
            },
            {
              title: '删除时间',
              dataIndex: 'deleted_at',
              width: 150,
              render: (v: string) => <span style={{ fontSize: 12, color: '#8993a2' }}>{v}</span>,
            },
            {
              title: '操作',
              width: 80,
              render: (_v, t) => (
                <Button size="small" type="link" onClick={() => restoreProblem(t)}>
                  恢复
                </Button>
              ),
            },
          ]}
        />
      </Modal>
    </div>
  )
}

/** GET /api/sync/status 的平台条目（Task 8 起含 autoContinue：该平台待执行的后台续拉） */
interface SyncPlatformStatus {
  platform: PlatformId
  platformName: string
  handle: string
  enabled: boolean
  lastSyncAt: string | null
  status: string
  latestRun: unknown
  /** 后台续拉排期；无排期（未截断 / 已跑完 / 已取消 / 轮数设为 0）时为 null */
  autoContinue: {
    platform: PlatformId
    handle: string
    round: number
    maxRounds: number
    /** 下一轮预计开始时间（ISO 字符串） */
    nextAt: string
    running: boolean
  } | null
}

/** 续拉排期时间 → 界面用的 HH:MM（无法解析时原样回显，不显示 Invalid Date） */
function formatNextRunAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 续拉状态轮询间隔：续拉按平台节奏排期（秒级到分钟级），10 秒粒度足以看到轮次推进，请求极轻 */
const AUTO_CONTINUE_POLL_MS = 10_000

function SyncTab({ onDone, active = true }: { onDone: () => void; active?: boolean }) {
  const { message } = AntdApp.useApp()
  const [platform, setPlatform] = useState<PlatformId>('codeforces')
  const [handle, setHandle] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>()
  // 同步进度（全局共享的 /api/sync/progress 轮询）：本页只看当前所选平台那一行
  const { refresh: refreshProgress } = useSyncProgress()
  // 「上次同步结果」抽屉（最近 50 次同步明细，平台/模式/耗时/错误原因）
  const [historyOpen, setHistoryOpen] = useState(false)
  // 各平台后台续拉状态（GET /api/sync/status）：截断后服务端会自行分批续拉，这里给出进度与手动停止
  const [statuses, setStatuses] = useState<SyncPlatformStatus[]>([])
  const [cancelling, setCancelling] = useState<string>()

  const loadStatus = useCallback(() => {
    get<{ statuses: SyncPlatformStatus[] }>('/api/sync/status')
      .then((r) => setStatuses(r.statuses ?? []))
      .catch(() => { /* 服务端未升级时静默：仅影响续拉提示 */ })
  }, [])

  // 弹窗打开 / 切回本页签时重新拉取：本组件一旦挂载就不会随弹窗关闭而卸载
  // （Modal 无 destroyOnClose、Tabs 不销毁非活动面板），只在挂载时拉一次会让横幅
  // 永远停在旧轮次——续拉跑完/被取消后仍显示「后台续拉中，预计 HH:MM 继续」。
  useEffect(() => {
    if (active) loadStatus()
  }, [active, loadStatus])

  // Boolean(...)：旧版服务端整段没有 autoContinue 字段（undefined），不能被当成「有待续拉」而空转轮询
  const hasPending = statuses.some((s) => Boolean(s.autoContinue))

  // 有待续拉时轻量轮询，让轮次与预计时间自行推进（无需用户操作）；
  // 没有待续拉或页签不活跃时不保留任何定时器（自停轮询）。
  useEffect(() => {
    if (!active || !hasPending) return
    const timer = setInterval(loadStatus, AUTO_CONTINUE_POLL_MS)
    return () => clearInterval(timer)
  }, [active, hasPending, loadStatus])

  const run = async () => {
    if (!handle.trim()) return
    setBusy(true)
    setResult(undefined)
    // 立刻拉一次进度：点下去就看到「已用时 0 秒 · 正在建立连接」，而不是空白等待
    refreshProgress()
    try {
      const r = await post<{ imported: number; skipped: number; errors: string[]; truncated?: boolean; note?: string }>(`/api/sync/${platform}`, { handle: handle.trim() })
      const parts = [`导入 ${r.imported} 条`, `去重 ${r.skipped} 条`]
      if (r.errors.length) parts.push(`提示：${r.errors.join('；')}`)
      if (r.truncated && r.note) parts.push(r.note)
      setResult(parts.join('，'))
      if (r.imported > 0) onDone()
      // 本次若被分批上限截断，服务端已排下一次续拉：立刻刷新续拉提示
      loadStatus()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
      refreshProgress()
    }
  }

  const cancelAutoContinue = async (p: PlatformId) => {
    setCancelling(p)
    try {
      const r = await post<{ ok: boolean; cancelled: boolean }>('/api/sync/auto-continue/cancel', { platform: p })
      message.success(r.cancelled ? `${platformName(p)}后台续拉已停止` : `${platformName(p)}当前没有待执行的续拉`)
      loadStatus()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setCancelling(undefined)
    }
  }

  const pending = statuses.filter((s) => s.autoContinue)

  return (
    <div>
      <Space>
        <Select style={{ width: 140 }} value={platform} onChange={setPlatform} options={PLATFORMS.map((p) => ({ value: p.id, label: p.name }))} />
        <Input placeholder={platform === 'codeforces' ? 'CF handle' : '用户名 / uid'} value={handle} onChange={(e) => setHandle(e.target.value)} style={{ width: 200 }} />
        <Button type="primary" loading={busy} onClick={run}>同步</Button>
      </Space>
      {result && <p style={{ marginTop: 12 }}>{result}</p>}
      {/* 同步进行中：显示真实请求进度（已用时 / 已请求次数 / 最后一次请求距今），
          避免用户以为卡住而直接关掉应用 */}
      {busy && (
        <p style={{ marginTop: 12, marginBottom: 0 }}>
          <SyncProgressHint platform={platform} />
        </p>
      )}
      {pending.length > 0 && (        <div style={{ marginTop: 12 }}>
          {pending.map((s) => {
            const ac = s.autoContinue!
            return (
              <Alert
                key={s.platform}
                type="info"
                showIcon
                style={{ marginBottom: 8 }}
                // running 时服务端正在拉本轮，nextAt 尚未落到下一轮：此时不报「预计 HH:MM」（会显示成过去时间）
                message={
                  ac.running
                    ? `后台续拉中：第 ${ac.round}/${ac.maxRounds} 轮（正在拉取）`
                    : `后台续拉中：第 ${ac.round}/${ac.maxRounds} 轮，预计 ${formatNextRunAt(ac.nextAt)} 继续`
                }
                description={`${s.platformName}（${ac.handle}）：单次同步受分批上限截断后由后台自动续拉，可随时停止；停止不影响已导入的数据。`}
                action={
                  <Button size="small" loading={cancelling === s.platform} onClick={() => void cancelAutoContinue(s.platform)}>
                    停止续拉
                  </Button>
                }
              />
            )
          })}
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <a onClick={() => setHistoryOpen(true)} style={{ fontSize: 13 }}>
          <HistoryOutlined /> 上次同步结果（各平台最近 50 次）
        </a>
      </div>
      <SyncHistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </div>
  )
}

const LUOGU_DIFFICULTY_OPTIONS = [
  { value: 2, label: '普及- 及以上（含入门水题）' },
  { value: 3, label: '普及/提高- 及以上（推荐）' },
  { value: 4, label: '普及+/提高 及以上' },
  { value: 5, label: '提高+/省选- 及以上' },
  { value: 6, label: '省选/NOI- 及以上' },
]

/** 平台默认拉取条数：CF / AtCoder 单次 API 调用即可拿全量，LeetCode 全量约 3300 题、代码源约 500 题 */
function defaultBankMax(p: PlatformId): number {
  return p === 'codeforces' ? 10000 : p === 'leetcode' ? 3500 : p === 'atcoder' ? 5000 : 1000
}

/** 「拉取题库」页签：从公开题库批量入库，扩充训练计划待选题池（无需账号）。 */
function BankTab({ onDone }: { onDone: () => void }) {
  const { message } = AntdApp.useApp()
  // 平台列表来自共享定义的题库能力（PLATFORMS.hasBank），不硬编码：QOJ 无公开题库接口，故不在此提供
  const bankPlatforms = useMemo(() => PLATFORMS.filter((p) => p.hasBank), [])
  const [platform, setPlatform] = useState<PlatformId>('luogu')
  const [max, setMax] = useState(() => defaultBankMax('luogu'))
  const [luoguMin, setLuoguMin] = useState(3)
  // AtCoder：用洛谷 AT 镜像题补算法标签（默认关，覆盖有限）。仅该平台时随请求下发 atcoderTags
  const [atcoderTags, setAtcoderTags] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>()

  const switchPlatform = (v: PlatformId) => {
    setPlatform(v)
    setMax(defaultBankMax(v))
  }

  const run = async () => {
    setBusy(true)
    setResult(undefined)
    try {
      const r = await post<{
        ok: boolean; platform: string; total: number | null; fetched: number; inserted: number; updated: number
        tagScanned?: number; tagMatched?: number; tagWithTags?: number; tagSkipped?: number
      }>('/api/problems/bank', {
        platform,
        max,
        ...(platform === 'luogu' ? { luoguMinDifficulty: luoguMin } : {}),
        ...(platform === 'atcoder' && atcoderTags ? { atcoderTags: true } : {}),
      })
      const totalPart = r.total ? `（题库共 ${r.total} 题）` : ''
      // 标签桥统计只在真的开了桥时由服务端下发（未开时无这些键）
      const tagPart =
        r.tagScanned === undefined
          ? ''
          : `；洛谷镜像补标签：扫描 ${r.tagScanned} 题、命中题号 ${r.tagMatched ?? 0}、其中带标签 ${r.tagWithTags ?? 0}`
      setResult(`拉取 ${r.fetched} 题${totalPart}：新增 ${r.inserted}，更新 ${r.updated}${tagPart}`)
      message.success(`${platformName(platform)}题库已入库，训练计划选题池已扩充`)
      onDone()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <p style={{ color: '#8993a2' }}>
        软件已内置 Codeforces 等题库，开箱即可供训练计划/题单选题；需要更多题目时从这里扩充（无需账号/Cookie，不影响刷题统计）。
        Codeforces / AtCoder 一次调用秒级完成；洛谷/牛客/LeetCode/代码源按页拉取，拉取量越大耗时越长（约 1-2 分钟/千题）。
        列表只列有公开题库的平台（QOJ 无题库接口，故不提供拉取）。
      </p>
      <Space wrap>
        <Select
          style={{ width: 140 }}
          value={platform}
          onChange={switchPlatform}
          options={bankPlatforms.map((p) => ({ value: p.id, label: p.name }))}
        />
        <InputNumber
          min={50}
          max={platform === 'codeforces' ? 20000 : platform === 'atcoder' ? 10000 : 5000}
          step={platform === 'codeforces' || platform === 'atcoder' ? 500 : 50}
          value={max}
          onChange={(v) => setMax(v ?? 1000)}
          addonAfter="题"
          style={{ width: 140 }}
        />
        <Button type="primary" icon={<CloudDownloadOutlined />} loading={busy} onClick={run}>
          拉取题库
        </Button>
      </Space>
      {platform === 'luogu' && (
        <div style={{ marginTop: 12 }}>
          <Select
            style={{ width: 300 }}
            value={luoguMin}
            onChange={setLuoguMin}
            options={LUOGU_DIFFICULTY_OPTIONS}
          />
        </div>
      )}
      {platform === 'atcoder' && (
        <div style={{ marginTop: 12 }}>
          <Space>
            <Switch checked={atcoderTags} onChange={setAtcoderTags} />
            <span style={{ color: '#8993a2' }}>
              用洛谷镜像补标签（默认关；覆盖有限：实测 250 行样本中 139 行命中题号、仅 68 行真的带标签，
              结果里的命中计数如实回传）
            </span>
          </Space>
        </div>
      )}
      {result && <p style={{ marginTop: 12 }}>{result}</p>}
      <BackfillDifficultyCard />
    </div>
  )
}

/** 「拉取题库」页签内的难度回填区块：对库内未知难度/未知原生难度/缺标签的题跨平台查询公开接口补全。 */
function BackfillDifficultyCard() {
  const { message } = AntdApp.useApp()
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [result, setResult] = useState<string>()
  /** 服务端运行状态：刷新 / 换个标签页回来时，据此继续显示「回填进行中 N/M」并给出停止入口 */
  const [run, setRun] = useState<BackfillRunStatus | null>(null)
  /**
   * 强制重查：无视「平台无公开难度」的负缓存，并把洛谷「仅缺原生值」的行也逐题重查一遍。
   * 真实用途：① 平台刚补了评级/标签而 TTL 未到，想立刻拿到；② 想把洛谷题的原生档位原文补齐。
   * （题号形态修复前被误锁的 AtCoder 旧定论已由启动迁移一次性作废，不需要用户点这个。）
   * 代价是这一轮耗时明显变长（洛谷 ≥4 秒/题），故默认关闭。
   */
  const [force, setForce] = useState(false)

  const nameOf = (p: string): string => platformName(p as PlatformId)

  const refreshRun = useCallback(async () => {
    try {
      const r = await get<{ ok: boolean; run: BackfillRunStatus }>('/api/problems/backfill-difficulty/run')
      setRun(r.run)
    } catch {
      /* 状态接口失败不影响回填本身：保持上一次的按钮语义，不误报「没在跑」 */
    }
  }, [])

  // 挂载先问一次：回填由**服务端**跑（关页面/刷新都不会停），本页可能只是重新打开
  useEffect(() => {
    void refreshRun()
  }, [refreshRun])

  // 运行中每 2s 刷新进度；未运行时不挂定时器
  const active = busy || run?.running === true
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      void refreshRun()
    }, 2000)
    return () => clearInterval(timer)
  }, [active, refreshRun])

  const runBackfill = async () => {
    setBusy(true)
    setResult(undefined)
    setStopping(false)
    try {
      const r = await post<BackfillResponse>('/api/problems/backfill-difficulty', {
        ...(force ? { includeNativeOnly: true } : {}),
      })
      setResult(resultText(r, nameOf))
      message.success(r.stopped ? '已停止回填（已落库的不受影响，再点一次继续）' : '难度回填完成')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
      setStopping(false)
      void refreshRun()
    }
  }

  /**
   * 停止 = 让**服务端**中止（在途上游请求被立即打断、已提交的批次留在库里）。
   * 只 abort 本页的 fetch 是做不到的：服务端的循环会照旧跑完并把结果写完。
   */
  const stopBackfill = async () => {
    setStopping(true)
    try {
      const r = await post<{ ok: boolean; stopped: boolean }>('/api/problems/backfill-difficulty/stop', {})
      if (!r.stopped) {
        message.info('当前没有正在运行的回填')
        setStopping(false)
      }
    } catch (e) {
      message.error((e as Error).message)
      setStopping(false)
    }
  }

  const running = busy || run?.running === true
  const progress = progressText(run, nameOf)

  return (
    <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid #222831' }}>
      <p style={{ color: '#8993a2' }}>
        补全库内「未知难度 / 未知原生难度 / 缺标签」的题，覆盖所有平台：整表型平台
        （Codeforces / AtCoder / 力扣 / 计蒜客 / 代码源）先拉一次题库表再在本地比对；
        洛谷与牛客按题查题目页（牛客只在待补题上千时才改拉整表）。所有请求都走<b>全局按域名限速</b>：洛谷 ≥4 秒/题、
        牛客 ≥2 秒/题、AtCoder ≥2.5 秒、Codeforces ≥2 秒、力扣 / 计蒜客 / 代码源 ≥1.5 秒
        —— 这是<b>最快端</b>（洛谷逐题上限 400 题 ≈30 分钟、牛客每道题 ≈2 秒，
        两者排在最后，整轮通常几分钟到三十分钟，取决于还剩多少真缺口）；想更稳可到「设置 → 拉取速度」把倍率调到 2×–5×。
        连续失败会判定为风控并中止该平台。
        <b>随时可以点「停止回填」</b>：在途请求立即中断，<b>已落库的题不受影响</b>，
        再点一次「一键回填」就从库里剩下的缺口继续（可反复分多次补完）；停止期间页面刷新也不会
        丢掉进度 —— 重新打开仍会显示「正在处理 平台 N/M」和停止按钮。
        <b>平台按实测成本升序处理</b>：QOJ（约 18 秒）、AtCoder、代码源、Codeforces 先完成，
        牛客垫底 —— 因此中途停止时，前面的成果已经落库。
        回填按缺口优先级执行：<b>真缺难度</b>最优先，其次缺标签，最后才是「难度已有、只缺原生原文」；
        后一类只在洛谷默认跳过（结果里显示「跳过 N 题」），因此一次点击就能把真缺口补完。
        牛客同时修复历史遗留的标题混入标签问题。QOJ 的难度由 ICPC/CCPC 公开榜单
        （RankLand + xcpcrating 题号映射）推导档位，不在审核目录内的题仍保持未知。
        Codeforces 的 gym 与官方未评级比赛、牛客站上难度格为空的题<b>确实没有公开难度</b>：
        回填问过上游后会记下这个结论（列表里显示「无官方难度」而不是横杠），
        <b>一个月内不再对这些题重复发请求</b>，到期再自动重查一次（平台后来给出评级就会被采纳）。
        已删除 / 私有的题（洛谷 T 号题那类）上游明确拒绝（401/403），同样记成「无公开来源」不再重打；
        这类题与 gym 一样，唯一的出路是在<b>难度格上点击手动填写</b>（手动值优先级最高，回填不会覆盖）。
        平台后来补了评级/标签而负缓存还没到期时，勾选下面的<b>强制重查</b>再点一次，
        本轮就会无视这些缓存、重新问上游。
      </p>
      <Space>
        <Button loading={busy} disabled={stopping || run?.running === true} onClick={runBackfill}>
          一键回填未知难度
        </Button>
        <Button danger loading={stopping} disabled={!running} onClick={stopBackfill}>
          停止回填
        </Button>
      </Space>
      <div style={{ marginTop: 8 }}>
        <Checkbox checked={force} onChange={(e) => setForce(e.target.checked)} disabled={running}>
          强制重查（无视「平台无公开难度」的结论，并补洛谷的「仅缺原生值」行 —— 这一轮会明显更慢）
        </Checkbox>
      </div>
      {progress && <p style={{ marginTop: 12, color: '#8993a2' }}>{progress}</p>}
      {result && <p style={{ marginTop: 12 }}>{result}</p>}
    </div>
  )
}
