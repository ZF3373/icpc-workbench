import { useEffect, useRef, useState } from 'react'
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
import { ApiOutlined, DeleteOutlined, ImportOutlined, PlusOutlined, RobotOutlined, UploadOutlined, UserOutlined, BellOutlined, FileMarkdownOutlined, LinkOutlined, DatabaseOutlined } from '@ant-design/icons'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import type { PlatformId } from '../../../shared/src/index.ts'
import { PLATFORMS, cookieFieldsOf } from '../../../shared/src/index.ts'
import PageHeader from '../components/PageHeader'
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

// 凭据字段表**只有一份**：shared/src/credentials.ts 的 COOKIE_FIELDS。
// 这里（以及任何客户端文件）不得再定义本地字段表——历史缺陷：字段表上移 shared 后
// 设置页残留一份旧表（QOJ 仍是 session/clearance/ua 三字段），保存时发出已废弃的
// `session`，被服务端按共享表校验拒绝（400 未知 Cookie 字段: session），保存按钮失效，
// 且表单渲染出与说明文字口径矛盾的输入框。守卫见 client/test/credentialsTable.test.ts。


export default function Settings() {
  const { message, modal } = AntdApp.useApp()
  const { preference, setPreference } = useTheme()
  const [data, setData] = useState<SettingsData | null>(null)
  const [aiForm] = Form.useForm()
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
  /** 服务端已落库的同步上限/续拉轮数：数字框「停手才落库」，清空（null）时用它恢复显示而不是误存 */
  const savedSyncMax = useRef(300)
  const savedSyncRounds = useRef(3)
  const syncMaxTimer = useRef<number | null>(null)
  const syncRoundsTimer = useRef<number | null>(null)

  const load = () => {
    get<SettingsData>('/api/settings')
      .then((d) => {
        setData(d)
        aiForm.setFieldsValue({ ...d.ai, apiKey: '', timeoutMs: d.ai.timeoutMs ? d.ai.timeoutMs / 1000 : 120, maxTokens: Math.round((d.ai.maxTokens ?? 393216) / 1024), contextWindow: Math.round((d.ai.contextWindow ?? 1024000) / 1024), searchEngine: d.ai.searchEngine ?? 'tavily', searchApiKey: '' })
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
      .catch((e: Error) => message.error(e.message))
  }

  useEffect(load, [aiForm])

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

  if (!data) return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />

  const saveAi = async () => {
    const v = await aiForm.validateFields().catch(() => null)
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
    const v = aiForm.getFieldsValue()
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
    const v = aiForm.getFieldsValue()
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

  // 单账号启停：停用后不参与同步，历史数据保留
  const toggleAccountEnabled = async (platform: PlatformId, handle: string, enabled: boolean) => {
    try {
      await post('/api/settings/accounts/enabled', { platform, handle, enabled })
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const toggleAdapter = async (platform: PlatformId, enabled: boolean) => {
    try {
      await post('/api/settings/adapters', { platform, enabled })
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /** 落库单次同步上限。onChange 只即时回显，停手 600ms 才提交——逐键 POST 会把打字中间值
   *  （必然经过 <100 的前缀）发给服务端吃 400 连环报错，还会把响应值写回输入框导致跳字 */
  const commitSyncMax = async (n: number) => {
    try {
      const r = await post<{ maxSubmissions: number }>('/api/settings/sync', { maxSubmissions: n })
      savedSyncMax.current = r.maxSubmissions
      setSyncMax(r.maxSubmissions)
    } catch (e) {
      message.error((e as Error).message)
      setSyncMax(savedSyncMax.current)
    }
  }
  const saveSyncMax = (v: number | null) => {
    setSyncMax(v)
    if (syncMaxTimer.current !== null) window.clearTimeout(syncMaxTimer.current)
    syncMaxTimer.current = window.setTimeout(() => {
      syncMaxTimer.current = null
      // 清空输入框不落库：恢复服务端已落库值（旧行为会误把 500 存进去）
      if (v == null) setSyncMax(savedSyncMax.current)
      else void commitSyncMax(v)
    }, 600)
  }

  /** 保存后台续拉轮数（0 = 关闭）。POST /api/settings/sync 要求 maxSubmissions 必填，
   *  故带上服务端已落库的上限值（而不是正在编辑中的本地值）；同样停手才提交 */
  const commitSyncRounds = async (v: number) => {
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
    }
  }
  const saveSyncRounds = (v: number | null) => {
    setSyncRounds(v)
    if (syncRoundsTimer.current !== null) window.clearTimeout(syncRoundsTimer.current)
    syncRoundsTimer.current = window.setTimeout(() => {
      syncRoundsTimer.current = null
      // 清空输入框不落库，保留原值（避免误把轮数写成 0 = 关闭）
      if (v == null) setSyncRounds(savedSyncRounds.current)
      else void commitSyncRounds(v)
    }, 600)
  }

  /** 计蒜客「同步自由练题提交」开关：落库 settings['jisuanke.practiceSync']（'true'/'false'） */
  const savePracticeSync = async (v: boolean) => {
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
      await saveReminder(false, reminderTime)
      return
    }
    // 开启需授权浏览器系统通知（点击开关即用户手势，授权弹窗不会被浏览器拦截）
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') {
        message.warning('未授权系统通知，仅会在页面内弹出提醒')
      }
    }
    await saveReminder(true, reminderTime)
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
          <div style={{ fontSize: 12, color: '#8993a2', marginBottom: 2 }}>账号名</div>
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
            <div style={{ fontSize: 12, color: '#8993a2', marginBottom: 4 }}>
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
                    {!aCheck.ok && <span style={{ fontSize: 12, color: '#8993a2' }}>{aCheck.message}</span>}
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
                    <div style={{ fontSize: 12, color: '#8993a2', marginBottom: 2 }}>
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
            <span className="mono" style={{ fontSize: 12, color: '#8993a2' }}>
              {account.last_sync_at ? `上次同步 ${relativeTimeText(account.last_sync_at)}` : '从未同步'}
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: '#8993a2' }}>参与同步</span>
            <Switch
              size="small"
              checked={account.enabled === 1}
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
      <Row gutter={[16, 24]}>
      <Col xs={24} lg={12}>
        <Card title={<span className="settings-section-title"><RobotOutlined />AI 配置（OpenAI 兼容接口）</span>} size="small">
          <Form form={aiForm} layout="vertical">
            <Form.Item name="enabled" label="启用 AI 生成" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="baseURL" label="Base URL" rules={[{ required: true, message: '必填' }]}>
              <Input placeholder="https://api.deepseek.com/v1" />
            </Form.Item>
            <Form.Item name="apiKey" label="API Key">
              <Input.Password
                placeholder={
                  data?.ai.hasApiKey
                    ? `已配置 ${data.ai.apiKeyMasked || '••••••••'} · 留空保持不变，粘贴新值可覆盖`
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
              <InputNumber min={30} max={600} step={30} addonAfter="秒" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="maxTokens" label="最大输出" tooltip="AI 单次回复的最大长度。批量整理模板等长输出场景可调大，但不得超过所使用模型的上限。默认 384K（=393216 tokens）">
              <InputNumber min={1} max={384} step={1} addonAfter="K tokens" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="contextWindow" label="模型上下文长度" tooltip="模型支持的最大上下文长度（含输入+输出）。对话历史超过此长度时自动裁剪最早的消息。当前主流模型多为百万级上下文，请按你实际使用的模型参数填写，设置过小会频繁裁剪丢失上下文，过大会触发 API 超限报错。默认 1000K（=1024000 tokens）">
              <InputNumber min={2} max={2048} step={16} addonAfter="K tokens" style={{ width: '100%' }} />
            </Form.Item>
            <div style={{ borderTop: '1px solid var(--border-color, rgba(255,255,255,0.06))', margin: '12px 0', paddingTop: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: 'var(--text-1, #e8eaed)' }}>联网搜索（可选）</div>
              <p style={{ fontSize: 12, color: '#8993a2', margin: '0 0 8px' }}>
                配置后 AI 助手可主动搜索互联网获取最新信息（近期赛事、最新文档等）。留空则不启用联网。需模型支持 function calling（DeepSeek/GPT/智谱等均支持）。
              </p>
              <p style={{ fontSize: 12, color: '#8993a2', margin: '0 0 12px' }}>
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
                  data?.ai.hasSearchApiKey
                    ? `已配置 ${data.ai.searchApiKeyMasked || '••••••••'} · 留空保持不变，粘贴新值可覆盖`
                    : '留空则不启用联网搜索'
                }
              />
            </Form.Item>
            <Space wrap>
              <Button type="primary" onClick={saveAi}>
                保存 AI 配置
              </Button>
              <Button icon={<ApiOutlined />} loading={aiTesting} onClick={testAi}>
                测试连接
              </Button>
              <Button loading={modelsLoading} onClick={fetchModels}>
                获取可用模型
              </Button>
            </Space>
            {aiTestResult && (
              <Alert
                style={{ marginTop: 12, maxWidth: 520 }}
                type={aiTestResult.ok ? 'success' : 'error'}
                showIcon
                closable
                message={aiTestResult.message}
              />
            )}
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
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
                                        ? { background: '#8993a2' }
                                        : { border: '1px solid #5a6472' }),
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
                      <p style={{ margin: '2px 0 0', color: '#d48806', fontSize: 12 }}>
                        ⚠ 多账号请为每个账号分别配置 Cookie：此平台的提交记录跟随 Cookie 登录身份拉取。
                      </p>
                    )}
                    {p.id === 'qoj' && (
                      <p style={{ margin: '2px 0 0', color: '#8993a2', fontSize: 12 }}>
                        qoj.ac 登录后 F12 → Application → Cookies 复制 UOJSESSID 与 cf_clearance（点账号框在卡片里粘贴，
                        也可整段 Cookie 粘进任一框自动分派）；cf_clearance 约 30 分钟过期，过期后重贴该项即可。
                        浏览器 UA 在账号卡片里填写，全部账号共用。
                      </p>
                    )}
                  </>
                ),
              }
            })}
          />
          <div style={{ marginTop: 4 }}>
            <Space>
              <span>单次同步上限</span>
              <InputNumber
                min={100}
                max={1500}
                step={100}
                value={syncMax}
                onChange={(v) => saveSyncMax(v)}
                addonAfter="条"
                style={{ width: 140 }}
              />
              <span className="muted-note">提交记录过多时分批拉取，防触发平台风控封号（默认 300，保守为主）</span>
            </Space>
          </div>
          <div style={{ marginTop: 8 }}>
            <Space wrap>
              <span>后台续拉轮数</span>
              <InputNumber
                min={0}
                max={50}
                step={1}
                value={syncRounds}
                onChange={(v) => void saveSyncRounds(v)}
                addonAfter="轮"
                style={{ width: 140 }}
              />
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
                  <span key={p.id} style={{ whiteSpace: 'nowrap' }}>
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
              <Switch size="small" checked={practiceSync} onChange={(v) => void savePracticeSync(v)} />
              <span className="muted-note">
                开启后同步计蒜客题库（自由练）的提交记录，关闭则只同步比赛提交（默认开启，与旧行为一致）
              </span>
            </Space>
          </div>
        </Card>
      </Col>
      <Col span={24}>
        <Card title={<span className="settings-section-title"><BellOutlined />打卡与赛前提醒</span>} size="small">
          <Space wrap>
            <span>每日提醒</span>
            <Switch checked={reminderEnabled} onChange={toggleReminder} />
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
              <InputNumber
                min={5}
                max={120}
                step={5}
                value={contestReminder.minutesBefore}
                disabled={!contestReminder.enabled}
                onChange={(v) => v && void saveContestReminder({ ...contestReminder, minutesBefore: v })}
                addonAfter="分钟"
                style={{ width: 120 }}
              />
            </Space>
          </div>
          {(() => {
            if (typeof Notification === 'undefined') {
              return <span className="perm-note" style={{ color: '#8993a2' }}>当前浏览器不支持系统通知，仅页面内提醒</span>
            }
            if (Notification.permission === 'granted') {
              return <span className="perm-note" style={{ color: '#69d7a5' }}>系统通知已授权 ✓</span>
            }
            return (
              <span className="perm-note" style={{ color: '#f2c46d' }}>
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
      <Col span={24}>
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
            <span style={{ color: '#8993a2', fontSize: 12 }}>
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
          <span className="mono" style={{ color: '#8993a2' }}>
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
          <p style={{ color: '#d4380d' }}>备份之后产生的同步、打卡、复习等数据会丢失。恢复在重启应用后生效。</p>
          {b.knowledge === false ? (
            <p style={{ color: '#d4380d' }}>
              该恢复点不含知识点标注快照（升级前的旧备份）：数据库会回滚，但知识点标注不会被回退。
            </p>
          ) : (
            <p style={{ color: '#8993a2' }}>数据库与知识点标注（annotations.jsonl）会一起回滚到该时间点。</p>
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
        <span style={{ color: '#8993a2', fontSize: 12 }}>
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
              <span style={{ color: '#8993a2', fontSize: 12 }}>{formatBytes(b.size)}</span>
            </Space>
          </List.Item>
        )}
      />
    </Card>
  )
}
