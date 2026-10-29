import { useEffect, useRef, useState } from 'react'
import type { Dayjs } from 'dayjs'
import {
  App as AntdApp,
  Button,
  Card,
  Collapse,
  Input,
  InputNumber,
  Popover,
  Row,
  Col,
  Segmented,
  Slider,
  Space,
  Switch,
  Tag,
  TimePicker,
} from 'antd'
import { BellOutlined, FileMarkdownOutlined, ImportOutlined, LinkOutlined, PlusOutlined, UserOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import type { PlatformId } from '../../../shared/src/index.ts'
import { PLATFORMS, cookieFieldsOf } from '../../../shared/src/index.ts'
import PageHeader from '../components/PageHeader'
import AiCustomPromptsCard from '../components/AiCustomPromptsCard'
import PageSkeleton from '../components/PageSkeleton'
import InlineError from '../components/InlineError'
import PlatformTag from '../components/PlatformTag'
import { saveUrlAsFile } from '../download'
import { get, post } from '../api'
import { fetchShellAuthStatus, requestShellAuth, waitShellAuthResult, type ShellAuthStatus } from '../shellAuth'
import { buildCookieItem, extractCookieValue } from '../cookies'
import { relativeTimeText } from '../syncStatus'
import { openExternal } from '../externalLinks'
import { useTheme, type ThemePreference } from '../themeCore'
import type { ContestReminderConfig, ReminderConfig } from '../types'
import { AiSettingsCard, type AiSettingsCardHandle, type SettingsAiData } from './settings/AiSettingsCard'
import { ImportPlanModal } from './settings/ImportPlanModal'
import { KnowledgePipelineCard } from './settings/KnowledgePipelineCard'
import { BackupCard } from './settings/BackupCard'
import { ClistCard, type ClistSettingsView } from './settings/ClistCard'

interface SettingsData {
  ai: SettingsAiData
  accounts: Array<{ platform: PlatformId; handle: string; last_sync_at: string | null; enabled: number }>
  adapterEnabled: Record<string, boolean>
  platforms: typeof PLATFORMS
  cookies: Record<string, { configured: boolean; masked?: string; hasUa?: boolean }>
  /** 账号级凭据（多账号）：platform → handle → 该账号已保存的逐对打码 Cookie 头；
   *  键缺失 = 该账号未单独配置（同步回退平台级）。旧版服务端无此字段。 */
  accountCreds?: Record<string, Record<string, { configured: boolean; masked: string }>>
  reminder: ReminderConfig
  contestReminder: ContestReminderConfig
  /** 第三方难度备选源凭据（issue #57）；旧版服务端无此字段 → 按未配置渲染 */
  clist?: ClistSettingsView
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
  /** 桌面壳凭据桥：壳在线 = Cookie 类平台显示「在应用内登录自动获取」（壳内嵌 WebView
   *  登录后自动抓取推送，见 src/shellAuth.ts）；last = 最近一条状态（QOJ 保活时间线展示）。
   *  busyKey = 正在进行的动作标签（`${action}:${platform}:${handle ?? ''}`），任一动作进行中
   *  其余按钮禁用（壳一次只处理一个动作），匹配的按钮显示 loading */
  const [shellOnline, setShellOnline] = useState(false)
  const [shellLast, setShellLast] = useState<ShellAuthStatus | null>(null)
  const [shellBusy, setShellBusy] = useState<string | null>(null)
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

  // 桌面壳凭据桥：探测壳是否在线（决定 Cookie 平台给一键登录按钮还是手动粘贴引导），
  // 并低频跟进 QOJ 后台保活结果（壳 20 分钟一续签、60s 一跳心跳，60s 轮询足够）。
  useEffect(() => {
    let alive = true
    const pull = () => {
      fetchShellAuthStatus()
        .then((v) => {
          if (!alive) return
          setShellOnline(v.shell)
          if (v.last && v.last.kind === 'keepalive') setShellLast(v.last)
        })
        .catch(() => {
          /* 桥接口在旧版核心上不存在：保持降级（手动粘贴引导）即可 */
        })
    }
    pull()
    const t = setInterval(pull, 60_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  /** 一键动作共用：请求壳执行 → 按 id 轮询结果 → 成功后重检该平台账号凭据。
   *  shellBusy 任一动作进行中即挡新请求（壳一次只处理一个动作），匹配 key 的按钮转 loading */
  const runShellAuth = async (action: 'login' | 'pull', platform: string, handle?: string) => {
    const key = `${action}:${platform}:${handle ?? ''}`
    if (shellBusy) return
    setShellBusy(key)
    try {
      const id = await requestShellAuth(action, platform, handle)
      message.info(
        action === 'login'
          ? `已打开${PLATFORMS.find((x) => x.id === platform)?.name ?? platform}登录窗口：请在窗口里完成登录，凭据会自动保存`
          : '正在后台续签 QOJ 验证…',
      )
      const st = await waitShellAuthResult(id, action === 'login' ? 10 * 60_000 : 120_000)
      if (!st) {
        message.warning('桌面壳未回传结果（桌面应用可能已退出）。请确认桌面版正在运行，或改用手动粘贴 Cookie。')
        return
      }
      if (st.ok) {
        message.success(st.message || '凭据已更新')
        // 清空该平台账号的已缓存检测结果，随 load() 重新自动检测连接状态点
        setAcctCheck((s) => ({ ...s, [platform]: {} }))
        load()
      } else {
        message.warning(st.message || '未取得凭据')
      }
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setShellBusy(null)
    }
  }

  /**
   * 平台行「在应用内登录自动获取」：抓到的 Cookie 写到哪取决于账号结构——
   * 单账号直接定向写它的槽位；多账号无法替用户决定写谁，引导去各账号卡片分别抓取；
   * 尚未绑定账号则由壳写平台级暂存，绑定后再抓一次写入账号槽位（账号同步不认平台级）。
   */
  const startShellLogin = (platform: PlatformId, handle?: string) => {
    if (!handle && (data?.accounts.filter((a) => a.platform === platform).length ?? 0) > 1) {
      message.info('该平台绑定了多个账号：请打开各账号的凭据卡片，在卡片里点「登录并自动获取」按账号分别抓取。')
      return
    }
    const only = handle ?? data?.accounts.find((a) => a.platform === platform)?.handle
    void runShellAuth('login', platform, only)
  }

  /** QOJ 专属「立即续签验证」：隐藏窗静默过盾一轮（cf_clearance 约 30 分钟过期） */
  const startQojPull = () => void runShellAuth('pull', 'qoj')

  // 进入设置页时自动检测每个「已配置凭据账号」的登录态，驱动平台连接状态点与账号框状态点。
  // 只对有凭据槽位且尚未检测过的账号触发，未配置凭据的账号不请求（点了账号框才检测）。
  useEffect(() => {
    if (!data) return
    for (const p of data.platforms) {
      // 可选凭据平台（atcoder：不配 Cookie 普通同步照常，配置后启用直连补充）也要自动检测
      if (cookieFieldsOf(p.id).length === 0) continue
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
      const msg = (e as Error).message
      // 网络级失败（核心自动重启的十几秒 / 瞬时断连）自动重试一次：
      // 直接记失败会把「更新后服务短暂重启」钉成红色「凭据无效」，用户以为登录白做了
      if (/failed to fetch|networkerror|load failed/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 4000))
        try {
          const r = await post<{ ok: boolean; message: string }>('/api/settings/cookies/check', { platform, handle })
          setAcctCheck((s) => ({ ...s, [platform]: { ...(s[platform] ?? {}), [handle]: r } }))
          return
        } catch (e2) {
          setAcctCheck((s) => ({
            ...s,
            [platform]: { ...(s[platform] ?? {}), [handle]: { ok: false, message: (e2 as Error).message } },
          }))
          return
        }
      }
      setAcctCheck((s) => ({
        ...s,
        [platform]: { ...(s[platform] ?? {}), [handle]: { ok: false, message: msg } },
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
    // 凭据是否为同步的**必需品**（cookie 类平台）还是增强项（atcoder：普通同步走镜像，
    // Cookie 只用于直连补充扫描）——决定卡片里的文案与是否渲染凭据输入框
    const credRequired = p.sync === 'cookie'
    const slotMasked = handle ? data.accountCreds?.[p.id]?.[handle]?.masked : undefined
    const aCheck = handle ? acctCheck[p.id]?.[handle] : undefined
    const vals = acctInputs[p.id]?.[draftKey] ?? {}
    const fields = cookieFieldsOf(p.id)
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
        {fields.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>
              {handle ? '凭据' : credRequired ? '凭据（可留空）' : '凭据（可选，不配置不影响普通同步）'}
            </div>
            {handle && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                <Button size="small" loading={aCheck === 'checking'} onClick={() => void checkAccountCreds(p.id, handle)}>
                  检测
                </Button>
                {shellOnline && (
                  <Button
                    size="small"
                    title="弹出应用内浏览器登录该平台，Cookie 自动写入本账号（无需 F12 手动复制）。此浏览器用独立的 Cookie 目录，与系统的 Chrome/Edge 相互隔离：不会读取或覆盖你原浏览器的登录，在这里登录也不会挤掉浏览器里的会话。"
                    loading={shellBusy === `login:${p.id}:${handle}`}
                    disabled={!!shellBusy && shellBusy !== `login:${p.id}:${handle}`}
                    onClick={() => startShellLogin(p.id, handle)}
                  >
                    登录并自动获取
                  </Button>
                )}
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
        <AiCustomPromptsCard />
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
                                : p.sync === 'cookie'
                                  ? { cls: '', title: '未单独配置凭据：同步回退平台级 Cookie' }
                                  : { cls: '', title: '未配置凭据（普通同步不受影响；配置后启用直连补充）' }
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
                              {cookieFieldsOf(p.id).length > 0 && (
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
                    {cookieFieldsOf(p.id).length > 0 && shellOnline && (
                      <div style={{ margin: '4px 0 0' }}>
                        <Space wrap size={6}>
                          <Button
                            size="small"
                            type="primary"
                            loading={shellBusy === `login:${p.id}:`}
                            disabled={!!shellBusy && shellBusy !== `login:${p.id}:`}
                            onClick={() => startShellLogin(p.id)}
                          >
                            在应用内登录自动获取
                          </Button>
                          {p.id === 'qoj' && (
                            <Button
                              size="small"
                              loading={shellBusy === 'pull:qoj:'}
                              disabled={!!shellBusy && shellBusy !== 'pull:qoj:'}
                              onClick={startQojPull}
                            >
                              立即续签验证
                            </Button>
                          )}
                          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                            {p.id === 'qoj'
                              ? '桌面版登录一次即可：同步自动经内嵌窗口完成，每 20 分钟自动续签验证，无需复制任何 Cookie。内嵌窗口用独立 Cookie 目录，与系统浏览器隔离、不会挤掉你原浏览器的登录。'
                              : '弹出应用内浏览器登录后，Cookie 自动保存到账号，无需 F12 手动复制。该窗口用独立 Cookie 目录，与系统的 Chrome/Edge 隔离，不会读取或影响你原浏览器的登录状态。'}
                          </span>
                        </Space>
                      </div>
                    )}
                    {p.id === 'qoj' && shellOnline && shellLast && (
                      <div style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-3)' }}>
                        后台保活：{shellLast.ok ? '✓' : '⚠'} {shellLast.message || (shellLast.ok ? '已续签' : '续签失败')}（
                        {dayjs(shellLast.at * 1000).format('HH:mm')}）
                      </div>
                    )}
                    {p.id === 'qoj' && (
                      <p style={{ margin: '2px 0 0', color: 'var(--text-3)', fontSize: 12 }}>
                        桌面版：点上方「在应用内登录 QOJ」登录一次即可，同步自动经内嵌浏览器窗口完成（站点 Cloudflare
                        已把凭据绑定到签发浏览器的指纹，手动复制 Cookie 的方式已失效）。网页版：qoj.ac 登录后 F12 →
                        Application → Cookies 复制 __Host-UOJSESSID（旧名 UOJSESSID）与 cf_clearance（点账号框在卡片里粘贴，
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

      {/* 难度回填的第三方备选源（issue #57）：凭据只在这里配一次，回填卡上才有可用的勾选项 */}
      <Col span={24} id="settings-clist">
        <ClistCard
          clist={data.clist ?? { username: '', configured: false, keyMasked: '' }}
          onSaved={load}
        />
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
