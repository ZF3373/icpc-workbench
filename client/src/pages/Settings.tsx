import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { ComponentProps, CSSProperties, Ref } from 'react'
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Collapse,
  DatePicker,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Popover,
  Row,
  Col,
  Select,
  Segmented,
  Slider,
  Space,
  Spin,
  Switch,
  Tag,
  TimePicker,
  Upload,
  App as AntdApp,
} from 'antd'
import { ApiOutlined, DeleteOutlined, ImportOutlined, PlusOutlined, RobotOutlined, UploadOutlined, UserOutlined, BellOutlined, FileMarkdownOutlined, LinkOutlined, DatabaseOutlined, SearchOutlined } from '@ant-design/icons'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import type { PlatformId } from '../../../shared/src/index.ts'
import { PLATFORMS, cookieFieldsOf } from '../../../shared/src/index.ts'
import PageHeader from '../components/PageHeader'
import PageSkeleton from '../components/PageSkeleton'
import InlineError from '../components/InlineError'
import { BP, useMediaQuery } from '../useMediaQuery'
import { saveUrlAsFile } from '../download'
import PlatformTag from '../components/PlatformTag'
import { del, get, post } from '../api'
import { buildCookieItem, extractCookieValue } from '../cookies'
import { pct } from '../ui'
import { relativeTimeText } from '../syncStatus'
import { openExternal } from '../externalLinks'
import { useTheme, type ThemePreference } from '../themeContext'
import type { KnowledgeCompareReport, KnowledgeCoverage } from '../../../shared/src/index.ts'
import type { ContestReminderConfig, ReminderConfig } from '../types'

interface SettingsData {
  ai: { enabled: boolean; baseURL: string; apiKey: string; model: string; timeoutMs?: number; maxTokens?: number; contextWindow?: number; searchEngine?: 'tavily' | 'brave'; searchApiKey?: string; hasApiKey?: boolean; hasSearchApiKey?: boolean; apiKeyMasked?: string; searchApiKeyMasked?: string }
  accounts: Array<{ platform: PlatformId; handle: string; last_sync_at: string | null; enabled: number }>
  adapterEnabled: Record<string, boolean>
  platforms: typeof PLATFORMS
  cookies: Record<string, { configured: boolean; masked?: string; hasUa?: boolean }>
  /** 账号级凭据（多账号）：platform → handle → 该账号已保存的逐对打码 Cookie 头；
   *  键缺失 = 该账号未单独配置（同步回退平台级）。旧版服务端无此字段。 */
  accountCreds?: Record<string, Record<string, { configured: boolean; masked: string }>>
  reminder: ReminderConfig
  contestReminder: ContestReminderConfig
  sync: {
    maxSubmissions: number
    autoContinueRounds?: number
    jisuankePracticeSync?: boolean
    /** 拉取速度全局倍率（1 = 安全下限/最快）；旧版服务端无此字段时可空 */
    requestIntervalScale?: number
    /** 各平台 1× 基准间隔（毫秒）；前端按 基准 × 倍率 实时换算每个平台的秒数 */
    requestIntervalBase?: Record<string, number>
  }
}

const SYNC_NOTE_COLOR: Record<string, string> = {
  auto: 'success',
  cookie: 'processing',
  manual: 'default',
}

/** 账号小卡片「新增账号」模式下凭据草稿的固定键（真实草稿键 = 已绑定账号的 handle） */
const NEW_DRAFT_KEY = '__new__'

/**
 * 设置页分区锚点（P4-1）：**顺序 = 页面 DOM 顺序**，id 同时用作卡片容器的 id、导航项 value
 * 与搜索索引的 sectionId。这里只描述「有哪些分区」，不搬动任何卡片 DOM。
 * 说明：本页没有「关于 / 版本信息」内容（版本号在侧边栏 logo 下），故导航里不含该分区；
 * 「同步」相关设置物理上位于「平台账号与适配器」卡片内部，其锚点是卡片内的一个包裹 div。
 */
const SETTINGS_SECTIONS: Array<{ id: string; label: string }> = [
  { id: 'settings-ai', label: 'AI' },
  { id: 'settings-accounts', label: '账号与平台' },
  { id: 'settings-sync', label: '同步' },
  { id: 'settings-reminder', label: '提醒' },
  { id: 'settings-data', label: '数据' },
]

/** sectionId → 导航标签（搜索结果里显示「所属分区」） */
const SECTION_LABEL: Record<string, string> = Object.fromEntries(
  SETTINGS_SECTIONS.map((s) => [s.id, s.label]),
)

/**
 * 设置项索引（P4-2）：手工维护，不做 DOM 文本抓取（说明文字/表格内容不该被当成设置项）。
 * keywords 写中文 + 英文别名 + 常见口语说法，空格分隔，命中规则 = 全部关键词都能在
 * 「label + keywords + 分区名」里找到（子串、忽略大小写）。新增设置项时同步补一条。
 */
const SETTINGS_INDEX: Array<{ sectionId: string; label: string; keywords: string }> = [
  // ---- AI ----
  { sectionId: 'settings-ai', label: '启用 AI 生成', keywords: 'ai enable 开关 assistant 助手 生成' },
  { sectionId: 'settings-ai', label: 'Base URL', keywords: 'baseurl 接口地址 endpoint api 地址 openai 兼容 服务地址' },
  { sectionId: 'settings-ai', label: 'API Key', keywords: 'apikey key 密钥 token 令牌 deepseek 鉴权 sk' },
  { sectionId: 'settings-ai', label: '模型', keywords: 'model 模型名 切换模型 获取可用模型 gpt qwen deepseek-chat' },
  { sectionId: 'settings-ai', label: '对话超时', keywords: 'timeout 超时 秒 等待 响应慢 超时时间' },
  { sectionId: 'settings-ai', label: '最大输出', keywords: 'maxtokens 最大输出 输出长度 回复长度 token 上限' },
  { sectionId: 'settings-ai', label: '模型上下文长度', keywords: 'contextwindow 上下文 上下文长度 window 裁剪 历史' },
  { sectionId: 'settings-ai', label: '联网搜索', keywords: 'websearch 联网 搜索 搜索开关 互联网 function calling' },
  { sectionId: 'settings-ai', label: '搜索引擎', keywords: 'search engine tavily brave 搜索服务 引擎' },
  { sectionId: 'settings-ai', label: '搜索 API Key', keywords: 'searchapikey tavily brave 搜索密钥 搜索 key' },
  { sectionId: 'settings-ai', label: '测试连接 / 保存 AI 配置', keywords: 'test 测试 连接 检测 保存 ai 配置 可用性' },
  // ---- 账号与平台 ----
  { sectionId: 'settings-accounts', label: '平台账号（绑定 / 添加账号）', keywords: 'account handle 账号 绑定账号 添加账号 用户名 uid 多账号 平台' },
  { sectionId: 'settings-accounts', label: 'Cookie 凭据', keywords: 'cookie 凭据 credential 登录态 复制 粘贴 有效期 session' },
  { sectionId: 'settings-accounts', label: '凭据检测（是否有效 / 过期）', keywords: 'check 检测 凭据 有效 无效 过期 登录状态 连接状态' },
  { sectionId: 'settings-accounts', label: '浏览器 User-Agent', keywords: 'ua useragent 浏览器 标识 qoj 共用' },
  { sectionId: 'settings-accounts', label: '账号改名', keywords: 'rename 改名 重命名 handle 迁移 提交记录' },
  { sectionId: 'settings-accounts', label: '删除账号', keywords: 'delete remove 删除 解绑 账号 恢复点' },
  { sectionId: 'settings-accounts', label: '平台自动同步开关（适配器）', keywords: 'adapter 适配器 自动同步 enable 平台开关 启停' },
  { sectionId: 'settings-accounts', label: '参与同步（账号启停）', keywords: 'enabled 停用 启用 参与同步 账号开关 不参与' },
  // ---- 同步 ----
  { sectionId: 'settings-sync', label: '单次同步上限', keywords: 'maxsubmissions 同步上限 单次 条数 分批 拉取 风控' },
  { sectionId: 'settings-sync', label: '后台续拉轮数', keywords: 'autocontinuerounds 续拉 轮数 rounds 断点续拉 后台 关闭' },
  { sectionId: 'settings-sync', label: '拉取速度（请求间隔倍率）', keywords: 'requestintervalscale 拉取速度 速度 倍率 间隔 interval 节流 风控 慢' },
  { sectionId: 'settings-sync', label: '计蒜客同步自由练题提交', keywords: 'jisuanke 计蒜客 practice 自由练 练题 提交 同步范围' },
  // ---- 提醒 ----
  { sectionId: 'settings-reminder', label: '每日提醒开关', keywords: 'reminder 打卡提醒 daily 每日 提醒 开关' },
  { sectionId: 'settings-reminder', label: '提醒时间', keywords: 'time 时间 hh:mm 提醒时间 几点 打卡时间' },
  { sectionId: 'settings-reminder', label: '赛前提醒', keywords: 'contest 比赛 赛前 提醒 reminder 开赛 赛事' },
  { sectionId: 'settings-reminder', label: '提前提醒分钟数', keywords: 'minutesbefore 提前 分钟 提前量 赛前 分钟数' },
  { sectionId: 'settings-reminder', label: '系统通知权限', keywords: 'notification 系统通知 通知 授权 权限 浏览器通知' },
  // ---- 数据 ----
  { sectionId: 'settings-data', label: '导出提示词 .md', keywords: 'export 导出 提示词 prompt markdown 下载 天数 ai 计划' },
  { sectionId: 'settings-data', label: '导出练习数据汇总', keywords: 'export summary 汇总 练习数据 导出 下载 md' },
  { sectionId: 'settings-data', label: '导入 AI 计划', keywords: 'import 导入 plan 计划 json 粘贴 上传 训练计划' },
  { sectionId: 'settings-data', label: '知识点管线统计置信度阈值', keywords: 'knowledge 知识点 阈值 threshold 置信度 覆盖率 管线' },
  { sectionId: 'settings-data', label: '双口径对比（tag vs 知识点）', keywords: 'compare 对比 口径 tag 知识点 弱项 未覆盖' },
  { sectionId: 'settings-data', label: '备份与恢复点', keywords: 'backup 备份 恢复点 restore 恢复 数据 回滚 快照 数据库' },
  { sectionId: 'settings-data', label: '立即备份', keywords: 'backup 立即备份 手动 创建恢复点 now' },
  { sectionId: 'settings-data', label: '恢复备份（重启生效）', keywords: 'restore 恢复 回滚 重启 备份 生效' },
  { sectionId: 'settings-data', label: '删除恢复点', keywords: 'delete 删除 清理 备份文件 快照 磁盘' },
]

// 凭据字段表**只有一份**：shared/src/credentials.ts 的 COOKIE_FIELDS。
// 这里（以及任何客户端文件）不得再定义本地字段表——历史缺陷：字段表上移 shared 后
// 设置页残留一份旧表（QOJ 仍是 session/clearance/ua 三字段），保存时发出已废弃的
// `session`，被服务端按共享表校验拒绝（400 未知 Cookie 字段: session），保存按钮失效，
// 且表单渲染出与说明文字口径矛盾的输入框。守卫见 client/test/credentialsTable.test.ts。


export default function Settings() {
  const { message, modal } = AntdApp.useApp()
  const { preference, setPreference } = useTheme()
  const [data, setData] = useState<SettingsData | null>(null)
  /**
   * ≥1280px：分区导航放左侧竖排（P3）。断点走 JS 而不是纯 CSS，是因为 Segmented 的
   * 横/竖是 antd 的 DOM 结构差异（竖排有独立的滑动指示块），CSS 改不动。
   * DOM 仍只有一份，不产生重复 Tab 停靠点。
   */
  const wideNav = useMediaQuery(BP.xlUp)
  /**
   * 首屏取数状态。旧实现只看 `data`：请求失败时 data 永远是 null，
   * 页面就停在那个整页 Spin 上**一直转**——用户既不知道失败了，也没有重试入口。
   * 现在区分「加载中」与「加载失败」，失败给 InlineError + 重试。
   */
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** AI 配置表单实例：表单本身在 <AiSettingsCard> 内创建（见该组件注释，H2 治告警），
   *  这里只持有句柄做「保存前校验 / 取字段值 / 测试连接 / 拉模型」 */
  const aiForm = useRef<AiSettingsCardHandle>(null)
  /** 取 AI 表单句柄；本页走到这里必然已渲染过卡片（首屏 data 未到时会早退渲染骨架） */
  const aiFormHandle = (): AiSettingsCardHandle => {
    if (!aiForm.current) throw new Error('AI 配置表单尚未挂载')
    return aiForm.current
  }
  /** Cookie 密码框的小眼睛是否处于「显示」态（key = platform::draftKey::fieldKey）。
   *  受控是为了在点「显示」瞬间按需拉取该字段的原文——原文平时不下发前端 */
  const [credShown, setCredShown] = useState<Record<string, boolean>>({})
  /** 账号小卡片的凭据草稿（多账号）：platform → 草稿键（已绑定账号的 handle / NEW_DRAFT_KEY）→ 字段值。
   *  只提交 dirty 字段；同步时各账号只用自己卡片里配置的 Cookie（无平台级回退） */
  const [acctInputs, setAcctInputs] = useState<Record<string, Record<string, Record<string, string>>>>({})
  const [acctDirty, setAcctDirty] = useState<Record<string, Record<string, Set<string>>>>({})
  /** 账号小卡片（多账号）：当前打开的编辑目标；handle=null = 新增账号。
   *  凭据草稿按「原始 handle」（新增用 NEW_DRAFT_KEY）键存，改名不丢已填内容 */
  const [acctEditor, setAcctEditor] = useState<{ platform: PlatformId; handle: string | null } | null>(null)
  const [draftHandle, setDraftHandle] = useState('')
  /** 各账号生效凭据的检测结果（platform → handle → 结果） */
  const [acctCheck, setAcctCheck] = useState<Record<string, Record<string, { ok: boolean; message: string } | 'checking'>>>({})
  const [reminderEnabled, setReminderEnabled] = useState(false)
  const [reminderTime, setReminderTime] = useState<Dayjs>(dayjs('20:00', 'HH:mm'))
  const [contestReminder, setContestReminder] = useState<ContestReminderConfig>({ enabled: false, minutesBefore: 30 })
  const [importOpen, setImportOpen] = useState(false)
  const [exportDays, setExportDays] = useState(14)
  const [aiTesting, setAiTesting] = useState(false)
  const [aiTestResult, setAiTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelOptions, setModelOptions] = useState<{ value: string }[]>([])
  const [syncMax, setSyncMax] = useState<number | null>(500)
  /** 后台续拉轮数上限（0 = 关闭；服务端默认 3）；字段可能来自旧版服务端，故可空 */
  const [syncRounds, setSyncRounds] = useState<number | null>(6)
  /** 计蒜客「同步自由练题提交」开关（键缺失 = 默认开启） */
  const [practiceSync, setPracticeSync] = useState(true)
  /** 拉取速度全局倍率（1× = 安全下限/最快，越大越慢越稳）；拖动滑块即时预览，松手才落库 */
  const [syncScale, setSyncScale] = useState(1)
  /** 备份列表刷新信号：删号等动作会在服务端新建恢复点，通知 BackupCard 重新拉取，
   *  否则列表停留在页面加载时的快照——陈旧列表容易让人对着过期的行做删除/恢复（历史踩坑） */
  const [backupRefresh, setBackupRefresh] = useState(0)
  /** 各平台 1× 基准间隔（毫秒），由服务端下发；用于实时显示「当前倍率下每次请求间隔」 */
  const [intervalBase, setIntervalBase] = useState<Record<string, number>>({})
  /** 服务端当前已落库的倍率（用于去重提交与失败回滚基准） */
  const savedScale = useRef<number>(1)
  /** onChange 防抖补提交的定时器：rc-slider 只在 document 监听 mouseup（无指针捕获），
   *  鼠标在浏览器窗口外松开时 onChangeComplete 丢失、拖到的值不落库——用防抖兜底。 */
  const scaleSaveTimer = useRef<number | null>(null)
  /** 服务端已落库的同步上限/续拉轮数：数字框失焦/回车提交，清空（null）时用它恢复显示而不是误存 */
  const savedSyncMax = useRef(300)
  const savedSyncRounds = useRef(3)
  /**
   * 数字输入/开关的提交中状态（§6.4 / P4-3）。
   * 开关点击后到服务端回应之间若没有任何反馈，用户会以为没生效而反复点 ——
   * antd 的 Switch/InputNumber 都支持 loading，这里统一按 key 记录。
   * key 形如 `max` / `rounds` / `practice` / `reminder` / `adapter:<platform>` / `account:<platform>:<handle>`。
   */
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set())
  const withPending = async (key: string, fn: () => Promise<void>) => {
    setPendingKeys((s) => new Set(s).add(key))
    try {
      await fn()
    } finally {
      setPendingKeys((s) => {
        const next = new Set(s)
        next.delete(key)
        return next
      })
    }
  }
  const isPending = (key: string) => pendingKeys.has(key)
  /** 数字输入的提交中状态（各自一个 loading，避免两个框互相闪烁） */
  const [syncSaving, setSyncSaving] = useState({ max: false, rounds: false })

  const load = () => {
    setLoading(true)
    get<SettingsData>('/api/settings')
      .then((d) => {
        setData(d)
        setLoadError(null)
        // ⚠ 这里不再手动 setFieldsValue：AI 配置表单是子组件（AiSettingsCard），
        // 它在自己的 useEffect 里跟随 `ai` 变化同步服务端值——表单尚未挂载时也安全。
        // ⚠ 刷新不得清空 cookieInputs / dirtyFields / acctInputs / acctDirty：它们是用户正在编辑的
        // 半成品输入，任何一处保存/开关/绑定成功后的 load()（本页有 10+ 处调用）都不能把
        // 其他输入一并清掉——历史缺陷：点「添加账号」或「保存」都会把所有平台正在填写的
        // 值清空，两个按钮表现完全相同，用户无法分辨各自管哪块。
        // 输入的清空只发生在对应动作成功后的局部 setState（账号卡片保存清本账号草稿，
        // saveCookie/clearCookie 清本平台 Cookie 且连同 dirty 一起清），由此保持不变式
        // 「dirty ⇒ 输入框里有可见值」，不会把空串当「显式清除」提交而静默删掉已存凭据。
        setReminderEnabled(d.reminder.enabled)
        setReminderTime(dayjs(d.reminder.time, 'HH:mm'))
        setContestReminder(d.contestReminder)
        setSyncMax(d.sync?.maxSubmissions ?? 300)
        setSyncRounds(d.sync?.autoContinueRounds ?? 3)
        savedSyncMax.current = d.sync?.maxSubmissions ?? 300
        savedSyncRounds.current = d.sync?.autoContinueRounds ?? 3
        setPracticeSync(d.sync?.jisuankePracticeSync !== false)
        setSyncScale(d.sync?.requestIntervalScale ?? 1)
        savedScale.current = d.sync?.requestIntervalScale ?? 1
        setIntervalBase(d.sync?.requestIntervalBase ?? {})
      })
      .catch((e: Error) => {
        // 记下原因给首屏 InlineError（带重试）；toast 保留，是因为保存后的局部刷新失败时
        // 页面上已有数据、不会走 InlineError 分支，只有 toast 能说明「刚才那次保存后没刷新成功」
        setLoadError(e.message)
        message.error(e.message)
      })
      .finally(() => setLoading(false))
  }

  // 只在挂载时取一次；load 是每次渲染重建的闭包，放进依赖会因为 message 等不稳定引用反复触发
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [])

  // 进入设置页时自动检测每个「已配置凭据账号」的登录态，驱动平台连接状态点与账号框状态点。
  // 只对有凭据槽位且尚未检测过的账号触发，未配置凭据的账号不请求（点了账号框才检测）。
  useEffect(() => {
    if (!data) return
    for (const p of data.platforms) {
      if (p.sync !== 'cookie') continue
      for (const a of data.accounts.filter((x) => x.platform === p.id)) {
        if (acctCheck[p.id]?.[a.handle] !== undefined) continue
        if (!data.accountCreds?.[p.id]?.[a.handle]) continue
        void checkAccountCreds(p.id, a.handle)
      }
    }
    // checkAccountCreds 闭包随渲染刷新，此处只需在 data 变化（加载完成）时驱动一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  /* ============================================================
     设置页分区导航（P4-1）+ 设置项搜索（P4-2）
     只加「吸顶导航条 + 分区锚点 id + 临时高亮环」，卡片的 DOM 顺序、
     全部表单状态与提交逻辑保持不变（不搬进 Tabs，避免整页重渲染）。
     ============================================================ */

  /** 当前高亮的分区（默认第一个） */
  const [activeSection, setActiveSection] = useState(SETTINGS_SECTIONS[0].id)
  /** 设置项搜索关键词（非空时在导航条右侧输入框下方浮出命中列表） */
  const [navQuery, setNavQuery] = useState('')
  /** 搜索命中 / 点击导航后短暂高亮的分区 id（约 1.5s 后清除） */
  const [flashSection, setFlashSection] = useState<string | null>(null)
  /** 程序化平滑滚动进行中：暂停滚动高亮，避免滚动途中经过的分区抢走高亮态 */
  const navJumping = useRef(false)
  const flashTimer = useRef<number | null>(null)
  const jumpTimer = useRef<number | null>(null)

  /** 分区容器锚点样式：scroll-margin-top = 吸顶条高度（64px），命中时叠加高亮环 */
  const sectionAnchor = (id: string): CSSProperties => ({
    scrollMarginTop: 64,
    borderRadius: 12,
    transition: 'box-shadow 200ms ease',
    boxShadow: flashSection === id ? '0 0 0 2px var(--brand), 0 0 0 6px var(--brand-soft)' : undefined,
  })

  /** 点击导航项 / 搜索命中项：平滑滚动到分区 + 1.5s 高亮；滚动期间不改写导航态 */
  const jumpToSection = (id: string) => {
    const el = document.getElementById(id)
    if (!el) return
    navJumping.current = true
    if (jumpTimer.current !== null) window.clearTimeout(jumpTimer.current)
    jumpTimer.current = window.setTimeout(() => {
      navJumping.current = false
      jumpTimer.current = null
    }, 900)
    setActiveSection(id)
    setFlashSection(id)
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => {
      setFlashSection(null)
      flashTimer.current = null
    }, 1500)
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // 分区高亮：IntersectionObserver（rootMargin -64px 0px -70% 0px）负责分区进出吸顶条
  // 下方可视带；因为卡片往往比这条带子高，「分区顶边越过吸顶条」这一刻不会产生 IO 回调，
  // 故再挂一个被动滚动监听补上这一时刻。两者调用同一个判定函数，杜绝两套口径打架。
  useEffect(() => {
    if (!data) return
    const marker = 72 // 吸顶条高度 64px + 余量：落在可视带内
    /** 「已越过吸顶条且仍有可见部分」的分区里取最靠下的一个（同高并列时取 DOM 靠前者，
     *  并优先保持当前高亮，避免 lg 双列 / 嵌套锚点来回跳）；都没有则取第一个可见分区 */
    const compute = (cur: string): string | null => {
      const passed: Array<{ id: string; top: number }> = []
      let firstVisible: string | null = null
      for (const s of SETTINGS_SECTIONS) {
        const el = document.getElementById(s.id)
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (r.bottom <= marker || r.top >= window.innerHeight) continue
        if (firstVisible === null) firstVisible = s.id
        if (r.top <= marker) passed.push({ id: s.id, top: r.top })
      }
      if (passed.length === 0) return firstVisible
      let best = passed[0]
      for (const c of passed) if (c.top > best.top) best = c
      const keep = passed.find((c) => c.id === cur && c.top >= best.top - 4)
      return (keep ?? best).id
    }
    const sync = () => {
      if (navJumping.current) return
      // 用函数式更新：结果不变时 React 直接 bail out，不产生多余渲染
      setActiveSection((cur) => {
        const id = compute(cur)
        return id && id !== cur ? id : cur
      })
    }
    let raf = 0
    const schedule = () => {
      if (raf) return
      raf = window.requestAnimationFrame(() => {
        raf = 0
        sync()
      })
    }
    const observer = new IntersectionObserver(schedule, { rootMargin: '-64px 0px -70% 0px' })
    for (const s of SETTINGS_SECTIONS) {
      const el = document.getElementById(s.id)
      if (el) observer.observe(el)
    }
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    sync()
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (raf) window.cancelAnimationFrame(raf)
    }
  }, [data])

  // 卸载时清掉临时高亮 / 跳转 / 防抖定时器，避免设置页卸载后仍触发 setState 或打到已卸载组件
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
      if (jumpTimer.current !== null) window.clearTimeout(jumpTimer.current)
      if (scaleSaveTimer.current !== null) window.clearTimeout(scaleSaveTimer.current)
    },
    [],
  )

  if (!data) {
    // 骨架屏占住「页头 + 分区导航 + 表单卡」的结构：旧实现是整页居中 Spin，从转圈跳到满屏表单时位移明显
    return loadError ? (
      <InlineError
        message={loadError}
        hint="设置项没能取回来。已保存的配置不受影响，重试即可。"
        onRetry={load}
        retrying={loading}
      />
    ) : (
      <PageSkeleton stats={false} blocks={2} blockHeight={260} />
    )
  }

  // 设置项搜索：按空格分词，要求每个词都命中「label + keywords + 所属分区名」（子串、忽略大小写）
  const navTerms = navQuery.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const navHits =
    navTerms.length === 0
      ? []
      : SETTINGS_INDEX.filter((it) => {
          const hay = `${it.label} ${it.keywords} ${SECTION_LABEL[it.sectionId] ?? ''}`.toLowerCase()
          return navTerms.every((t) => hay.includes(t))
        })

  const saveAi = async () => {
    const v = await aiFormHandle().validateFields().catch(() => null)
    if (!v) return
    try {
      // 表单以秒/K 为单位，后端存储毫秒/token
      const { timeoutMs, maxTokens, contextWindow, ...rest } = v
      await post('/api/settings/ai', { ...rest, ...(rest.apiKey ? {} : { apiKey: undefined }), ...(rest.searchApiKey ? {} : { searchApiKey: undefined }), timeoutMs: Math.round(timeoutMs * 1000), maxTokens: Math.round(maxTokens * 1024), contextWindow: Math.round(contextWindow * 1024) })
      message.success('AI 配置已保存')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // 连接测试用当前表单值（未保存也可测）；输入框留空的字段由后端回退已保存配置
  const testAi = async () => {
    const v = aiFormHandle().getFieldsValue()
    setAiTesting(true)
    setAiTestResult(null)
    try {
      const r = await post<{ ok: boolean; message: string; models?: string[] }>('/api/settings/ai/test', {
        baseURL: v.baseURL,
        apiKey: v.apiKey,
        model: v.model,
      })
      setAiTestResult(r)
      if (r.models?.length) setModelOptions(r.models.map((m) => ({ value: m })))
    } catch (e) {
      setAiTestResult({ ok: false, message: (e as Error).message })
    } finally {
      setAiTesting(false)
    }
  }

  const fetchModels = async () => {
    const v = aiFormHandle().getFieldsValue()
    setModelsLoading(true)
    try {
      const r = await post<{ models: string[] }>('/api/settings/ai/models', { baseURL: v.baseURL, apiKey: v.apiKey })
      if (r.models.length === 0) {
        message.warning('服务未返回任何模型')
        return
      }
      setModelOptions(r.models.map((m) => ({ value: m })))
      message.success(`获取到 ${r.models.length} 个可用模型，点击模型输入框从下拉选择`)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setModelsLoading(false)
    }
  }

  // 删除账号：连带删除该账号的全部提交记录；服务端删除前自动创建恢复点（备份），误删可找回
  const removeAccount = async (platform: PlatformId, handle: string) => {
    try {
      const r = await post<{ deletedSubmissions: number; backupFile: string }>('/api/settings/accounts/remove', {
        platform,
        handle,
      })
      message.success(
        r.deletedSubmissions > 0
          ? `已删除账号 ${handle} 及其 ${r.deletedSubmissions} 条提交记录（恢复点已创建，可在「数据管理 → 备份与恢复」找回）`
          : `账号 ${handle} 已删除`,
        6,
      )
      forgetAcctLocalState(platform, handle)
      setBackupRefresh((n) => n + 1) // 删号已在服务端生成新的 pre-account-delete 恢复点
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // 单账号启停：停用后不参与同步，历史数据保留。
  // 开关按平台+账号记 loading（同一个平台可能有多个账号，共用一个 key 会让相邻开关一起转）
  const toggleAccountEnabled = async (platform: PlatformId, handle: string, enabled: boolean) => {
    await withPending(`account:${platform}:${handle}`, async () => {
      try {
        await post('/api/settings/accounts/enabled', { platform, handle, enabled })
        load()
      } catch (e) {
        message.error((e as Error).message)
      }
    })
  }

  const toggleAdapter = async (platform: PlatformId, enabled: boolean) => {
    await withPending(`adapter:${platform}`, async () => {
      try {
        await post('/api/settings/adapters', { platform, enabled })
        load()
      } catch (e) {
        message.error((e as Error).message)
      }
    })
  }

  /**
   * 落库单次同步上限（§6.4 / P4-3：统一为「失焦 / 回车」提交）。
   *
   * 旧实现是停手 600ms 自动落库：提交时机不可预期（用户不知道到底存没存），
   * 打字中途停顿也会白发一次请求。改成由失焦/回车触发后，提交时机由用户动作决定。
   *
   * 清空输入框（null）不落库、恢复服务端已落库值 —— 空串是「误删」而不是「设成下限」，
   * 悄悄存一个最小值进去用户看不见后果（历史上把 500 存进去过）。
   * 值没变则直接返回：点一下输入框再点走不该产生 POST 与提示。
   */
  const commitSyncMax = async () => {
    const v = syncMax
    if (v == null) {
      setSyncMax(savedSyncMax.current)
      return
    }
    if (v === savedSyncMax.current) return
    setSyncSaving((s) => ({ ...s, max: true }))
    try {
      const r = await post<{ maxSubmissions: number }>('/api/settings/sync', { maxSubmissions: v })
      savedSyncMax.current = r.maxSubmissions
      setSyncMax(r.maxSubmissions)
      message.success(`单次同步上限已保存：${r.maxSubmissions} 条`)
    } catch (e) {
      message.error((e as Error).message)
      setSyncMax(savedSyncMax.current)
    } finally {
      setSyncSaving((s) => ({ ...s, max: false }))
    }
  }

  /**
   * 保存后台续拉轮数（0 = 关闭）。POST /api/settings/sync 要求 maxSubmissions 必填，
   * 故带上服务端已落库的上限值（而不是正在编辑中的本地值）。同样是失焦/回车提交。
   */
  const commitSyncRounds = async () => {
    const v = syncRounds
    if (v == null) {
      setSyncRounds(savedSyncRounds.current)
      return
    }
    if (v === savedSyncRounds.current) return
    setSyncSaving((s) => ({ ...s, rounds: true }))
    try {
      const r = await post<{ autoContinueRounds: number }>('/api/settings/sync', {
        maxSubmissions: savedSyncMax.current,
        autoContinueRounds: v,
      })
      savedSyncRounds.current = r.autoContinueRounds ?? v
      setSyncRounds(r.autoContinueRounds ?? v)
      message.success(v === 0 ? '后台续拉已关闭' : `后台续拉轮数已保存：最多 ${r.autoContinueRounds ?? v} 轮`)
    } catch (e) {
      message.error((e as Error).message)
      setSyncRounds(savedSyncRounds.current)
    } finally {
      setSyncSaving((s) => ({ ...s, rounds: false }))
    }
  }

  /** 计蒜客「同步自由练题提交」开关：落库 settings['jisuanke.practiceSync']（'true'/'false'） */
  const savePracticeSync = async (v: boolean) => {
    await withPending('practice', async () => {
      try {
        const r = await post<{ jisuankePracticeSync: boolean }>('/api/settings/sync', {
          maxSubmissions: savedSyncMax.current,
          jisuankePracticeSync: v,
        })
        setPracticeSync(r.jisuankePracticeSync !== false)
        message.success(v ? '计蒜客自由练题提交将随同步一起导入' : '计蒜客自由练题提交已跳过（只同步比赛提交）')
      } catch (e) {
        message.error((e as Error).message)
        load() // 回滚到服务端实际值
      }
    })
  }

  /** 拉取速度全局倍率：落库 settings['sync.requestIntervalScale'] 并实时下发到节流层（滑块松手时调用） */
  const saveSyncScale = async (v: number) => {
    if (savedScale.current === v) return
    savedScale.current = v
    try {
      const r = await post<{ requestIntervalScale: number }>('/api/settings/sync', {
        maxSubmissions: savedSyncMax.current,
        requestIntervalScale: v,
      })
      const applied = r.requestIntervalScale ?? v
      savedScale.current = applied
      setSyncScale(applied)
      message.success(`拉取速度已保存：${applied.toFixed(1)}×`)
    } catch (e) {
      message.error((e as Error).message)
      load() // 回滚到服务端实际值（load 会同步 savedScale）
    }
  }

  /** 拖动过程中的防抖兜底提交（600ms 无新变化即落库一次） */
  const queueSyncScaleSave = (v: number) => {
    if (scaleSaveTimer.current !== null) window.clearTimeout(scaleSaveTimer.current)
    scaleSaveTimer.current = window.setTimeout(() => {
      scaleSaveTimer.current = null
      void saveSyncScale(v)
    }, 600)
  }

  /** 改动某账号凭据的某字段：记入该草稿键的 dirty 集合（保存时只提交这些字段）。
   *  草稿键 = 已绑定账号的 handle（改名时草稿挂在原 handle 上不丢失）或 NEW_DRAFT_KEY（新增） */
  const setAcctField = (platform: PlatformId, draftKey: string, key: string, value: string) => {
    setAcctInputs((s) => ({
      ...s,
      [platform]: { ...(s[platform] ?? {}), [draftKey]: { ...(s[platform]?.[draftKey] ?? {}), [key]: value } },
    }))
    setAcctDirty((s) => {
      const byKey = s[platform] ?? {}
      const next = new Set(byKey[draftKey] ?? [])
      next.add(key)
      return { ...s, [platform]: { ...byKey, [draftKey]: next } }
    })
  }

  /** 检测某账号的生效凭据（只检该账号自己卡片里配置的 Cookie，与同步同一口径） */
  const checkAccountCreds = async (platform: PlatformId, handle: string) => {
    setAcctCheck((s) => ({ ...s, [platform]: { ...(s[platform] ?? {}), [handle]: 'checking' } }))
    try {
      const r = await post<{ ok: boolean; message: string }>('/api/settings/cookies/check', { platform, handle })
      setAcctCheck((s) => ({ ...s, [platform]: { ...(s[platform] ?? {}), [handle]: r } }))
    } catch (e) {
      setAcctCheck((s) => ({
        ...s,
        [platform]: { ...(s[platform] ?? {}), [handle]: { ok: false, message: (e as Error).message } },
      }))
    }
  }

  /** 打开账号小卡片：handle=null = 新增账号。已配置凭据的账号自动检测一次，直接暴露过期状态 */
  const openAcctEditor = (platform: PlatformId, handle: string | null) => {
    setAcctEditor({ platform, handle })
    setDraftHandle(handle ?? '')
    if (handle && !acctCheck[platform]?.[handle] && data?.accountCreds?.[platform]?.[handle]) {
      void checkAccountCreds(platform, handle)
    }
  }

  /** 提交账号小卡片「保存」：
   *  - 新增：绑定账号（同 handle 重复保存 = 重新启用）→ 随卡片填写的凭据一并落库；
   *  - 修改：先落凭据（dirty 字段，写在原 handle 名下），若改了名则调改名接口——服务端在同一
   *    事务里迁移账号行与提交记录归属、并迁移凭据槽位，避免「删号重绑」丢提交记录。
   *  任一步失败保留卡片让用户改错，成功后关卡片并刷新 */
  const submitAcctEditor = async (platform: PlatformId, original: string | null) => {
    const handle = draftHandle.trim()
    if (!handle) {
      message.warning('请先填写账号名')
      return
    }
    const draftKey = original ?? NEW_DRAFT_KEY
    const name = PLATFORMS.find((p) => p.id === platform)?.name ?? platform
    try {
      if (original) {
        await commitAcctCreds(platform, original, draftKey)
        if (handle !== original) {
          await post('/api/settings/accounts/rename', { platform, handle: original, newHandle: handle })
          message.success(`账号已改名：${original} → ${handle}，提交记录与凭据已一并迁移`)
        }
      } else {
        await post('/api/settings/accounts', { platform, handle })
        message.success(`${name} 账号 ${handle} 已绑定；请到「题目管理 → 导入 → 平台同步」填入同一用户名完成同步`)
        await commitAcctCreds(platform, handle, draftKey)
      }
      forgetAcctLocalState(platform, original ?? handle)
      setAcctEditor(null)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /** 提交某账号凭据的 dirty 字段到该账号名下（无改动则静默跳过，不弹提示）。
   *  configOnly（QOJ 浏览器 UA）随卡片保存写平台级共享值；普通字段写账号槽位。
   *  全部字段显式清空保存 = 删除该账号的凭据槽位（回到未配置状态），不动提交记录 */
  const commitAcctCreds = async (platform: PlatformId, handle: string, draftKey: string) => {
    const defs = cookieFieldsOf(platform)
    const dirty = acctDirty[platform]?.[draftKey] ?? new Set<string>()
    const values = acctInputs[platform]?.[draftKey] ?? {}
    const cookieFields: Record<string, string> = {}
    for (const f of defs) {
      if (!dirty.has(f.key)) continue
      const raw = (values[f.key] ?? '').trim()
      if (f.configOnly || f.raw) {
        // configOnly（浏览器 UA）与 raw 字段：原样提交，空串 = 显式清除
        cookieFields[f.key] = raw
        continue
      }
      const item = buildCookieItem(f, raw)
      cookieFields[f.key] = item ? item.slice(item.indexOf('=') + 1) : ''
    }
    if (Object.keys(cookieFields).length === 0) return
    const r = await post<{ ok: boolean; fields?: string[] }>('/api/settings/cookies', {
      platform,
      handle,
      cookieFields,
    })
    message.success(
      (r.fields?.length ?? 0) > 0
        ? `账号 ${handle} 的凭据已更新（${(r.fields ?? []).join(' + ')}）；未填写的字段同步时回退平台级`
        : `账号 ${handle} 的凭据已清除，同步时回退平台级`,
    )
    setAcctInputs((s) => ({ ...s, [platform]: { ...(s[platform] ?? {}), [draftKey]: {} } }))
    setAcctDirty((s) => ({ ...s, [platform]: { ...(s[platform] ?? {}), [draftKey]: new Set<string>() } }))
    void checkAccountCreds(platform, handle)
  }

  /** 删除账号（二次确认）：连带删除提交记录，删除前服务端自动创建恢复点 */
  const confirmRemoveAccount = (platform: PlatformId, handle: string) => {
    modal.confirm({
      title: `删除账号 ${handle}？`,
      content: '将同时删除该账号的全部提交记录；删除前自动创建恢复点，误删可在「数据管理 → 备份与恢复」找回。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await removeAccount(platform, handle)
        setAcctEditor(null)
      },
    })
  }

  /** 账号删除/保存后联动丢弃其本地草稿与检测结果，并关闭正编辑着该账号的卡片 */
  const forgetAcctLocalState = (platform: PlatformId, handle: string) => {
    const drop = <T,>(m: Record<string, Record<string, T>>): Record<string, Record<string, T>> => {
      const byKey = { ...(m[platform] ?? {}) }
      delete byKey[handle]
      return { ...m, [platform]: byKey }
    }
    setAcctInputs((s) => drop(s))
    setAcctDirty((s) => drop(s))
    setAcctCheck((s) => drop(s))
    setAcctEditor((ed) => (ed && ed.platform === platform && ed.handle === handle ? null : ed))
  }

  /** Cookie 密码框点眼睛：切到「显示」且输入框为空时，按需向服务端取回该字段已保存的原文
   *  （原文平时不下发前端）。handle=null = 新增账号卡片（还没存过任何值，不取）。已输入的值不覆盖 */
  const toggleCredShown = (
    platform: PlatformId,
    draftKey: string,
    key: string,
    next: boolean,
    currentValue: string,
    handle: string | null,
  ) => {
    setCredShown((s) => ({ ...s, [`${platform}::${draftKey}::${key}`]: next }))
    if (next && !currentValue.trim() && handle) void revealCred(platform, key, handle)
  }

  const revealCred = async (platform: PlatformId, fieldKey: string, handle: string) => {
    try {
      const r = await post<{ value: string }>('/api/settings/cookies/reveal', {
        platform,
        handle,
        fieldKey,
      })
      if (!r.value) return // 该账号没存过这个字段：输入框保持空
      setAcctField(platform, handle, fieldKey, r.value)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const saveReminder = async (enabled: boolean, time: Dayjs) => {
    try {
      await post('/api/settings/reminder', { enabled, time: time.format('HH:mm') })
      setReminderEnabled(enabled)
      message.success(enabled ? `打卡提醒已开启，每天 ${time.format('HH:mm')} 提醒` : '打卡提醒已关闭')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const toggleReminder = async (enabled: boolean) => {
    if (!enabled) {
      await withPending('reminder', () => saveReminder(false, reminderTime))
      return
    }
    // 开启需授权浏览器系统通知（点击开关即用户手势，授权弹窗不会被浏览器拦截）
    // 授权弹窗期间不给开关加 loading：系统弹窗本身就是反馈，转圈反而像卡住
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') {
        message.warning('未授权系统通知，仅会在页面内弹出提醒')
      }
    }
    await withPending('reminder', () => saveReminder(true, reminderTime))
  }

  const saveContestReminder = async (next: ContestReminderConfig) => {
    const prev = contestReminder
    setContestReminder(next) // 开关即时反馈，失败回滚
    try {
      const saved = await post<ContestReminderConfig>('/api/settings/contest-reminder', next)
      setContestReminder(saved)
      message.success(
        saved.enabled ? `赛前提醒已开启：开赛前 ${saved.minutesBefore} 分钟通知` : '赛前提醒已关闭',
      )
    } catch (e) {
      setContestReminder(prev)
      message.error((e as Error).message)
    }
  }

  const downloadPrompt = async (url: string, filename: string, successText?: string) => {
    void saveUrlAsFile({ url, filename, successText, message })
  }

  /** 账号小卡片内容（新增 / 修改共用）：账号名 + Cookie 类平台的该账号凭据 + 参与同步 / 删除。
   *  account=null 为「添加账号」新建模式；凭据草稿按 draftKey（原 handle / NEW_DRAFT_KEY）读写 */
  const acctCardContent = (p: (typeof PLATFORMS)[number], account: SettingsData['accounts'][number] | null) => {
    const handle = account?.handle ?? null
    const draftKey = handle ?? NEW_DRAFT_KEY
    const isCookie = p.sync === 'cookie'
    const slotMasked = handle ? data.accountCreds?.[p.id]?.[handle]?.masked : undefined
    const aCheck = handle ? acctCheck[p.id]?.[handle] : undefined
    const vals = acctInputs[p.id]?.[draftKey] ?? {}
    const fields = isCookie ? cookieFieldsOf(p.id) : []
    const platformName = PLATFORMS.find((x) => x.id === p.id)?.name ?? p.id
    return (
      <div style={{ minWidth: 300, maxWidth: 520 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
          {handle ? `修改账号 ${handle}` : `绑定 ${platformName} 账号`}
        </div>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 2 }}>账号名</div>
          <Input
            placeholder={p.id === 'codeforces' ? 'CF handle' : '用户名 / uid'}
            value={draftHandle}
            onChange={(e) => setDraftHandle(e.target.value)}
            onPressEnter={() => void submitAcctEditor(p.id, handle)}
            style={{ width: '100%' }}
          />
        </div>
        {isCookie && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>
              {handle ? '凭据' : '凭据（可留空）'}
            </div>
            {handle && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                <Button size="small" loading={aCheck === 'checking'} onClick={() => void checkAccountCreds(p.id, handle)}>
                  检测
                </Button>
                {aCheck && aCheck !== 'checking' && (
                  <>
                    <Tag color={aCheck.ok ? 'success' : 'error'} style={{ marginRight: 0 }}>
                      {aCheck.ok ? '凭据有效' : '凭据无效 / 已过期'}
                    </Tag>
                    {!aCheck.ok && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{aCheck.message}</span>}
                  </>
                )}
              </div>
            )}
            <Space wrap size={8}>
              {fields.map((f) => {
                // 已配置判定：普通字段看账号槽位打码头；configOnly（QOJ 浏览器 UA）是全账号共用的
                // 平台级配置，看服务端 hasUa
                const own = handle
                  ? f.configOnly
                    ? ''
                    : extractCookieValue(slotMasked ?? '', f.cookieName)
                  : ''
                const sharedConfigured = f.configOnly && handle && data.cookies[p.id]?.hasUa === true
                const ph = own
                  ? `已配置 ${own} · 粘贴新值可覆盖`
                  : sharedConfigured
                    ? '已配置（全部账号共用）· 粘贴新值可覆盖'
                    : f.placeholder
                const input = f.password ? (
                  <Input.Password
                    placeholder={ph}
                    style={{ width: 220 }}
                    value={vals[f.key] ?? ''}
                    visibilityToggle={{
                      visible: credShown[`${p.id}::${draftKey}::${f.key}`] ?? false,
                      onVisibleChange: (v) => toggleCredShown(p.id, draftKey, f.key, v, vals[f.key] ?? '', handle),
                    }}
                    onChange={(e) => setAcctField(p.id, draftKey, f.key, e.target.value)}
                  />
                ) : (
                  <Input
                    placeholder={ph}
                    style={{ width: 220 }}
                    value={vals[f.key] ?? ''}
                    onChange={(e) => setAcctField(p.id, draftKey, f.key, e.target.value)}
                  />
                )
                return (
                  <div key={f.key}>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 2 }}>
                      <code style={{ fontSize: 12 }}>{f.configOnly ? 'User-Agent' : f.cookieName}</code>
                      {f.label ? ` · ${f.label}` : ''}
                    </div>
                    {input}
                  </div>
                )
              })}
            </Space>
          </div>
        )}
        {account && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span className="mono" style={{ fontSize: 12, color: 'var(--text-3)' }}>
              {account.last_sync_at ? `上次同步 ${relativeTimeText(account.last_sync_at)}` : '从未同步'}
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>参与同步</span>
            <Switch
              size="small"
              checked={account.enabled === 1}
              loading={isPending(`account:${p.id}:${account.handle}`)}
              onChange={(v) => void toggleAccountEnabled(p.id, account.handle, v)}
            />
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button type="primary" size="small" onClick={() => void submitAcctEditor(p.id, handle)}>
            保存
          </Button>
          {handle && (
            <Button size="small" danger onClick={() => confirmRemoveAccount(p.id, handle)}>
              删除账号
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="设置"
        description="配置平台账号、AI 和提醒"
        extra={
          <Segmented
            value={preference}
            onChange={(v) => setPreference(v as ThemePreference)}
            options={[
              { label: '跟随系统', value: 'system' },
              { label: '亮色', value: 'light' },
              { label: '暗色', value: 'dark' },
            ]}
          />
        }
      />
      {/* 分区导航 + 设置项搜索（P4-1 / P4-2）：只做锚点定位，不搬动卡片。
          <1280px 顶部吸顶横排；≥1280px 左侧竖排（P3）—— 布局差异全在 CSS，
          这里只负责把 Segmented 换成 antd 的 vertical/block（DOM 只有一份）。 */}
      <div className="settings-shell">
      <div className="settings-nav">
        {/* width:fit-content → 宽屏下「导航 + 约 200px 搜索框」保持自然宽度；
            maxWidth:100% + flex-wrap → 窄屏下搜索框自动换行，并由 flex-grow 撑满整行（无 JS 断点） */}
        <div className="settings-nav-inner">
          <div className="settings-nav-seg">
            <Segmented
              size="small"
              vertical={wideNav}
              block={wideNav}
              value={activeSection}
              onChange={(v) => jumpToSection(String(v))}
              options={SETTINGS_SECTIONS.map((s) => ({ label: s.label, value: s.id }))}
            />
          </div>
          <div className="settings-nav-search">
            <Input
              allowClear
              value={navQuery}
              onChange={(e) => setNavQuery(e.target.value)}
              prefix={<SearchOutlined style={{ color: 'var(--text-3)' }} />}
              placeholder="搜索设置项…"
              aria-label="搜索设置项"
              style={{ width: '100%' }}
            />
            {navTerms.length > 0 && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  // 宽屏时导航在 220px 窄栏里，命中列表改为向右展开（盖到内容区），
                  // 否则 320px 的浮层会向左溢出到页面外
                  right: wideNav ? 'auto' : 0,
                  left: wideNav ? 0 : 'auto',
                  zIndex: 6,
                  width: 320,
                  maxWidth: '92vw',
                  maxHeight: 320,
                  overflowY: 'auto',
                  marginTop: 6,
                  padding: 4,
                  background: 'var(--surface)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  boxShadow: 'var(--shadow)',
                }}
              >
                {navHits.length === 0 ? (
                  <div style={{ padding: '8px 10px', fontSize: 13, color: 'var(--text-3)' }}>
                    没有匹配的设置项
                  </div>
                ) : (
                  navHits.map((it) => (
                    <Button
                      key={`${it.sectionId}:${it.label}`}
                      type="text"
                      block
                      onClick={() => {
                        setNavQuery('') // 收起命中列表，否则浮层会盖住刚高亮的分区
                        jumpToSection(it.sectionId)
                      }}
                      style={{ height: 'auto', padding: '6px 8px', textAlign: 'left' }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                        <span style={{ fontSize: 13 }}>{it.label}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{SECTION_LABEL[it.sectionId]}</span>
                      </div>
                    </Button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="settings-body">
      <Row gutter={[16, 24]}>
      <Col xs={24} lg={12} id="settings-ai" style={sectionAnchor('settings-ai')}>
        {/* AI 配置表单是独立子组件：form 实例必须在**表单本身挂载时**创建。
            旧实现把 Form.useForm() 放在本页顶部（数据还没到、Form 还没挂载：
            首屏 !data 早退渲染骨架，这里根本不渲染），于是每次进设置页都刷一条
            「Instance created by `useForm` is not connected to any Form element」告警，
            持续掩盖真实错误信号。下沉到子组件后实例与 Form 同生，告警消失。 */}
        <AiSettingsCard
          ref={aiForm}
          ai={data.ai}
          modelOptions={modelOptions}
          testing={aiTesting}
          testResult={aiTestResult}
          modelsLoading={modelsLoading}
          onSave={saveAi}
          onTest={testAi}
          onFetchModels={fetchModels}
        />
      </Col>
      <Col xs={24} lg={12} id="settings-accounts" style={sectionAnchor('settings-accounts')}>
        <Card title={<span className="settings-section-title"><UserOutlined />平台账号与适配器</span>} size="small">
          <Collapse
            defaultActiveKey={data.platforms.map((p) => p.id)}
            size="small"
            className="platform-collapse"
            items={data.platforms.map((p) => {
              const platformAccounts = data.accounts.filter((a) => a.platform === p.id)
              const account = platformAccounts.find((a) => a.enabled === 1) ?? platformAccounts[0]
              const enabled = data.adapterEnabled[p.id] !== false
              const syncNote =
                p.sync === 'auto' ? '自动同步' : p.sync === 'cookie' ? '配置 Cookie 后自动同步' : '仅手动导入'
              // 连接状态点：自动同步平台看「已绑定 + 适配器开启」；cookie 平台聚合各账号凭据的
              // 检测结果（任一有效 = 已连接；都在检测中 = 检测中；有槽位未检测 = 检测中，由
              // 上方 effect 自动触发；其余 = 未连接——没账号或没有任何账号配置凭据）
              const dot =
                p.sync === 'auto'
                  ? account && enabled
                    ? { cls: 'conn-dot-ok', title: '已连接' }
                    : { cls: 'conn-dot-fail', title: '未连接' }
                  : (() => {
                      const results = platformAccounts.map((a) => acctCheck[p.id]?.[a.handle])
                      if (results.some((r) => r === 'checking')) {
                        return { cls: 'conn-dot-checking', title: '检测中…' }
                      }
                      const checked = results.filter(
                        (r): r is { ok: boolean; message: string } => Boolean(r) && r !== 'checking',
                      )
                      if (checked.some((r) => r.ok)) {
                        return { cls: 'conn-dot-ok', title: '已连接（至少一个账号凭据有效）' }
                      }
                      const withSlot = platformAccounts.filter((a) => data.accountCreds?.[p.id]?.[a.handle])
                      if (withSlot.length > 0 && withSlot.every((a) => acctCheck[p.id]?.[a.handle])) {
                        return { cls: 'conn-dot-fail', title: '未连接（已配置账号的凭据均无效）' }
                      }
                      if (withSlot.length > 0) {
                        return { cls: 'conn-dot-checking', title: '已配置（未检测）' }
                      }
                      return { cls: 'conn-dot-fail', title: '未连接' }
                    })()
              return {
                key: p.id,
                label: (
                  <Space size={8}>
                    <a
                      className="platform-link"
                      title={`打开 ${p.name} 官网`}
                      onClick={(e) => {
                        e.stopPropagation()
                        openExternal(p.homepage)
                      }}
                    >
                      <PlatformTag id={p.id} name={<b>{p.name}</b>} />
                      <LinkOutlined className="platform-link-icon" />
                    </a>
                    <Tag color={SYNC_NOTE_COLOR[p.sync]}>{syncNote}</Tag>
                    {platformAccounts.length > 0 && (
                      <span className="bound-info">
                        已绑定 {platformAccounts.slice(0, 2).map((a) => a.handle).join('、')}
                        {platformAccounts.length > 2 ? ` 等 ${platformAccounts.length} 个` : ''}
                      </span>
                    )}
                  </Space>
                ),
                extra: (
                  <Space size={6} onClick={(e) => e.stopPropagation()}>
                    <span className="adapter-label">自动同步</span>
                    <Switch
                      size="small"
                      checked={enabled}
                      loading={isPending(`adapter:${p.id}`)}
                      onChange={(v) => toggleAdapter(p.id, v)}
                    />
                    <span className={`conn-dot ${dot.cls}`} title={dot.title} />
                  </Space>
                ),
                children: (
                  <>
                    {/* 已绑定账号 = 一排可点击的账号名称框：点开小卡片可改账号名 / 凭据 / 参与同步 / 删除；
                        「＋ 添加账号」弹出同一张卡片的新建模式（需要填写的信息一目了然） */}
                    <Space wrap size={8} align="center" style={{ marginBottom: 4 }}>
                      {platformAccounts.map((a) => {
                        // 账号级凭据（多账号）：打码版来自服务端 accountCreds；未配置 = 该账号同步时无 Cookie 可用
                        const slotMasked = data.accountCreds?.[p.id]?.[a.handle]?.masked
                        const aCheck = acctCheck[p.id]?.[a.handle]
                        const credDot =
                          aCheck === 'checking'
                            ? { cls: 'conn-dot-checking', title: '检测中…' }
                            : aCheck
                              ? aCheck.ok
                                ? { cls: 'conn-dot-ok', title: '凭据有效' }
                                : { cls: 'conn-dot-fail', title: '凭据无效或已过期，点开续期' }
                              : slotMasked
                                ? { cls: '', title: '已配置凭据（未检测）' }
                                : { cls: '', title: '未单独配置凭据：同步回退平台级 Cookie' }
                        return (
                          <Popover
                            key={a.handle}
                            open={acctEditor?.platform === p.id && acctEditor.handle === a.handle}
                            trigger="click"
                            placement="bottomLeft"
                            onOpenChange={(v) => (v ? openAcctEditor(p.id, a.handle) : setAcctEditor(null))}
                            content={acctCardContent(p, a)}
                          >
                            <Button
                              size="small"
                              style={{ opacity: a.enabled === 1 ? 1 : 0.5 }}
                              title={a.enabled === 1 ? '点击修改账号名 / 凭据' : '已停用（不参与同步），点击修改'}
                            >
                              {a.handle}
                              {p.sync === 'cookie' && (
                                <span
                                  className={`conn-dot ${credDot.cls}`}
                                  style={{
                                    marginLeft: 6,
                                    ...(credDot.cls
                                      ? {}
                                      : slotMasked
                                        ? { background: 'var(--text-3)' }
                                        : { border: '1px solid var(--line)' }),
                                  }}
                                  title={credDot.title}
                                />
                              )}
                            </Button>
                          </Popover>
                        )
                      })}
                      <Popover
                        open={acctEditor?.platform === p.id && acctEditor?.handle === null}
                        trigger="click"
                        placement="bottomLeft"
                        onOpenChange={(v) => (v ? openAcctEditor(p.id, null) : setAcctEditor(null))}
                        content={acctCardContent(p, null)}
                      >
                        <Button size="small" variant="dashed" icon={<PlusOutlined />}>
                          {platformAccounts.length > 0 ? '添加账号' : '绑定'}
                        </Button>
                      </Popover>
                    </Space>
                    {(p.id === 'leetcode' || p.id === 'jisuanke') && (
                      <p style={{ margin: '2px 0 0', color: 'var(--amber)', fontSize: 12 }}>
                        ⚠ 多账号请为每个账号分别配置 Cookie：此平台的提交记录跟随 Cookie 登录身份拉取。
                      </p>
                    )}
                    {p.id === 'qoj' && (
                      <p style={{ margin: '2px 0 0', color: 'var(--text-3)', fontSize: 12 }}>
                        qoj.ac 登录后 F12 → Application → Cookies 复制 __Host-UOJSESSID（旧名 UOJSESSID）与 cf_clearance（点账号框在卡片里粘贴，
                        也可整段 Cookie 粘进任一框自动分派）；cf_clearance 约 30 分钟过期，过期后重贴该项即可。
                        浏览器 UA 在账号卡片里填写，全部账号共用。
                      </p>
                    )}
                  </>
                ),
              }
            })}
          />
          {/* 「同步」分区的锚点容器（P4-1）：同步类设置都在本卡片内，包一层只为给导航/搜索
              一个可滚动的整体锚点，不加任何样式（子元素原有的 margin 折叠行为不变） */}
          <div id="settings-sync" style={sectionAnchor('settings-sync')}>
          <div style={{ marginTop: 4 }}>
            <Space>
              <span>单次同步上限</span>
              <Space.Compact block style={{ width: 140 }}>
                <InputNumber
                  min={100}
                  max={1500}
                  step={100}
                  value={syncMax}
                  // onChange 只即时回显；落库交给失焦 / 回车（§6.4 统一提交模式）
                  onChange={(v) => setSyncMax(v)}
                  onBlur={() => void commitSyncMax()}
                  onPressEnter={() => void commitSyncMax()}
                  // 提交中禁用：InputNumber 没有 loading 属性，禁用是它的等价「忙碌」提示，
                  // 同时挡掉「失焦提交还没回来又改一次」的竞态
                  disabled={syncSaving.max}
                  style={{ width: '100%' }}
                  aria-label="单次同步上限"
                />
                {/* antd 5 起 InputNumber 的 addonAfter 已弃用（控制台告警），改用 Space.Compact 拼单位 */}
                <Button disabled className="compact-unit">条</Button>
              </Space.Compact>
              <span className="muted-note">提交记录过多时分批拉取，防触发平台风控封号（默认 300，保守为主）</span>
            </Space>
          </div>
          <div style={{ marginTop: 8 }}>
            <Space wrap>
              <span>后台续拉轮数</span>
              <Space.Compact block style={{ width: 140 }}>
                <InputNumber
                  min={0}
                  max={50}
                  step={1}
                  value={syncRounds}
                  onChange={(v) => setSyncRounds(v)}
                  onBlur={() => void commitSyncRounds()}
                  onPressEnter={() => void commitSyncRounds()}
                  disabled={syncSaving.rounds}
                  style={{ width: '100%' }}
                  aria-label="后台续拉轮数"
                />
                <Button disabled className="compact-unit">轮</Button>
              </Space.Compact>
              <span className="muted-note">
                单次同步达到上限被截断后，后台按平台节奏自动续拉的最大轮数（0 = 关闭，默认 3）。
                续拉进度与「停止续拉」在「题目管理 → 导入 → 平台同步」中显示。
              </span>
            </Space>
          </div>
          <div style={{ marginTop: 12 }}>
            <Space align="center" wrap={false} style={{ width: '100%', maxWidth: 460 }}>
              <span style={{ whiteSpace: 'nowrap' }}>拉取速度</span>
              <Slider
                min={1}
                max={5}
                step={0.5}
                value={syncScale}
                marks={{ 1: '1×', 5: '5×' }}
                onChange={(v) => {
                  setSyncScale(v)
                  queueSyncScaleSave(v)
                }}
                onChangeComplete={(v) => {
                  if (scaleSaveTimer.current !== null) {
                    window.clearTimeout(scaleSaveTimer.current)
                    scaleSaveTimer.current = null
                  }
                  void saveSyncScale(v)
                }}
                style={{ flex: 1, minWidth: 140 }}
              />
              <Tag color="blue" style={{ marginInlineEnd: 0 }}>{syncScale.toFixed(1)}×</Tag>
            </Space>
            <div className="muted-note" style={{ fontSize: 12, lineHeight: '20px', marginTop: 2 }}>
              {PLATFORMS.map((p, i) => {
                const baseMs = intervalBase[p.id]
                if (!baseMs) return null
                return (
                  // display:inline-block 让每个平台成为**原子行内盒**：既能保证「LeetCode 1.5s」
                  // 自身不被拆断（whiteSpace:nowrap），又给了浏览器在两项之间换行的机会。
                  // 全是 nowrap 的行内 span 且相邻无空白时，整串是一个不可断的长行 ——
                  // 窄窗口（≤1280）下会直接把页面撑出水平滚动条。
                  <span key={p.id} style={{ whiteSpace: 'nowrap', display: 'inline-block' }}>
                    {i > 0 && <span style={{ margin: '0 4px', opacity: 0.5 }}>·</span>}
                    {p.name} {((baseMs * syncScale) / 1000).toFixed(1)}s
                  </span>
                )
              })}
            </div>
            <div className="muted-note" style={{ fontSize: 12, lineHeight: '18px' }}>
              1× = 安全下限：最快也不触发风控；大于 1× 时每次请求（含同步首请求）都按上述间隔执行。
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            <Space wrap>
              <span>计蒜客「同步自由练题提交」</span>
              <Switch
                size="small"
                checked={practiceSync}
                loading={isPending('practice')}
                onChange={(v) => void savePracticeSync(v)}
              />
              <span className="muted-note">
                开启后同步计蒜客题库（自由练）的提交记录，关闭则只同步比赛提交（默认开启，与旧行为一致）
              </span>
            </Space>
          </div>
          </div>
        </Card>
      </Col>
      <Col span={24} id="settings-reminder" style={sectionAnchor('settings-reminder')}>
        <Card title={<span className="settings-section-title"><BellOutlined />打卡与赛前提醒</span>} size="small">
          <Space wrap>
            <span>每日提醒</span>
            <Switch checked={reminderEnabled} loading={isPending('reminder')} onChange={toggleReminder} />
            <span>提醒时间</span>
            <TimePicker
              format="HH:mm"
              minuteStep={5}
              value={reminderTime}
              disabled={!reminderEnabled}
              onChange={(v) => v && saveReminder(reminderEnabled, v)}
            />
          </Space>
          <div style={{ marginTop: 12 }}>
            <Space wrap>
              <span>赛前提醒</span>
              <Switch
                checked={contestReminder.enabled}
                onChange={(enabled) => {
                  if (!enabled) {
                    void saveContestReminder({ ...contestReminder, enabled: false })
                    return
                  }
                  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
                    void Notification.requestPermission().then((perm) => {
                      if (perm !== 'granted') message.warning('未授权系统通知，仅会在页面内弹出提醒')
                    })
                  }
                  void saveContestReminder({ ...contestReminder, enabled: true })
                }}
              />
              <span>提前</span>
              <Space.Compact block style={{ width: 120 }}>
                <InputNumber
                  min={5}
                  max={120}
                  step={5}
                  value={contestReminder.minutesBefore}
                  disabled={!contestReminder.enabled}
                  onChange={(v) => v && void saveContestReminder({ ...contestReminder, minutesBefore: v })}
                  style={{ width: '100%' }}
                />
                <Button disabled className="compact-unit">分钟</Button>
              </Space.Compact>
            </Space>
          </div>
          {(() => {
            if (typeof Notification === 'undefined') {
              return <span className="perm-note" style={{ color: 'var(--text-3)' }}>当前浏览器不支持系统通知，仅页面内提醒</span>
            }
            if (Notification.permission === 'granted') {
              return <span className="perm-note" style={{ color: 'var(--green)' }}>系统通知已授权 ✓</span>
            }
            return (
              <span className="perm-note" style={{ color: 'var(--amber)' }}>
                系统通知未授权（关闭再开启开关可重新授权，否则仅页面内提醒）
              </span>
            )
          })()}
          <p className="muted-note" style={{ marginBottom: 0 }}>
            每日提醒：应用保持打开时，到达提醒时间若当天仍有未打卡任务，会弹出通知并跳转日历打卡，任务全部完成或无任务则不打扰。
            赛前提醒：开赛前指定分钟数提醒一次（每场只提醒一次），点击直达赛事中心。
          </p>
        </Card>
      </Col>
      {/* 「数据」分区的锚点：导出 / 知识点管线 / 备份恢复三张卡片同属该分区，
          锚点落在第一张卡片上，滚动时整段都算「数据」 */}
      <Col span={24} id="settings-data" style={sectionAnchor('settings-data')}>
        <Card title={<span className="settings-section-title"><FileMarkdownOutlined />导出（手动喂给任意 AI）</span>} size="small">
          <Space wrap>
            <InputNumber min={1} max={90} value={exportDays} onChange={(v) => setExportDays(v ?? 14)} style={{ width: 80 }} />
            <Button onClick={() => void downloadPrompt(`/api/export/plan-prompt.md?days=${exportDays}`, 'plan-prompt.md', '提示词已导出')}>
              下载提示词 .md
            </Button>
            <Button onClick={() => void downloadPrompt('/api/export/summary.md', 'practice-summary.md', '练习数据已导出')}>
              下载练习数据汇总 .md
            </Button>
            <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
              导入 AI 计划
            </Button>
            <span style={{ color: 'var(--text-3)', fontSize: 12 }}>
              提示词已内置你的完整练习数据汇总（弱项、掌握度、卡壳题、复习库、课程进度）；「数据汇总」也可单独下载，用于复盘或喂给其他 AI。
            </span>
          </Space>
        </Card>
      </Col>

      <Col span={24}>
        <KnowledgePipelineCard />
      </Col>

      <ImportPlanModal open={importOpen} onClose={() => setImportOpen(false)} />
      <Col span={24}>
        <BackupCard refreshKey={backupRefresh} />
      </Col>
      </Row>
      </div>
      </div>
    </div>
  )
}

/**
 * 带「单位」后缀的数字输入框。
 *
 * antd 5 起 `InputNumber` 的 `addonAfter` 已弃用（每次进设置页 6 处各刷一条控制台告警），
 * 官方推荐用 `Space.Compact` 把单位拼成一个附件块。这里统一成一个组件，避免 6 处各写一遍、
 * 又各自长歪；单位用 `disabled` 的 Button，视觉上就是 addonAfter 的等效形态（灰底、贴边）。
 */
function NumberUnitInput({
  unit,
  className,
  ...rest
}: Omit<ComponentProps<typeof InputNumber>, 'addonAfter'> & { unit: string }) {
  return (
    <Space.Compact block className={className}>
      <InputNumber {...rest} style={{ width: '100%', ...rest.style }} />
      <Button disabled className="compact-unit">
        {unit}
      </Button>
    </Space.Compact>
  )
}

/**
 * 「AI 配置」表单卡片。
 *
 * 为什么单独拆成组件（H2）：`Form.useForm()` 必须在 Form 自身挂载时才创建实例。
 * 本页首屏在数据回来之前是早退渲染骨架的（见上面的 `if (!data)`），若把 useForm 留在
 * 页面组件顶部，实例先于 Form 诞生，antd 就会在控制台刷
 * 「Instance created by `useForm` is not connected to any Form element」。
 * 拆出来后实例与卡片同生共死，告警根治。
 *
 * 对外通过 ref 暴露表单实例：父组件要拿它做保存前校验 / 取字段值 / 测试连接，
 * 这些动作的按钮留在父组件的语义范围内（保存流程也涉及 reload 等页面状态）。
 */
type AiFormValues = {
  enabled: boolean
  baseURL: string
  apiKey: string
  model: string
  timeoutMs: number
  maxTokens: number
  contextWindow: number
  searchEngine: 'tavily' | 'brave'
  searchApiKey: string
}

export type AiSettingsCardHandle = {
  validateFields: () => Promise<AiFormValues>
  getFieldsValue: () => AiFormValues
  resetFields: () => void
}

const AiSettingsCard = ({
  ref,
  ai,
  modelOptions,
  testing,
  testResult,
  modelsLoading,
  onSave,
  onTest,
  onFetchModels,
}: {
  ref: Ref<AiSettingsCardHandle>
  ai: SettingsData['ai']
  modelOptions: { value: string }[]
  testing: boolean
  testResult: { ok: boolean; message: string } | null
  modelsLoading: boolean
  onSave: () => void
  onTest: () => void
  onFetchModels: () => void
}) => {
  const [form] = Form.useForm<AiFormValues>()

  // 服务端值 → 表单值（秒 / K 换算），与页面加载同频。父组件用 data 变化驱动重新同步，
  // 效果等同于旧实现里 `useEffect(load, [aiForm])` 依赖表单实例那次同步。
  useEffect(() => {
    form.setFieldsValue({
      ...ai,
      apiKey: '',
      timeoutMs: ai.timeoutMs ? ai.timeoutMs / 1000 : 120,
      maxTokens: Math.round((ai.maxTokens ?? 393216) / 1024),
      contextWindow: Math.round((ai.contextWindow ?? 1024000) / 1024),
      searchEngine: ai.searchEngine ?? 'tavily',
      searchApiKey: '',
    })
  }, [ai, form])

  // 反向 ref：把表单实例交给父组件（React 19 里 ref 可以直接作为普通 prop 传递）
  useImperativeHandle(ref, () => ({
    validateFields: () => form.validateFields(),
    getFieldsValue: () => form.getFieldsValue() as AiFormValues,
    resetFields: () => form.resetFields(),
  }), [form])

  return (
    <Card title={<span className="settings-section-title"><RobotOutlined />AI 配置（OpenAI 兼容接口）</span>} size="small">
      <Form form={form} layout="vertical">
        <Form.Item name="enabled" label="启用 AI 生成" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item name="baseURL" label="Base URL" rules={[{ required: true, message: '必填' }]}>
          <Input placeholder="https://api.deepseek.com/v1" />
        </Form.Item>
        <Form.Item name="apiKey" label="API Key">
          <Input.Password
            placeholder={
              ai.hasApiKey
                ? `已配置 ${ai.apiKeyMasked || '••••••••'} · 留空保持不变，粘贴新值可覆盖`
                : '留空则不填（可用环境变量 AI_API_KEY）'
            }
          />
        </Form.Item>
        <Form.Item name="model" label="模型">
          <AutoComplete
            options={modelOptions}
            placeholder="deepseek-chat / gpt-4o-mini / qwen-plus"
          />
        </Form.Item>
        <Form.Item name="timeoutMs" label="对话超时（秒）" tooltip="AI 助手对话的最长等待时间。响应慢的模型可适当调大，默认 120 秒">
          <NumberUnitInput min={30} max={600} step={30} unit="秒" />
        </Form.Item>
        <Form.Item name="maxTokens" label="最大输出" tooltip="AI 单次回复的最大长度。批量整理模板等长输出场景可调大，但不得超过所使用模型的上限。默认 384K（=393216 tokens）">
          <NumberUnitInput min={1} max={384} step={1} unit="K tokens" />
        </Form.Item>
        <Form.Item name="contextWindow" label="模型上下文长度" tooltip="模型支持的最大上下文长度（含输入+输出）。对话历史超过此长度时自动裁剪最早的消息。当前主流模型多为百万级上下文，请按你实际使用的模型参数填写，设置过小会频繁裁剪丢失上下文，过大会触发 API 超限报错。默认 1000K（=1024000 tokens）">
          <NumberUnitInput min={2} max={2048} step={16} unit="K tokens" />
        </Form.Item>
        <div style={{ borderTop: '1px solid var(--line)', margin: '12px 0', paddingTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: 'var(--text)' }}>联网搜索（可选）</div>
          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 8px' }}>
            配置后 AI 助手可主动搜索互联网获取最新信息（近期赛事、最新文档等）。留空则不启用联网。需模型支持 function calling（DeepSeek/GPT/智谱等均支持）。
          </p>
          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 12px' }}>
            还没有 API Key？前往{' '}
            <a onClick={() => openExternal('https://tavily.com')}>Tavily 官网 ↗</a>
            {' '}或{' '}
            <a onClick={() => openExternal('https://brave.com/search/api/')}>Brave Search API ↗</a>
            {' '}注册即可免费获取。
          </p>
        </div>
        <Form.Item name="searchEngine" label="搜索引擎">
          <Select
            options={[
              { value: 'tavily', label: 'Tavily（AI 友好，免费 1000 次/月）' },
              { value: 'brave', label: 'Brave Search（免费 2000 次/月）' },
            ]}
          />
        </Form.Item>
        <Form.Item name="searchApiKey" label="搜索 API Key" tooltip="Tavily：api.tavily.com 注册获取；Brave：api.search.brave.com 注册获取。留空则不启用联网搜索。">
          <Input.Password
            placeholder={
              ai.hasSearchApiKey
                ? `已配置 ${ai.searchApiKeyMasked || '••••••••'} · 留空保持不变，粘贴新值可覆盖`
                : '留空则不启用联网搜索'
            }
          />
        </Form.Item>
        <Space wrap>
          <Button type="primary" onClick={onSave}>
            保存 AI 配置
          </Button>
          <Button icon={<ApiOutlined />} loading={testing} onClick={onTest}>
            测试连接
          </Button>
          <Button loading={modelsLoading} onClick={onFetchModels}>
            获取可用模型
          </Button>
        </Space>
        {testResult && (
          <Alert
            style={{ marginTop: 12, maxWidth: 520 }}
            type={testResult.ok ? 'success' : 'error'}
            showIcon
            closable
            message={testResult.message}
          />
        )}
      </Form>
    </Card>
  )
}

/** 「导出提示词 → 手动喂给任意 AI → 导入」闭环的导入弹窗：粘贴/上传 AI 返回的 JSON 文本。 */
function ImportPlanModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntdApp.useApp()
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const v = (await form.validateFields().catch(() => null)) as unknown as {
      raw: string
      startDate: Dayjs
      days: number
    } | null
    if (!v) return
    setBusy(true)
    try {
      const r = await post<{ planId: number; title: string; taskCount: number }>('/api/plans/import', {
        raw: v.raw,
        startDate: v.startDate.format('YYYY-MM-DD'),
        days: v.days,
      })
      message.success(`已导入「${r.title}」（${r.taskCount} 个任务），到「训练计划」页查看`)
      form.resetFields()
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="导入 AI 计划"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="导入"
      cancelText="取消"
      confirmLoading={busy}
      width={620}
      /* antd Modal 默认懒渲染：首次打开前这里的 <Form form={form}> 不挂载，而 form 实例
         已经由本组件的 Form.useForm() 创建 → 每次进设置页刷一条「未连接」告警。
         forceRender 让内容提前挂载（代价是设置页多一个隐藏表单），告警清零。 */
      forceRender
    >
      <Alert
        style={{ marginBottom: 12 }}
        type="info"
        showIcon
        message="把任意 AI 返回的计划 JSON 粘贴到下面（代码块围栏、前后解释文字均可，会自动清洗）；任务缺链接时自动按题库补链。"
      />
      <Form form={form} layout="vertical">
        <Form.Item
          name="raw"
          label="AI 返回的计划 JSON"
          rules={[{ required: true, message: '请粘贴 AI 返回的内容' }]}
        >
          <Input.TextArea
            rows={10}
            placeholder={'```json\n{\n  "title": "...",\n  "goal": "...",\n  "tasks": [{ "date": "YYYY-MM-DD", "title": "...", "kind": "practice", "url": "..." }]\n}\n```'}
          />
        </Form.Item>
        <Space size="large" wrap>
          <Form.Item
            name="startDate"
            label="计划开始日期（用于校验任务日期范围）"
            initialValue={dayjs()}
            rules={[{ required: true }]}
          >
            <DatePicker />
          </Form.Item>
          <Form.Item name="days" label="计划天数" initialValue={14} rules={[{ required: true }]}>
            <InputNumber min={1} max={90} />
          </Form.Item>
          <Form.Item label="或上传 .json / .md 文件">
            <Upload
              maxCount={1}
              showUploadList={false}
              beforeUpload={(file) => {
                const reader = new FileReader()
                reader.onload = () => form.setFieldsValue({ raw: String(reader.result ?? '') })
                reader.readAsText(file)
                return false // 阻止自动上传，仅读文件内容
              }}
            >
              <Button icon={<UploadOutlined />}>选择文件</Button>
            </Upload>
          </Form.Item>
        </Space>
      </Form>
    </Modal>
  )
}

/** 恢复点条目（GET /api/backups） */
interface BackupItem {
  file: string
  reason: string
  createdAtMs: number
  size: number
  /** 是否带知识点标注快照；false（升级前的旧备份）表示恢复后标注不会回退 */
  knowledge?: boolean
}

/** 知识点管线设置卡：统计置信度阈值 + 切换期双口径对比（tag vs 知识点弱项）。 */
function KnowledgePipelineCard() {
  const { message } = AntdApp.useApp()
  const [threshold, setThreshold] = useState(0.6)
  const [saving, setSaving] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [compare, setCompare] = useState<KnowledgeCompareReport | null>(null)
  const [compareLoading, setCompareLoading] = useState(false)

  useEffect(() => {
    get<KnowledgeCoverage>('/api/knowledge/coverage')
      .then((c) => setThreshold(c.threshold))
      .catch(() => { /* 服务端未升级时忽略 */ })
  }, [])

  const saveThreshold = async (v: number) => {
    setSaving(true)
    try {
      const r = await post<{ threshold: number }>('/api/knowledge/threshold', { value: v })
      setThreshold(r.threshold)
      message.success(`阈值已保存：${r.threshold}（掌握度地图、题单统计、覆盖率已标注数、双口径对比未覆盖桶即时生效；弱项画像不受此阈值影响）`)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const openCompare = async () => {
    setCompareOpen(true)
    setCompareLoading(true)
    try {
      setCompare(await get<KnowledgeCompareReport>('/api/knowledge/compare'))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setCompareLoading(false)
    }
  }

  const renderCaliber = (items: KnowledgeCompareReport['knowledgeCaliber']) => (
    <List
      size="small"
      dataSource={items}
      locale={{ emptyText: '暂无数据（提交数不足）' }}
      renderItem={(it) => (
        <List.Item>
          <span style={{ flex: 1 }}>{it.tag}</span>
          <span className="mono" style={{ color: 'var(--text-3)' }}>
            {it.attempts} 提交 · AC {pct(it.acRate)} · 差 {pct(it.gap)}
          </span>
        </List.Item>
      )}
    />
  )

  return (
    <Card title={<span className="settings-section-title"><DatabaseOutlined />知识点管线</span>} size="small">
      <div style={{ maxWidth: 480 }}>
        <div style={{ marginBottom: 4 }}>
          统计置信度阈值：<strong>{threshold.toFixed(2)}</strong>
        </div>
        <Slider
          min={0}
          max={1}
          step={0.05}
          marks={{ 0: '0', 0.5: '0.5', 1: '1' }}
          value={threshold}
          disabled={saving}
          onChange={(v) => setThreshold(v)}
          onChangeComplete={(v) => void saveThreshold(v)}
        />
      </div>
      <Space wrap style={{ marginTop: 8 }}>
        <Button onClick={() => void openCompare()}>双口径对比（tag vs 知识点）</Button>
        <span className="muted-note">
          阈值过滤低置信标注，只影响统计口径，不删标注数据；双口径对比用于切换期观察两种统计的弱项差异。
          题库页「知识点管线」按钮可跑批跑/人工校正。
        </span>
      </Space>

      <Modal
        title="双口径对比：题源 tag 口径 vs 自建知识点口径（弱项 Top）"
        open={compareOpen}
        onCancel={() => setCompareOpen(false)}
        footer={null}
        width={880}
      >
        <Spin spinning={compareLoading}>
          {compare && (
            <>
              <Row gutter={24}>
                <Col span={12}>
                  <div className="settings-section-title" style={{ marginBottom: 8 }}>题源 tag 口径</div>
                  {renderCaliber(compare.tagCaliber)}
                </Col>
                <Col span={12}>
                  <div className="settings-section-title" style={{ marginBottom: 8 }}>
                    知识点口径（阈值 {compare.threshold}）
                  </div>
                  {renderCaliber(compare.knowledgeCaliber)}
                </Col>
              </Row>
              {compare.uncovered && (
                <Alert
                  style={{ marginTop: 12 }}
                  type="info"
                  showIcon
                  message={`未覆盖桶：${compare.uncovered.attempts} 次提交所属题目无达标知识点标注（统计端回退题源 tag），AC 率 ${pct(compare.uncovered.acRate)}。跑管线可提高覆盖率。`}
                />
              )}
            </>
          )}
        </Spin>
      </Modal>
    </Card>
  )
}

const BACKUP_REASON_LABEL: Record<string, string> = {
  manual: '手动',
  daily: '每日',
  'pre-upgrade': '升级前',
  'pre-import': '导入前',
  'pre-reset': '重置前',
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/** 备份与恢复点：每日首次启动 / 升级前 / 大批量导入前 / 换账号重置前自动创建；恢复重启后生效。
 *  refreshKey 变化（如设置页删号新建了恢复点）时重新拉取，避免列表停在页面加载时的快照 */
function BackupCard({ refreshKey = 0 }: { refreshKey?: number }) {
  const { message, modal } = AntdApp.useApp()
  const [backups, setBackups] = useState<BackupItem[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)

  const load = () => {
    setLoading(true)
    get<{ backups: BackupItem[] }>('/api/backups')
      .then((d) => setBackups(d.backups))
      .catch((e) => message.error((e as Error).message))
      .finally(() => setLoading(false))
  }
  useEffect(load, [message, refreshKey])

  const createNow = async () => {
    setCreating(true)
    try {
      const r = await post<{ file: string }>('/api/backups')
      message.success(`已创建恢复点 ${r.file}`)
      load()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setCreating(false)
    }
  }

  const confirmRestore = (b: BackupItem) => {
    modal.confirm({
      title: '恢复此备份？',
      width: 480,
      content: (
        <div style={{ fontSize: 13 }}>
          <p>数据库将回滚到 {new Date(b.createdAtMs).toLocaleString()}（{BACKUP_REASON_LABEL[b.reason] ?? b.reason}，{formatBytes(b.size)}）。</p>
          <p style={{ color: 'var(--red)' }}>备份之后产生的同步、打卡、复习等数据会丢失。恢复在重启应用后生效。</p>
          {b.knowledge === false ? (
            <p style={{ color: 'var(--red)' }}>
              该恢复点不含知识点标注快照（升级前的旧备份）：数据库会回滚，但知识点标注不会被回退。
            </p>
          ) : (
            <p style={{ color: 'var(--text-3)' }}>数据库与知识点标注（annotations.jsonl）会一起回滚到该时间点。</p>
          )}
        </div>
      ),
      okText: '登记恢复（重启生效）',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await post(`/api/backups/${encodeURIComponent(b.file)}/restore`)
          message.warning('已登记恢复请求：请重启应用以完成回滚')
        } catch (e) {
          message.error((e as Error).message)
        }
      },
    })
  }

  // 删除单个恢复点（连带其知识点伴生快照）：避免长期使用后备份堆积占用磁盘
  const removeBackup = async (b: BackupItem) => {
    try {
      await del(`/api/backups/${encodeURIComponent(b.file)}`)
      message.success(`已删除恢复点 ${b.file}`)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <Card title={<span className="settings-section-title"><DatabaseOutlined />备份与恢复点</span>} size="small">
      <Space style={{ marginBottom: 8 }} wrap>
        <Button onClick={() => void createNow()} loading={creating}>
          立即备份
        </Button>
        <span style={{ color: 'var(--text-3)', fontSize: 12 }}>
          自动备份时机：每日首次启动、应用升级前、大批量导入前、换账号重置前；恢复需重启应用生效；备份可手动删除。
        </span>
      </Space>
      <List
        size="small"
        loading={loading}
        dataSource={backups}
        locale={{ emptyText: '暂无备份' }}
        renderItem={(b) => (
          <List.Item
            actions={[
              <Button key="restore" size="small" color="green" variant="outlined" onClick={() => confirmRestore(b)}>
                恢复
              </Button>,
              <Popconfirm
                key="delete"
                title="删除此备份？"
                description="将删除备份文件及其知识点快照，删除后不可找回。"
                okText="删除"
                cancelText="取消"
                onConfirm={() => void removeBackup(b)}
              >
                <Button size="small" type="text" danger icon={<DeleteOutlined />} />
              </Popconfirm>,
            ]}
          >
            <Space size={8} wrap>
              <Tag>{BACKUP_REASON_LABEL[b.reason] ?? b.reason}</Tag>
              {b.knowledge === false && <Tag color="warning">不含知识点快照</Tag>}
              <span style={{ fontSize: 12 }}>{new Date(b.createdAtMs).toLocaleString()}</span>
              <span style={{ color: 'var(--text-3)', fontSize: 12 }}>{formatBytes(b.size)}</span>
            </Space>
          </List.Item>
        )}
      />
    </Card>
  )
}
