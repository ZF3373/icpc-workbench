import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Checkbox,
  Collapse,
  DatePicker,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Popover,
  Radio,
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
import type { InputNumberProps } from 'antd'
import { ApiOutlined, DeleteOutlined, ImportOutlined, PlusOutlined, RobotOutlined, UploadOutlined, UserOutlined, BellOutlined, FileMarkdownOutlined, LinkOutlined, DatabaseOutlined } from '@ant-design/icons'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import type { PlatformId } from '../../../shared/src/index.ts'
import { PLATFORMS, cookieFieldsOf } from '../../../shared/src/index.ts'
import { AI_PROVIDER_PRESETS, AI_PROVIDER_CUSTOM_PRESET, AI_PROVIDERS_MAX, AI_PROVIDER_MODELS_MAX, MODEL_CAPS_AS_OF, guessModelCaps, type AiProviderModelEntry, type AiProviderView, type ModelCaps } from '../../../shared/src/index.ts'
import { mergePickedModels } from '../aiModelPicker'
import PageHeader from '../components/PageHeader'
import PageSkeleton from '../components/PageSkeleton'
import InlineError from '../components/InlineError'
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
  ai: { enabled: boolean; baseURL: string; apiKey: string; model: string; timeoutMs?: number; maxTokens?: number; contextWindow?: number; searchEngine?: 'tavily' | 'brave'; searchApiKey?: string; hasApiKey?: boolean; hasSearchApiKey?: boolean; apiKeyMasked?: string; searchApiKeyMasked?: string; /** 环境变量 AI_API_KEY 生效中（全局运行时覆盖，不落库） */ apiKeyFromEnv?: boolean; /** 多提供商：当前活跃提供商 id（旧版服务端无此字段） */ activeProviderId?: string; /** 多提供商列表（密钥已打码，原文不下发；旧版服务端无此字段） */ providers?: AiProviderView[]; /** 全局兜底档位（不含提供商覆盖）：提供商参数留空时回退到这里 */ globalMaxTokens?: number; globalContextWindow?: number }
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

  // 卸载时清掉防抖定时器，避免设置页卸载后仍触发 setState 或打到已卸载组件
  useEffect(
    () => () => {
      if (scaleSaveTimer.current !== null) window.clearTimeout(scaleSaveTimer.current)
    },
    [],
  )

  if (!data) {
    // 骨架屏占住「页头 + 表单卡」的结构：旧实现是整页居中 Spin，从转圈跳到满屏表单时位移明显
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

  // AI 配置保存：全局项（表单）与多提供商列表（卡片内部状态）由卡片统一收集成请求体；
  // 返回 null = 校验未过（卡片内部已给出具体错误提示），父组件只负责提交与结果反馈。
  const saveAi = async () => {
    const payload = await aiFormHandle().collectSavePayload()
    if (!payload) return
    try {
      await post('/api/settings/ai', payload)
      message.success('AI 配置已保存')
      // 已提交的密钥草稿就地清空（load() 不会重建草稿——见卡片同步 effect 的草稿保护）
      aiFormHandle().clearSubmittedApiKeys()
      load()
    } catch (e) {
      message.error((e as Error).message)
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
      <div className="settings-body">
      <Row gutter={[16, 24]}>
      <Col xs={24} lg={12} id="settings-ai">
        {/* AI 配置表单是独立子组件：form 实例必须在**表单本身挂载时**创建。
            旧实现把 Form.useForm() 放在本页顶部（数据还没到、Form 还没挂载：
            首屏 !data 早退渲染骨架，这里根本不渲染），于是每次进设置页都刷一条
            「Instance created by `useForm` is not connected to any Form element」告警，
            持续掩盖真实错误信号。下沉到子组件后实例与 Form 同生，告警消失。 */}
        <AiSettingsCard
          ref={aiForm}
          ai={data.ai}
          onSave={saveAi}
        />
      </Col>
      <Col xs={24} lg={12} id="settings-accounts">
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
          <div id="settings-sync">
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
      <Col span={24} id="settings-reminder">
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
      <Col span={24} id="settings-data">
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
  size,
  ...rest
}: Omit<InputNumberProps<number>, 'addonAfter'> & { unit: string }) {
  return (
    <Space.Compact block className={className}>
      <InputNumber<number> {...rest} size={size} style={{ width: '100%', ...rest.style }} />
      <Button disabled className="compact-unit" size={size}>
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
 * 结构（多提供商改造后）：
 * - 全局项走 antd Form（启用开关 / 对话参数 / 联网搜索），`validateFields` 校验；
 * - 提供商列表走卡片内部 React 状态（每家：预设 / API 密钥 / API 地址 / 默认模型），
 *   因为「N 个提供商 × 动态增删」塞进一份 Form 会把字段路径搞得很脆，手写状态反而直观；
 * - 对外通过 ref 暴露 `collectSavePayload`：一次「保存 AI 配置」把全局项 + 提供商列表
 *   一起收集、校验成请求体（提供商密钥留空 = 保持已存值，语义与服务端缺省合并对齐）。
 */

/** 卡片内正在编辑的一个提供商草稿（apiKey 只装「本次新输入」；'' = 未改动，保存时不下发） */
type ProviderDraft = {
  id: string
  /** 所选预设（AI_PROVIDER_PRESETS 的 key；'custom' = 自定义） */
  presetKey: string
  name: string
  baseURL: string
  model: string
  apiKey: string
  hasApiKey: boolean
  apiKeyMasked: string
  /** 该提供商单独设置的输出上限（token）；undefined = 留空，运行时回退全局默认 */
  maxTokens?: number
  /** 该提供商单独设置的上下文窗口（token）；undefined = 留空，运行时回退全局默认 */
  contextWindow?: number
  /** 自动填写已生效的模型名：同一模型不重复覆盖（用户改过的数值得以保留） */
  capsModel?: string
  /** 模型目录（对齐 dsh 的模型管理）：候选清单 + 条目级参数；条目参数优先于提供商级生效 */
  models: AiProviderModelEntry[]
}

type AiFormValues = {
  enabled: boolean
  timeoutMs: number
  searchEngine: 'tavily' | 'brave'
  searchApiKey: string
}

export type AiSettingsCardHandle = {
  validateFields: () => Promise<AiFormValues>
  /** 收集「全局项 + 提供商列表」的保存请求体；校验失败（表单或提供商）返回 null 并已就地提示 */
  collectSavePayload: () => Promise<Record<string, unknown> | null>
  /** 保存成功后清空「本次新输入」的密钥草稿（输入的清空只发生在保存动作成功后，全局刷新不碰草稿） */
  clearSubmittedApiKeys: () => void
  resetFields: () => void
}

/** 服务端已存提供商视图 → 编辑草稿（密钥原文不下发，草稿里 apiKey 恒从空开始） */
function draftOf(p: AiProviderView): ProviderDraft {
  // 预设回显：baseURL 命中内置预设就显示该预设（用户改名不影响），否则归为「自定义」
  const preset = AI_PROVIDER_PRESETS.find((x) => x.baseURL === p.baseURL)
  return {
    id: p.id,
    presetKey: preset?.key ?? 'custom',
    name: p.name,
    baseURL: p.baseURL,
    model: p.model,
    apiKey: '',
    hasApiKey: p.hasApiKey,
    apiKeyMasked: p.apiKeyMasked,
    maxTokens: p.maxTokens,
    contextWindow: p.contextWindow,
    // 服务端已带参数 → 标记「该模型已填过」，失焦不重填（保住用户已调的值）
    capsModel: p.maxTokens !== undefined || p.contextWindow !== undefined ? p.model : undefined,
    models: p.models ? p.models.map((m) => ({ ...m })) : [],
  }
}

/** 参数档位 → 草稿补丁（只填表里有的字段，避免用 undefined 冲掉已有值） */
function capsPatch(caps: ModelCaps): Partial<ProviderDraft> {
  return {
    ...(caps.maxTokens !== undefined ? { maxTokens: caps.maxTokens } : {}),
    ...(caps.contextWindow !== undefined ? { contextWindow: caps.contextWindow } : {}),
  }
}

/** 新提供商 id：时间戳 + 随机尾巴，够唯一且肉眼可读 */
function newProviderId(): string {
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** 「当前使用」下拉的选项值分隔符：值 = `提供商id::模型名`（id 由 newProviderId 生成，不含冒号） */
const ACTIVE_PICKER_SEP = '::'

const AiSettingsCard = ({
  ref,
  ai,
  onSave,
}: {
  ref: Ref<AiSettingsCardHandle>
  ai: SettingsData['ai']
  onSave: () => void
}) => {
  const { message } = AntdApp.useApp()
  const [form] = Form.useForm<AiFormValues>()

  // ---- 提供商编辑状态（整表草稿，点「保存 AI 配置」一次性提交） ----
  const [providers, setProviders] = useState<ProviderDraft[]>([])
  const [activeId, setActiveId] = useState('')
  /** 展开的提供商面板（新增提供商时自动展开它的编辑面板） */
  const [openPanels, setOpenPanels] = useState<string[]>([])
  /** 每家提供商的「获取可用模型」结果（providerId → 模型名下拉选项） */
  const [modelOptionsBy, setModelOptionsBy] = useState<Record<string, { value: string }[]>>({})
  /** 每家提供商的模型真实参数档位（providerId → 模型名 → caps；来自网关 /models 响应） */
  const [capsBy, setCapsBy] = useState<Record<string, Record<string, ModelCaps>>>({})
  /** 「获取可用模型」勾选弹窗（对齐 dsh 的 model picker）：providerId + 候选；null = 关闭 */
  const [picker, setPicker] = useState<{ providerId: string; providerName: string; candidates: Array<{ id: string; caps?: ModelCaps }> } | null>(null)
  /** 弹窗里勾选的模型 id 集合；打开时默认勾选「目录里还没有的」 */
  const [pickedIds, setPickedIds] = useState<Set<string>>(() => new Set())
  const [pickerQuery, setPickerQuery] = useState('')
  /** 每家提供商的测试连接 / 拉模型 loading 与结果（同一提供商一个 key，互不闪烁） */
  const [testingBy, setTestingBy] = useState<Record<string, boolean>>({})
  const [testResultBy, setTestResultBy] = useState<Record<string, { ok: boolean; message: string } | undefined>>({})
  const [fetchingBy, setFetchingBy] = useState<Record<string, boolean>>({})

  const storedIds = new Set((ai.providers ?? []).map((p) => p.id))

  /** 同步护栏：首挂载全量对齐后，后续 load() 只做结构对账（见下方同步 effect） */
  const syncedOnce = useRef(false)
  /** 最近一次同步时服务端已有的提供商 id（区分「未保存的新增草稿」与「已在别处删除的提供商」） */
  const storedIdsRef = useRef<Set<string>>(new Set())
  /** 本地已删但服务端还挂着的提供商 id：未保存的删除，不让无关 load() 把它复活 */
  const locallyDeletedRef = useRef<Set<string>>(new Set())

  // 服务端值 → 表单/草稿同步：首挂载全量对齐；此后只做「结构对账」，绝不整体重建草稿。
  // ⚠ 本页任何一处无关保存/开关/绑定成功后的 load() 都会产生新的 `ai` 引用——草稿若跟着
  // 重建，用户正在编辑的半成品（密钥/地址/模型/参数，乃至尚未保存的新增提供商）会被静默
  // 清掉，且表单里未保存的启用/超时/搜索 Key 一并重置。与本页 cookieInputs/acctInputs 的
  // 历史缺陷同款：输入的清空只发生在对应动作成功后的局部 setState（saveAi 成功 → 清本次
  // 已提交的密钥草稿，见 clearSubmittedApiKeys），全局刷新一律不碰输入。
  useEffect(() => {
    const serverList = ai.providers ?? []
    const serverIds = new Set(serverList.map((p) => p.id))
    if (!syncedOnce.current) {
      syncedOnce.current = true
      form.setFieldsValue({
        enabled: ai.enabled,
        timeoutMs: ai.timeoutMs ? ai.timeoutMs / 1000 : 120,
        searchEngine: ai.searchEngine ?? 'tavily',
        searchApiKey: '',
      })
      setProviders(serverList.map(draftOf))
      setActiveId(ai.activeProviderId || serverList[0]?.id || '')
      storedIdsRef.current = serverIds
      return
    }
    // 结构对账：服务端新增 → 补建草稿；本地删过且还没保存 → 不复活；
    // 已存提供商的既有草稿内容一律不动（那可能是用户没保存的编辑）
    for (const id of [...locallyDeletedRef.current]) {
      // 删除已随某次保存落库（服务端清单里也消失了）→ 停止跟踪
      if (!serverIds.has(id)) locallyDeletedRef.current.delete(id)
    }
    const prevStoredIds = storedIdsRef.current
    storedIdsRef.current = serverIds
    setProviders((cur) => {
      const curById = new Map(cur.map((p) => [p.id, p]))
      const next: ProviderDraft[] = serverList
        .filter((p) => !locallyDeletedRef.current.has(p.id))
        .map((p) => {
          const d = curById.get(p.id)
          if (!d) return draftOf(p)
          // hasApiKey / apiKeyMasked 是服务端权威的展示字段（草稿里不可编辑）：保存成功后
          // 跟着服务端刷新，避免「已存密钥」徽标停在旧值；其余字段保持草稿（未保存的编辑）
          return d.hasApiKey === p.hasApiKey && d.apiKeyMasked === p.apiKeyMasked
            ? d
            : { ...d, hasApiKey: p.hasApiKey, apiKeyMasked: p.apiKeyMasked }
        })
      // 服务端没有、上一次同步时也没有 = 还没保存的新增草稿，保留
      for (const d of cur) {
        if (!serverIds.has(d.id) && !prevStoredIds.has(d.id)) next.push(d)
      }
      const same =
        next.length === cur.length && next.every((p, i) => p === cur[i])
      return same ? cur : next
    })
  }, [ai, form])

  const patchProvider = (id: string, patch: Partial<ProviderDraft>) => {
    setProviders((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  /**
   * 设为当前使用（提供商 + 模型）：一步到位，不必展开面板去模型目录里点 radio 再滚到底保存。
   * 本地草稿同步跟随（activeId + 该提供商的 model），已存库的提供商同时写库、AI 请求立即生效；
   * 尚未保存的新增提供商服务端还不认识（按 id 切换会 404），只改草稿并提示先保存。
   */
  const activateModel = async (id: string, model: string) => {
    const target = providers.find((p) => p.id === id)
    if (!target) return
    setActiveId(id)
    if (model !== '') patchProvider(id, { model })
    if (!storedIds.has(id)) {
      message.info(`提供商「${target.name}」还没保存，点下方「保存 AI 配置」后即可使用`)
      return
    }
    try {
      await post('/api/settings/ai/providers/active', { id, model })
      message.success(`当前使用：${target.name} · ${model}`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /** 「当前使用」下拉候选：按提供商分组，组内是该提供商的可选模型（目录 + 目录外当前模型）。
   *  框里显示「提供商 · 模型」（display），下拉里只列模型名（label），避免整组重复前缀；
   *  searchText 带上提供商名，这样搜「大工」也能定位到它那组。 */
  const activePickerOptions = providers.map((p) => {
    const groupLabel = storedIds.has(p.id) ? p.name : `${p.name}（未保存）`
    const ids = [...new Set([p.model.trim(), ...p.models.map((m) => m.id.trim())].filter((x) => x !== ''))]
    return {
      label: groupLabel,
      options:
        ids.length === 0
          ? [{ value: `${p.id}${ACTIVE_PICKER_SEP}`, label: '还没有可选模型', display: groupLabel, disabled: true }]
          : ids.map((id) => ({
              value: `${p.id}${ACTIVE_PICKER_SEP}${id}`,
              label: id,
              display: `${p.name} · ${id}`,
              searchText: `${p.name} ${id}`,
            })),
    }
  })
  const activeDraft = providers.find((p) => p.id === activeId)
  /** 当前选中的模型不在目录里时也要能回显，所以候选含 p.model；模型为空（还没填）→ 显示占位 */
  const activePickerValue =
    activeDraft && activeDraft.model.trim() !== ''
      ? `${activeId}${ACTIVE_PICKER_SEP}${activeDraft.model.trim()}`
      : undefined

  /** 点眼睛按需取回该提供商已存的密钥原文（平时只下发打码版，见 /ai/reveal）：填回输入框后，
   *  眼睛就能正常在明文/掩码间切换。没存过就明确提示——环境变量 AI_API_KEY 从不落库，
   *  服务端也不会把它当该提供商的密钥下发，否则一次保存就把它写进了 settings。 */
  const revealProviderKey = async (p: ProviderDraft) => {
    if (!storedIds.has(p.id)) {
      message.info('该提供商还没保存，没有可显示的密钥')
      return
    }
    try {
      const r = await post<{ value: string }>('/api/settings/ai/reveal', { providerId: p.id })
      if (r.value) {
        patchProvider(p.id, { apiKey: r.value })
        return
      }
      message.info(
        ai.apiKeyFromEnv
          ? '该提供商没单独存过密钥，用的是环境变量 AI_API_KEY（不落库，无法显示）'
          : '该提供商还没有保存过密钥',
      )
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /** 搜索密钥同款按需回显（值存在 antd Form 里，取回后写回字段） */
  const revealSearchApiKey = async () => {
    try {
      const r = await post<{ value: string }>('/api/settings/ai/reveal', { target: 'searchApiKey' })
      if (r.value) {
        form.setFieldsValue({ searchApiKey: r.value })
        return
      }
      message.info('还没有可显示的搜索密钥')
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /**
   * 自动智能填写参数档位（触发：预设切换 / 行内模型 ID 失焦）。
   * 优先用网关返回的真实档位（获取过可用模型时），否则查内置参数表；两边都没有
   * （本地模型/小众网关）就不动。落点：模型在目录里 → 只填「没有参数的条目」
   * （用户调过的条目不覆盖，对齐 dsh）；目录外 → 落到提供商级（「目录外」行可见可改）。
   * capsModel 记录已填过的模型名，同一模型不重复覆盖。
   */
  const autoFillCaps = (id: string, rawModel: string) => {
    const model = rawModel.trim()
    if (!model) return
    setProviders((ps) =>
      ps.map((p) => {
        if (p.id !== id || p.capsModel === model) return p
        const caps = capsBy[id]?.[model] ?? guessModelCaps(model)
        if (!caps || (caps.maxTokens === undefined && caps.contextWindow === undefined)) return p
        const entry = p.models.find((m) => m.id === model)
        if (entry) {
          // 条目已有参数 → 视为用户调过，只登记不覆盖
          if (entry.maxTokens !== undefined || entry.contextWindow !== undefined) return { ...p, capsModel: model }
          return {
            ...p,
            capsModel: model,
            models: p.models.map((m) => (m.id === model ? { ...m, ...capsPatch(caps) } : m)),
          }
        }
        return { ...p, capsModel: model, ...capsPatch(caps) }
      }),
    )
  }

  /**
   * 按现行参数表重填档位。
   *
   * 为什么需要手动入口：失焦自动填写（autoFillCaps）只填「还没有参数」的条目，为的是保住用户
   * 调过的值；代价是**老配置里存的旧参数表建议值永远不会被更新**（比如 2026-07 前按 deepseek-chat
   * 128K 存下来的档位）。这里给一个明确的覆盖入口：认得出的模型按现表（网关真实档位优先）重填，
   * 认不出的原样保留，手动调过的值会被覆盖——所以走 Popconfirm 确认。
   */
  const refillCaps = (id: string) => {
    const target = providers.find((p) => p.id === id)
    if (!target) return
    const capsFor = (model: string): ModelCaps | null =>
      capsBy[id]?.[model.trim()] ?? guessModelCaps(model)
    const models = target.models.map((m) => {
      const caps = capsFor(m.id)
      return caps ? { id: m.id, ...capsPatch(caps) } : m
    })
    const activeModel = target.model.trim()
    const activeCaps = activeModel ? capsFor(activeModel) : null
    const hit = target.models.filter((m) => capsFor(m.id)).length + (activeCaps ? 1 : 0)
    setProviders((ps) =>
      ps.map((p) =>
        p.id === id
          ? {
              ...p,
              models,
              ...(activeCaps ? capsPatch(activeCaps) : {}),
              ...(activeCaps ? { capsModel: activeModel } : {}),
            }
          : p,
      ),
    )
    message.success(
      hit > 0
        ? `已按 ${MODEL_CAPS_AS_OF} 参数表重填 ${hit} 个模型的档位（要点「保存 AI 配置」才落库）`
        : '参数表认不出这些模型，档位保持不变',
    )
  }

  /** 「添加模型提供商」弹窗（对齐 dsh 的添加流程）：先选添加方式（第三方目录 / 自定义 API），
   *  明确填写后保存才创建——不静默预建任何默认提供商的草稿 */
  const [addModal, setAddModal] = useState<
    | null
    | { tab: 'preset' | 'custom'; presetKey: string; name: string; baseURL: string; apiKey: string; model: string }
  >(null)

  const openAddModal = () => {
    setAddModal({ tab: 'preset', presetKey: '', name: '', baseURL: '', apiKey: '', model: '' })
  }

  /** 选内置预设：名称 / Base URL / 默认模型一键带入（API 密钥保留用户可能已输入的值） */
  const applyAddPreset = (key: string) => {
    setAddModal((m) => {
      if (!m) return m
      const preset = AI_PROVIDER_PRESETS.find((x) => x.key === key)
      if (!preset) return { ...m, presetKey: '' }
      return { ...m, presetKey: key, name: preset.name, baseURL: preset.baseURL, model: preset.defaultModel }
    })
  }

  const saveAddProvider = () => {
    if (!addModal) return
    if (providers.length >= AI_PROVIDERS_MAX) {
      message.error(`最多配置 ${AI_PROVIDERS_MAX} 个提供商`)
      return
    }
    const isPreset = addModal.tab === 'preset'
    if (isPreset && !addModal.presetKey) {
      message.error('请先选择提供商')
      return
    }
    const baseURL = addModal.baseURL.trim()
    if (!addModal.name.trim()) {
      message.error('请填写提供商名称')
      return
    }
    if (!/^https?:\/\//.test(baseURL)) {
      message.error(`API 地址需为 http(s) 地址，当前：${baseURL || '（空）'}`)
      return
    }
    const presetKey = isPreset ? addModal.presetKey : 'custom'
    const preset = [...AI_PROVIDER_PRESETS, AI_PROVIDER_CUSTOM_PRESET].find((x) => x.key === presetKey) ?? AI_PROVIDER_CUSTOM_PRESET
    const model = addModal.model.trim() || preset.defaultModel
    // 同名不打架：自动追加序号
    let name = addModal.name.trim()
    let n = 2
    while (providers.some((p) => p.name === name)) name = `${addModal.name.trim()} ${n++}`
    const caps = model ? guessModelCaps(model) : null
    const draft: ProviderDraft = {
      id: newProviderId(),
      presetKey,
      name,
      baseURL,
      model,
      apiKey: addModal.apiKey.trim(),
      hasApiKey: false,
      apiKeyMasked: '',
      // 预设提供商：目录带默认清单（含 defaultModel），无需提供商级档位；
      // 自定义网关：目录留空，默认模型走「目录外」行（档位能认出就先垫上）
      models:
        preset.defaultModels.length > 0
          ? preset.defaultModels.map((mid) => ({ id: mid, ...(guessModelCaps(mid) ?? {}) }))
          : [],
      ...(caps && !preset.defaultModels.includes(model) ? capsPatch(caps) : {}),
      ...(caps ? { capsModel: model } : {}),
    }
    setProviders((ps) => [...ps, draft])
    setOpenPanels((k) => [...k, draft.id])
    setAddModal(null)
  }

  const removeProvider = (id: string) => {
    // 记入「本地已删」：服务端清单里它还在，若不跟踪，任何一处无关保存触发的 load()
    // 都会在结构对账时把它复活（未保存的删除也是用户编辑，同样要保护）
    locallyDeletedRef.current.add(id)
    setProviders((ps) => {
      const next = ps.filter((p) => p.id !== id)
      // 删的是当前使用的 → 回退到剩下的第一个（空列表时 activeId 置空，保存前会被校验拦下）
      setActiveId((cur) => (cur === id ? next[0]?.id ?? '' : cur))
      return next
    })
  }

  // ---- 模型目录（对齐 dsh 的模型管理）：行编辑 / 恢复默认 / 勾选添加 ----

  const patchModelEntry = (pid: string, index: number, patch: Partial<AiProviderModelEntry>) => {
    setProviders((ps) =>
      ps.map((p) => (p.id !== pid ? p : { ...p, models: p.models.map((m, i) => (i === index ? { ...m, ...patch } : m)) })),
    )
  }

  const removeModelEntry = (pid: string, index: number) => {
    setProviders((ps) =>
      ps.map((p) => (p.id !== pid ? p : { ...p, models: p.models.filter((_, i) => i !== index) })),
    )
  }

  const addModelEntry = (pid: string) => {
    setProviders((ps) =>
      ps.map((p) => (p.id !== pid ? p : { ...p, models: [...p.models, { id: '' }] })),
    )
  }

  /** 恢复默认模型目录：回到内置预设的默认模型清单（参数按内置参数表补齐），当前使用模型不动 */
  const resetModelCatalog = (pid: string) => {
    setProviders((ps) =>
      ps.map((p) => {
        if (p.id !== pid) return p
        const preset = [...AI_PROVIDER_PRESETS, AI_PROVIDER_CUSTOM_PRESET].find((x) => x.key === p.presetKey)
        if (!preset || preset.defaultModels.length === 0) return p
        return { ...p, models: preset.defaultModels.map((id) => ({ id, ...(guessModelCaps(id) ?? {}) })) }
      }),
    )
  }

  /** 勾选添加：已有条目原样保留（用户调过的参数优先于网关值），新条目带网关档位加入 */
  const adoptPickedModels = () => {
    if (!picker) return
    const pid = picker.providerId
    const target = providers.find((p) => p.id === pid)
    if (!target) {
      setPicker(null)
      return
    }
    // 上限判断前移到采纳动作：否则草稿会超上限、保存时被服务端静默截断，
    // 而界面仍显示全部（结构对账不会回写目录）→ 界面与库永久不一致
    const { models, skipped } = mergePickedModels(target.models, picker.candidates, pickedIds)
    setProviders((ps) => ps.map((p) => (p.id === pid ? { ...p, models } : p)))
    if (skipped > 0) {
      message.warning(
        `模型目录上限 ${AI_PROVIDER_MODELS_MAX} 个：本次加入 ${models.length - target.models.length} 个，` +
        `另有 ${skipped} 个未加入（先移除部分条目再获取即可）`,
      )
    }
    setPicker(null)
  }

  /** 选预设：名称 / Base URL / 默认模型 / 参数档位一键带入；「自定义」保留当前值由用户手填 */
  const applyPreset = (id: string, presetKey: string) => {
    const preset = [...AI_PROVIDER_PRESETS, AI_PROVIDER_CUSTOM_PRESET].find((x) => x.key === presetKey)
    if (!preset) return
    setProviders((ps) =>
      ps.map((p) => {
        if (p.id !== id) return p
        if (presetKey === 'custom') {
          // 从预设切到自定义：名字还挂在预设名上时换成「自定义」，用户改过的名字不动
          const wasPresetName = AI_PROVIDER_PRESETS.some((x) => x.name === p.name)
          return { ...p, presetKey, ...(wasPresetName ? { name: '自定义' } : {}) }
        }
        const caps = guessModelCaps(preset.defaultModel)
        return {
          ...p,
          presetKey,
          name: preset.name,
          baseURL: preset.baseURL,
          model: preset.defaultModel,
          // 换预设 = 换模型 → 参数档位跟随重填（内置参数表口径）
          ...(caps ? { capsModel: preset.defaultModel, ...capsPatch(caps) } : { capsModel: undefined }),
        }
      }),
    )
  }

  /** 测试单个提供商：已存的传 providerId（服务端用已存密钥兜底），未存的全靠表单值 */
  const testProvider = async (p: ProviderDraft) => {
    if (!/^https?:\/\//.test(p.baseURL.trim())) {
      setTestResultBy((m) => ({ ...m, [p.id]: { ok: false, message: 'Base URL 需为 http(s) 地址' } }))
      return
    }
    setTestingBy((m) => ({ ...m, [p.id]: true }))
    setTestResultBy((m) => ({ ...m, [p.id]: undefined }))
    try {
      const r = await post<{ ok: boolean; message: string; models?: string[] }>('/api/settings/ai/test', {
        providerId: storedIds.has(p.id) ? p.id : undefined,
        baseURL: p.baseURL.trim(),
        apiKey: p.apiKey.trim() || undefined,
        model: p.model.trim(),
      })
      setTestResultBy((m) => ({ ...m, [p.id]: r }))
      if (r.models?.length) setModelOptionsBy((mm) => ({ ...mm, [p.id]: r.models!.map((v) => ({ value: v })) }))
    } catch (e) {
      setTestResultBy((m) => ({ ...m, [p.id]: { ok: false, message: (e as Error).message } }))
    } finally {
      setTestingBy((m) => ({ ...m, [p.id]: false }))
    }
  }

  const fetchProviderModels = async (p: ProviderDraft) => {
    if (!/^https?:\/\//.test(p.baseURL.trim())) {
      message.error(`提供商「${p.name}」的 Base URL 需为 http(s) 地址`)
      return
    }
    setFetchingBy((m) => ({ ...m, [p.id]: true }))
    try {
      const r = await post<{ models: string[]; caps?: Record<string, ModelCaps> }>('/api/settings/ai/models', {
        providerId: storedIds.has(p.id) ? p.id : undefined,
        baseURL: p.baseURL.trim(),
        apiKey: p.apiKey.trim() || undefined,
      })
      if (r.models.length === 0) {
        message.warning('服务未返回任何模型')
        return
      }
      setModelOptionsBy((mm) => ({ ...mm, [p.id]: r.models.map((v) => ({ value: v })) }))
      if (r.caps && Object.keys(r.caps).length > 0) {
        setCapsBy((m) => ({ ...m, [p.id]: { ...(m[p.id] ?? {}), ...r.caps! } }))
      }
      // 直接进入勾选弹窗（对齐 dsh）：候选 = 网关返回的模型 + 其真实档位；
      // 默认勾选目录里还没有的——已配置的条目保持不勾，采纳选择不会改写已调过的参数
      const candidates = r.models.map((id) => ({ id, caps: r.caps?.[id] }))
      setPicker({ providerId: p.id, providerName: p.name, candidates })
      setPickerQuery('')
      const known = new Set(p.models.map((m) => m.id))
      setPickedIds(new Set(candidates.filter((c) => !known.has(c.id)).map((c) => c.id)))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setFetchingBy((m) => ({ ...m, [p.id]: false }))
    }
  }

  // 反向 ref：把表单实例交给父组件（React 19 里 ref 可以直接作为普通 prop 传递）
  useImperativeHandle(ref, () => ({
    validateFields: () => form.validateFields(),
    collectSavePayload: async () => {
      const globals = await form.validateFields().catch(() => null)
      if (!globals) return null
      if (providers.length === 0) {
        message.error('至少保留一个提供商（不想用 AI 可直接关掉「启用 AI 生成」开关）')
        return null
      }
      for (let i = 0; i < providers.length; i++) {
        const p = providers[i]!
        if (!p.name.trim()) {
          message.error(`第 ${i + 1} 个提供商缺少名称`)
          return null
        }
        if (!/^https?:\/\//.test(p.baseURL.trim())) {
          message.error(`提供商「${p.name}」的 Base URL 需为 http(s) 地址`)
          return null
        }
      }
      const { timeoutMs, searchApiKey, ...rest } = globals
      return {
        ...rest,
        // 搜索密钥与提供商密钥同款语义：**留空 = 不下发**（服务端保持已存值）。
        // 恒发空串会让服务端把已配置的联网搜索密钥清空（本框是密码框，界面写着
        // 「留空保持不变」，且没有任何「清空」操作）。
        ...(searchApiKey && searchApiKey.trim() !== '' ? { searchApiKey } : {}),
        // apiKey 只在本次输入了新值时下发：缺省 = 服务端保持该提供商已存密钥；
        // maxTokens/contextWindow 显式下发（null = 清除该提供商的单独设置，回退全局默认）；
        // 模型目录总是全量下发（空数组 = 明确清空目录），id 为空的半填行丢弃
        providers: providers.map((p) => ({
          id: p.id,
          name: p.name.trim(),
          baseURL: p.baseURL.trim(),
          model: p.model.trim(),
          ...(p.apiKey.trim() ? { apiKey: p.apiKey.trim() } : {}),
          maxTokens: p.maxTokens ?? null,
          contextWindow: p.contextWindow ?? null,
          models: p.models
            .filter((m) => m.id.trim() !== '')
            .map((m) => ({
              id: m.id.trim(),
              ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
              ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
            })),
        })),
        activeProviderId: activeId,
        // 表单以秒为单位，后端存储毫秒
        timeoutMs: Math.round(timeoutMs * 1000),
      }
    },
    resetFields: () => form.resetFields(),
    clearSubmittedApiKeys: () => {
      // 只清「本次新输入」的密钥（非空草稿）：它们已随保存提交，留在输入框里既无意义
      // 又让用户分不清「已存」还是「未存」。全局 load() 不再整体重建草稿，清空必须就地做
      setProviders((ps) => ps.map((p) => (p.apiKey.trim() !== '' ? { ...p, apiKey: '' } : p)))
    },
  }), [form, providers, activeId, message])

  // 勾选弹窗的可见候选：按搜索词过滤（id 子串、忽略大小写）
  const pickerQueryNorm = pickerQuery.trim().toLowerCase()
  const pickerCandidates = (picker?.candidates ?? []).filter(
    (c) => pickerQueryNorm === '' || c.id.toLowerCase().includes(pickerQueryNorm),
  )
  const allVisiblePicked =
    pickerCandidates.length > 0 && pickerCandidates.every((c) => pickedIds.has(c.id))

  return (
    <Card title={<span className="settings-section-title"><RobotOutlined />AI 配置</span>} size="small">
      <Form form={form} layout="vertical">
        <Form.Item name="enabled" label="启用 AI 生成" valuePropName="checked">
          <Switch />
        </Form.Item>

        {/* ---- 模型提供商（多提供商管理） ---- */}
        <div style={{ borderTop: '1px solid var(--line)', margin: '12px 0', paddingTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: 'var(--text)' }}>模型提供商</div>
          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 12px' }}>
            可配置多个 OpenAI 兼容提供商，各自维护模型目录。「当前使用」选完
            <b>立即生效</b>（不用保存），其余改动点下方「保存 AI 配置」生效。
          </p>
          <Row gutter={8} align="middle" style={{ marginBottom: 8 }}>
            {/* minWidth:0 —— 否则这一列撑到「当前使用 + 完整选项文字」的 min-content 宽，
                卡片窄时把「添加提供商」按钮整个挤到下一行 */}
            <Col flex="auto" style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, flexShrink: 0 }}>当前使用</span>
                <Select
                  style={{ width: '100%', maxWidth: 400 }}
                  showSearch
                  optionLabelProp="display"
                  optionFilterProp="searchText"
                  value={activePickerValue}
                  onChange={(v: string) => {
                    const sep = v.indexOf(ACTIVE_PICKER_SEP)
                    void activateModel(v.slice(0, sep), v.slice(sep + ACTIVE_PICKER_SEP.length))
                  }}
                  placeholder={providers.length ? '选择提供商与模型' : '先添加一个提供商'}
                  options={activePickerOptions}
                />
              </div>
            </Col>
            <Col>
              <Button icon={<PlusOutlined />} onClick={openAddModal}>
                添加提供商
              </Button>
            </Col>
          </Row>
          {providers.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '12px 0' }}>
              还没有提供商，点「添加提供商」从内置目录选择 DeepSeek、OpenAI、Kimi 等，填入其 API 密钥即可使用。
            </div>
          ) : (
            <Collapse
              size="small"
              className="provider-collapse"
              activeKey={openPanels}
              onChange={(keys) => setOpenPanels(Array.isArray(keys) ? keys : [keys])}
              items={providers.map((p) => ({
                key: p.id,
                label: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={{ fontWeight: 600 }}>{p.name}</span>
                    {p.id === activeId && <Tag color="success">当前使用</Tag>}
                    {!storedIds.has(p.id) && <Tag color="warning">未保存</Tag>}
                    {!p.hasApiKey && !p.apiKey && (ai.apiKeyFromEnv
                      ? <Tag color="processing">密钥来自环境变量</Tag>
                      : <Tag color="error">未配密钥</Tag>)}
                    <span
                      style={{
                        fontSize: 12, color: 'var(--text-3)', overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                    >
                      {p.baseURL}
                    </span>
                  </span>
                ),
                extra: (
                  <span onClick={(e) => e.stopPropagation()}>
                    <Popconfirm
                      title={`删除提供商「${p.name}」？`}
                      description="仅删除本工作台里的该提供商配置，不影响其历史对话。"
                      okText="删除"
                      cancelText="取消"
                      onConfirm={() => removeProvider(p.id)}
                    >
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </span>
                ),
                children: (
                  <>
                    <Form.Item label="提供商" style={{ marginBottom: 12 }}>
                      <Select
                        value={p.presetKey}
                        onChange={(k) => applyPreset(p.id, k)}
                        options={[
                          ...AI_PROVIDER_PRESETS.map((x) => ({ value: x.key, label: x.name })),
                          { value: AI_PROVIDER_CUSTOM_PRESET.key, label: AI_PROVIDER_CUSTOM_PRESET.name },
                        ]}
                      />
                    </Form.Item>
                    {p.presetKey !== 'custom' && AI_PROVIDER_PRESETS.find((x) => x.key === p.presetKey)?.consoleUrl && (
                      <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 12px' }}>
                        还没有 API Key？前往{' '}
                        <a onClick={() => openExternal(AI_PROVIDER_PRESETS.find((x) => x.key === p.presetKey)!.consoleUrl)}>
                          {AI_PROVIDER_PRESETS.find((x) => x.key === p.presetKey)!.name} 控制台 ↗
                        </a>{' '}
                        注册获取。
                      </p>
                    )}
                    <Form.Item label="API 密钥" style={{ marginBottom: 12 }}>
                      <Input.Password
                        value={p.apiKey}
                        onChange={(e) => patchProvider(p.id, { apiKey: e.target.value })}
                        visibilityToggle={{
                          onVisibleChange: (v) => {
                            if (v && p.apiKey.trim() === '') void revealProviderKey(p)
                          },
                        }}
                        placeholder={
                          p.hasApiKey
                            ? `已配置 ${p.apiKeyMasked || '••••••••'} · 留空保持不变，粘贴新值可覆盖`
                            : ai.apiKeyFromEnv
                              ? '留空则用环境变量 AI_API_KEY（不落库），粘贴新值可覆盖'
                              : '粘贴该提供商的 API Key（可留空，如用环境变量 AI_API_KEY）'
                        }
                      />
                    </Form.Item>
                    <Collapse
                      ghost
                      size="small"
                      items={[{
                        key: 'custom',
                        label: '自定义设置',
                        children: (
                          <>
                            <Form.Item label="API 地址（Base URL）" style={{ marginBottom: 12 }}>
                              <Input
                                value={p.baseURL}
                                onChange={(e) => patchProvider(p.id, { baseURL: e.target.value })}
                                placeholder="https://api.deepseek.com/v1"
                              />
                            </Form.Item>
                            <Form.Item label="提供商名称（用于列表展示）" style={{ marginBottom: 0 }}>
                              <Input
                                value={p.name}
                                onChange={(e) => patchProvider(p.id, { name: e.target.value })}
                                placeholder="如：DeepSeek / 公司网关 / 本地 Ollama"
                              />
                            </Form.Item>
                          </>
                        ),
                      }]}
                    />
                    {/* ---- 模型目录（对齐 dsh 的模型管理）----
                        一个区块承载「该提供商使用的模型 + 各模型档位」：radio 点一下立即切过去用，
                        行内可改模型 ID 与参数；当前模型不在目录时以「使用模型」行呈现
                        （其参数即提供商级默认档位，供目录内未填参数的模型兜底）。 */}
                    <div style={{ margin: '12px 0 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                        <span
                          style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}
                          title={`目录条目的参数优先生效；未填参数的模型用「目录外」行里的提供商默认档位。内置参数表口径：${MODEL_CAPS_AS_OF} 各家官方文档`}
                        >
                          模型目录
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--text-3)', flex: 1, minWidth: 80 }}>
                          {p.models.length > 0 ? `${p.models.length} 个模型` : '未建目录'}
                        </span>
                        <Popconfirm
                          title="按内置参数表重填档位？"
                          description={
                            <span style={{ display: 'block', maxWidth: 320 }}>
                              把认得出的模型（{MODEL_CAPS_AS_OF} 官方文档口径，网关返回过真实档位时优先采用）
                              的「上下文 / 最大输出」覆盖为当前建议值；手动调过的值也会被覆盖。
                            </span>
                          }
                          okText="重填"
                          onConfirm={() => refillCaps(p.id)}
                        >
                          <Button size="small" title="老配置里存的可能是旧参数表的建议值，点这里按现行参数表重填">
                            重填档位
                          </Button>
                        </Popconfirm>
                        {p.presetKey !== 'custom' && (
                          <Button size="small" onClick={() => resetModelCatalog(p.id)}>
                            恢复默认模型
                          </Button>
                        )}
                        <Button size="small" loading={!!fetchingBy[p.id]} onClick={() => void fetchProviderModels(p)}>
                          获取可用模型
                        </Button>
                      </div>
                      {p.model.trim() !== '' && !p.models.some((m) => m.id === p.model.trim()) && (
                        <div
                          style={{ border: '1px solid var(--line-soft)', borderRadius: 8, padding: '6px 8px', marginBottom: 6, background: 'var(--bg-elevated)' }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Tag
                              color="processing"
                              style={{ marginRight: 0 }}
                              title="该提供商使用的模型（不在模型目录里，可自由输入）；这里的改动要点「保存 AI 配置」才生效"
                            >
                              使用模型
                            </Tag>
                            <AutoComplete
                              value={p.model}
                              onChange={(v) => patchProvider(p.id, { model: v })}
                              onBlur={(e) => autoFillCaps(p.id, (e.target as HTMLInputElement).value)}
                              options={
                                [...new Map([...p.models.filter((m) => m.id).map((m) => [m.id, { value: m.id }] as const), ...(modelOptionsBy[p.id] ?? []).map((o) => [o.value, o] as const)]).values()]
                              }
                              placeholder="模型 ID（目录外自由输入）"
                              style={{ flex: 1 }}
                            />
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, paddingLeft: 4, flexWrap: 'wrap' }}>
                            <div style={{ width: 170 }}>
                              <NumberUnitInput
                                size="small"
                                min={2}
                                max={2048}
                                step={16}
                                unit="K"
                                value={p.contextWindow ? Math.round(p.contextWindow / 1024) : null}
                                onChange={(v) => patchProvider(p.id, { contextWindow: v ? Math.round(v * 1024) : undefined })}
                                placeholder={ai.globalContextWindow ? `上下文 全局${Math.round(ai.globalContextWindow / 1024)}K` : '上下文窗口'}
                              />
                            </div>
                            <div style={{ width: 170 }}>
                              <NumberUnitInput
                                size="small"
                                min={1}
                                max={384}
                                step={1}
                                unit="K"
                                value={p.maxTokens ? Math.round(p.maxTokens / 1024) : null}
                                onChange={(v) => patchProvider(p.id, { maxTokens: v ? Math.round(v * 1024) : undefined })}
                                placeholder={ai.globalMaxTokens ? `输出 全局${Math.round(ai.globalMaxTokens / 1024)}K` : '最大输出'}
                              />
                            </div>
                          </div>
                        </div>
                      )}
                      {p.models.map((m, i) => (
                        <div
                          key={i}
                          style={{ border: '1px solid var(--line-soft)', borderRadius: 8, padding: '6px 8px', marginBottom: 6, background: 'var(--bg-elevated)' }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Radio
                              checked={p.model === m.id && m.id !== ''}
                              onChange={() => void activateModel(p.id, m.id)}
                              disabled={m.id === ''}
                              title="立即改用该提供商的这个模型（选完即生效，无需保存）"
                            />
                            <Input
                              size="small"
                              value={m.id}
                              onChange={(e) => patchModelEntry(p.id, i, { id: e.target.value })}
                              onBlur={(e) => autoFillCaps(p.id, e.target.value)}
                              placeholder="模型 ID"
                              style={{ flex: 1 }}
                            />
                            <Popconfirm
                              title={`从目录移除「${m.id || '未命名模型'}」？`}
                              description="仅移出目录，不影响已保存的其他配置。"
                              okText="移除"
                              cancelText="取消"
                              onConfirm={() => removeModelEntry(p.id, i)}
                            >
                              <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                            </Popconfirm>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, paddingLeft: 30, flexWrap: 'wrap' }}>
                            <div style={{ width: 170 }}>
                              <NumberUnitInput
                                size="small"
                                min={2}
                                max={2048}
                                step={16}
                                unit="K"
                                value={m.contextWindow ? Math.round(m.contextWindow / 1024) : null}
                                onChange={(v) => patchModelEntry(p.id, i, { contextWindow: v ? Math.round(v * 1024) : undefined })}
                                placeholder={p.contextWindow ? `上下文 默认${Math.round(p.contextWindow / 1024)}K` : '上下文窗口'}
                              />
                            </div>
                            <div style={{ width: 170 }}>
                              <NumberUnitInput
                                size="small"
                                min={1}
                                max={384}
                                step={1}
                                unit="K"
                                value={m.maxTokens ? Math.round(m.maxTokens / 1024) : null}
                                onChange={(v) => patchModelEntry(p.id, i, { maxTokens: v ? Math.round(v * 1024) : undefined })}
                                placeholder={p.maxTokens ? `输出 默认${Math.round(p.maxTokens / 1024)}K` : '最大输出'}
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                      <Button
                        size="small"
                        icon={<PlusOutlined />}
                        disabled={p.models.length >= AI_PROVIDER_MODELS_MAX}
                        onClick={() => addModelEntry(p.id)}
                      >
                        添加模型
                      </Button>
                    </div>

                    <Space wrap style={{ marginBottom: 8 }}>
                      <Button icon={<ApiOutlined />} loading={!!testingBy[p.id]} onClick={() => void testProvider(p)}>
                        测试连接
                      </Button>
                    </Space>
                    {testResultBy[p.id] && (
                      <Alert
                        type={testResultBy[p.id]!.ok ? 'success' : 'error'}
                        showIcon
                        closable
                        message={testResultBy[p.id]!.message}
                        onClose={() => setTestResultBy((m) => ({ ...m, [p.id]: undefined }))}
                      />
                    )}
                  </>
                ),
              }))}
            />
          )}
        </div>

        <Form.Item name="timeoutMs" label="对话超时（秒）" tooltip="AI 助手对话的最长等待时间。响应慢的模型可适当调大，默认 120 秒">
          <NumberUnitInput min={30} max={600} step={30} unit="秒" />
        </Form.Item>
        <div style={{ borderTop: '1px solid var(--line)', margin: '12px 0', paddingTop: 12 }}>
          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 8px' }}>
            联网搜索（可选）：填入搜索 API Key 后，AI 可主动查询最新赛事与文档（Tavily / Brave 均有免费额度，需模型支持 function calling）。还没有 Key？前往{' '}
            <a onClick={() => openExternal('https://tavily.com')}>Tavily ↗</a>
            {' '}或{' '}
            <a onClick={() => openExternal('https://brave.com/search/api/')}>Brave ↗</a>
            {' '}注册。
          </p>
        </div>
          <Form.Item name="searchEngine" label="搜索引擎" style={{ marginBottom: 12 }}>
            <Select
              options={[
                { value: 'tavily', label: 'Tavily（AI 友好，免费 1000 次/月）' },
                { value: 'brave', label: 'Brave Search（免费 2000 次/月）' },
              ]}
            />
          </Form.Item>
        <Form.Item name="searchApiKey" label="搜索 API Key" tooltip="Tavily：api.tavily.com 注册获取；Brave：api.search.brave.com 注册获取。留空则不启用联网搜索。">
          <Input.Password
            visibilityToggle={{
              onVisibleChange: (v) => {
                const cur = form.getFieldValue('searchApiKey')
                if (v && (typeof cur === 'string' ? cur.trim() : '') === '') void revealSearchApiKey()
              },
            }}
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
        </Space>
      </Form>

      {/* 「选择要添加的模型」勾选弹窗（对齐 dsh 的 model picker）：
          搜索过滤 + 复选 + 全选/取消全选；默认只勾目录里还没有的模型，
          采纳选择不会改写已调过的条目参数。 */}
      <Modal
        title={`选择要添加的模型 · ${picker?.providerName ?? ''}`}
        open={picker !== null}
        onCancel={() => setPicker(null)}
        width={480}
        okText={pickedIds.size > 0 ? `添加所选（${pickedIds.size}）` : '添加所选'}
        okButtonProps={{ disabled: pickedIds.size === 0 }}
        onOk={adoptPickedModels}
        cancelText="取消"
      >
        <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 8px' }}>
          以下是该提供商的可用模型，勾选要加入模型目录的模型；已带参数档位的会一并填入。
        </p>
        <Space.Compact block style={{ marginBottom: 8 }}>
          <Input
            allowClear
            value={pickerQuery}
            onChange={(e) => setPickerQuery(e.target.value)}
            placeholder="搜索模型"
          />
          <Button
            onClick={() => {
              setPickedIds((cur) => {
                if (allVisiblePicked) {
                  const next = new Set(cur)
                  for (const c of pickerCandidates) next.delete(c.id)
                  return next
                }
                const next = new Set(cur)
                for (const c of pickerCandidates) next.add(c.id)
                return next
              })
            }}
          >
            {allVisiblePicked ? '取消全选' : '全选'}
          </Button>
        </Space.Compact>
        <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8, padding: 4 }}>
          {pickerCandidates.length === 0 ? (
            <div style={{ padding: 8, fontSize: 13, color: 'var(--text-3)' }}>没有匹配的模型</div>
          ) : (
            pickerCandidates.map((c) => (
              <label
                key={c.id}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 6, cursor: 'pointer' }}
              >
                <Checkbox
                  checked={pickedIds.has(c.id)}
                  onChange={() =>
                    setPickedIds((cur) => {
                      const next = new Set(cur)
                      if (!next.delete(c.id)) next.add(c.id)
                      return next
                    })
                  }
                />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.id}</span>
                {(c.caps?.contextWindow !== undefined || c.caps?.maxTokens !== undefined) && (
                  <span style={{ fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}>
                    {c.caps?.contextWindow !== undefined && `上下文 ${Math.round(c.caps.contextWindow / 1024)}K`}
                    {c.caps?.contextWindow !== undefined && c.caps?.maxTokens !== undefined && ' · '}
                    {c.caps?.maxTokens !== undefined && `输出 ${Math.round(c.caps.maxTokens / 1024)}K`}
                  </span>
                )}
              </label>
            ))
          )}
        </div>
      </Modal>

      {/* 「添加模型提供商」弹窗（对齐 dsh 的添加流程）：两种添加方式二选一，
          填写后「保存」才真正创建提供商草稿；取消不留痕。 */}
      <Modal
        title="添加模型提供商"
        open={addModal !== null}
        onCancel={() => setAddModal(null)}
        width={480}
        okText="保存"
        cancelText="取消"
        onOk={saveAddProvider}
      >
        {addModal && (
          <>
            <Segmented
              block
              value={addModal.tab}
              onChange={(v) => setAddModal({ ...addModal, tab: v as 'preset' | 'custom' })}
              options={[
                { label: '第三方模型提供商', value: 'preset' },
                { label: '自定义模型 API', value: 'custom' },
              ]}
              style={{ marginBottom: 12 }}
            />
            {addModal.tab === 'preset' ? (
              <>
                <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 12px' }}>
                  从内置目录中选择 DeepSeek、OpenAI、Kimi 等提供商，填入其 API 密钥即可使用。
                </p>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13, marginBottom: 6 }}>提供商</div>
                  <Select
                    style={{ width: '100%' }}
                    value={addModal.presetKey || undefined}
                    placeholder="请选择提供商"
                    onChange={(k) => applyAddPreset(String(k))}
                    options={AI_PROVIDER_PRESETS.map((x) => ({ value: x.key, label: x.name }))}
                  />
                </div>
                {addModal.presetKey && AI_PROVIDER_PRESETS.find((x) => x.key === addModal.presetKey)?.consoleUrl && (
                  <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 12px' }}>
                    还没有 API Key？前往{' '}
                    <a onClick={() => openExternal(AI_PROVIDER_PRESETS.find((x) => x.key === addModal.presetKey)!.consoleUrl)}>
                      {AI_PROVIDER_PRESETS.find((x) => x.key === addModal.presetKey)!.name} 控制台 ↗
                    </a>{' '}
                    注册获取。
                  </p>
                )}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13, marginBottom: 6 }}>API 密钥</div>
                  <Input.Password
                    value={addModal.apiKey}
                    onChange={(e) => setAddModal({ ...addModal, apiKey: e.target.value })}
                    placeholder="输入 API 密钥（可留空，如用环境变量 AI_API_KEY）"
                    /* 弹窗里必然还没有已存密钥：空着时不挂眼睛，否则就是个点开没反应的死图标 */
                    visibilityToggle={addModal.apiKey.trim() !== ''}
                  />
                </div>
                <Collapse
                  ghost
                  size="small"
                  items={[{
                    key: 'adv',
                    label: '自定义设置',
                    children: (
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 13, marginBottom: 6 }}>API 地址（Base URL）</div>
                        <Input
                          value={addModal.baseURL}
                          onChange={(e) => setAddModal({ ...addModal, baseURL: e.target.value })}
                          placeholder="提供商默认"
                        />
                      </div>
                    ),
                  }]}
                />
              </>
            ) : (
              <>
                <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 12px' }}>
                  接入任意 OpenAI 兼容网关（one-api / new-api / 本地 Ollama 等）。
                </p>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13, marginBottom: 6 }}>提供商名称</div>
                  <Input
                    value={addModal.name}
                    onChange={(e) => setAddModal({ ...addModal, name: e.target.value })}
                    placeholder="如：公司网关 / 本地 Ollama"
                  />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13, marginBottom: 6 }}>API 密钥</div>
                  <Input.Password
                    value={addModal.apiKey}
                    onChange={(e) => setAddModal({ ...addModal, apiKey: e.target.value })}
                    placeholder="输入 API 密钥（可留空）"
                    visibilityToggle={addModal.apiKey.trim() !== ''}
                  />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13, marginBottom: 6 }}>API 地址（Base URL）</div>
                  <Input
                    value={addModal.baseURL}
                    onChange={(e) => setAddModal({ ...addModal, baseURL: e.target.value })}
                    placeholder="http://localhost:11434/v1"
                  />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13, marginBottom: 6 }}>默认模型（可留空）</div>
                  <Input
                    value={addModal.model}
                    onChange={(e) => setAddModal({ ...addModal, model: e.target.value })}
                    placeholder="如：qwen2.5:7b"
                  />
                </div>
              </>
            )}
          </>
        )}
      </Modal>
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
