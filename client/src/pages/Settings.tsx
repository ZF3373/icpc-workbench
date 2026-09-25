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
import { ApiOutlined, DeleteOutlined, ImportOutlined, RobotOutlined, UploadOutlined, UserOutlined, BellOutlined, FileMarkdownOutlined, LinkOutlined, DatabaseOutlined } from '@ant-design/icons'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import type { PlatformId } from '../../../shared/src/index.ts'
import { PLATFORMS, cookieFieldsOf } from '../../../shared/src/index.ts'
import PageHeader from '../components/PageHeader'
import { saveUrlAsFile } from '../download'
import PlatformTag from '../components/PlatformTag'
import { del, get, post } from '../api'
import { assembleCookie as assembleCookieHeader, buildCookieItem, extractCookieValue } from '../cookies'
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

/** 按平台定义拼装 Cookie 头（纯逻辑见 ../cookies.ts，附带回归测试） */
function assembleCookie(platform: PlatformId, values: Record<string, string> | undefined): string {
  return assembleCookieHeader(cookieFieldsOf(platform), values)
}

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
  const [handleInputs, setHandleInputs] = useState<Record<string, string>>({})
  const [cookieInputs, setCookieInputs] = useState<Record<string, Record<string, string>>>({})
  /** 本次会话中被用户实际改动过的凭据字段（platform → 字段 key 集合）。
   *  只有这些字段会提交给保存接口，其余字段由服务端保留已保存值——
   *  修复「只补填一项、另一项留空即被清空」的缺陷。 */
  const [dirtyFields, setDirtyFields] = useState<Record<string, Set<string>>>({})
  const [cookieCheck, setCookieCheck] = useState<Record<string, { ok: boolean; message: string } | 'checking'>>({})
  const [reminderEnabled, setReminderEnabled] = useState(false)
  const [reminderTime, setReminderTime] = useState<Dayjs>(dayjs('20:00', 'HH:mm'))
  const [contestReminder, setContestReminder] = useState<ContestReminderConfig>({ enabled: false, minutesBefore: 30 })
  const [importOpen, setImportOpen] = useState(false)
  const [exportDays, setExportDays] = useState(14)
  const [aiTesting, setAiTesting] = useState(false)
  const [aiTestResult, setAiTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelOptions, setModelOptions] = useState<{ value: string }[]>([])
  const [syncMax, setSyncMax] = useState(500)
  /** 后台续拉轮数上限（0 = 关闭；服务端默认 3）；字段可能来自旧版服务端，故可空 */
  const [syncRounds, setSyncRounds] = useState(6)
  /** 计蒜客「同步自由练题提交」开关（键缺失 = 默认开启） */
  const [practiceSync, setPracticeSync] = useState(true)
  /** 拉取速度全局倍率（1× = 安全下限/最快，越大越慢越稳）；拖动滑块即时预览，松手才落库 */
  const [syncScale, setSyncScale] = useState(1)
  /** 各平台 1× 基准间隔（毫秒），由服务端下发；用于实时显示「当前倍率下每次请求间隔」 */
  const [intervalBase, setIntervalBase] = useState<Record<string, number>>({})
  /** 服务端当前已落库的倍率（用于去重提交与失败回滚基准） */
  const savedScale = useRef<number>(1)
  /** onChange 防抖补提交的定时器：rc-slider 只在 document 监听 mouseup（无指针捕获），
   *  鼠标在浏览器窗口外松开时 onChangeComplete 丢失、拖到的值不落库——用防抖兜底。 */
  const scaleSaveTimer = useRef<number | null>(null)

  const load = () => {
    get<SettingsData>('/api/settings')
      .then((d) => {
        setData(d)
        aiForm.setFieldsValue({ ...d.ai, apiKey: '', timeoutMs: d.ai.timeoutMs ? d.ai.timeoutMs / 1000 : 120, maxTokens: Math.round((d.ai.maxTokens ?? 393216) / 1024), contextWindow: Math.round((d.ai.contextWindow ?? 1024000) / 1024), searchEngine: d.ai.searchEngine ?? 'tavily', searchApiKey: '' })
        // 输入框只用于「添加新账号」，不回填已绑定 handle（多账号后一个平台可有多个绑定）
        const handles: Record<string, string> = {}
        const cookies: Record<string, Record<string, string>> = {}
        // Cookie 不会回传到前端；保留空输入框，用户可显式更新或清除。
        setHandleInputs(handles)
        setCookieInputs(cookies)
        setReminderEnabled(d.reminder.enabled)
        setReminderTime(dayjs(d.reminder.time, 'HH:mm'))
        setContestReminder(d.contestReminder)
        setSyncMax(d.sync?.maxSubmissions ?? 300)
        setSyncRounds(d.sync?.autoContinueRounds ?? 3)
        setPracticeSync(d.sync?.jisuankePracticeSync !== false)
        setSyncScale(d.sync?.requestIntervalScale ?? 1)
        savedScale.current = d.sync?.requestIntervalScale ?? 1
        setIntervalBase(d.sync?.requestIntervalBase ?? {})
      })
      .catch((e: Error) => message.error(e.message))
  }

  useEffect(load, [aiForm])

  // 进入设置页时自动检测已保存 Cookie 的平台登录态，驱动面板右侧连接状态点。
  // 仅对 cookie 类平台、有已保存 Cookie 且尚未检测过的触发，避免重复请求。
  useEffect(() => {
    if (!data) return
    for (const p of data.platforms) {
      if (p.sync !== 'cookie') continue
      if (cookieCheck[p.id] !== undefined) continue
      if (!data.cookies[p.id]?.configured) continue
      void checkCookie(p.id)
    }
    // checkCookie 闭包随渲染刷新，此处只需在 data 变化（加载完成）时驱动一次
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

  // 多账号：向平台追加绑定（同 handle 重复保存 = 重新启用，不影响其他账号与历史数据）
  const bindAccount = async (platform: PlatformId) => {
    const handle = handleInputs[platform]?.trim()
    if (!handle) {
      message.warning('请先填写用户名')
      return
    }
    try {
      await post('/api/settings/accounts', { platform, handle })
      message.success(`${PLATFORMS.find((p) => p.id === platform)?.name} 账号 ${handle} 已绑定；请到「题目管理 → 导入 → 平台同步」填入同一用户名完成同步`)
      setHandleInputs((s) => ({ ...s, [platform]: '' }))
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

  const saveSyncMax = async (v: number | null) => {
    const n = v ?? 500
    try {
      const r = await post<{ maxSubmissions: number }>('/api/settings/sync', { maxSubmissions: n })
      setSyncMax(r.maxSubmissions)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /** 保存后台续拉轮数（0 = 关闭）。POST /api/settings/sync 要求 maxSubmissions 必填，故一并带上当前值 */
  const saveSyncRounds = async (v: number | null) => {
    if (v == null) return // 清空输入框不落库，保留原值（避免误把轮数写成 0 = 关闭）
    try {
      const r = await post<{ autoContinueRounds: number }>('/api/settings/sync', {
        maxSubmissions: syncMax,
        autoContinueRounds: v,
      })
      setSyncRounds(r.autoContinueRounds ?? v)
      message.success(v === 0 ? '后台续拉已关闭' : `后台续拉轮数已保存：最多 ${r.autoContinueRounds ?? v} 轮`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /** 计蒜客「同步自由练题提交」开关：落库 settings['jisuanke.practiceSync']（'true'/'false'） */
  const savePracticeSync = async (v: boolean) => {
    try {
      const r = await post<{ jisuankePracticeSync: boolean }>('/api/settings/sync', {
        maxSubmissions: syncMax,
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
        maxSubmissions: syncMax,
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

  const saveCookie = async (platform: PlatformId) => {
    // 字段级合并：只提交本次被改动过的字段（dirtyFields），其余字段由服务端保留已保存值。
    // 这样「A 已保存、只想补填 B」时不需要把 A 重新粘贴一遍，也不会把 A 清空
    // （历史缺陷：整条 Cookie 头覆盖保存，空输入框 = 删除该项）。
    const defs = cookieFieldsOf(platform)
    const dirty = dirtyFields[platform] ?? new Set<string>()
    const values = cookieInputs[platform] ?? {}
    const cookieFields: Record<string, string> = {}
    for (const f of defs) {
      if (!dirty.has(f.key)) continue
      const raw = (values[f.key] ?? '').trim()
      if (f.configOnly) {
        // 仅作配置保存的字段（QOJ 的浏览器 UA）：原样提交，空串表示清除该项
        cookieFields[f.key] = raw
        continue
      }
      if (f.raw) {
        // raw 字段（会话名不固定 / 值含特殊字符）：原样提交，服务端按字段定义解析与补名前缀
        // （历史缺陷：前端拼好后端再拼一次，会把 "Cookie: sid=x" 变成 "sid=Cookie: sid=x"）
        cookieFields[f.key] = raw
        continue
      }
      // 普通 Cookie 字段：只传裸值，`name=value` 由服务端按字段定义拼装（两端同一份字段表）
      const item = buildCookieItem(f, raw)
      cookieFields[f.key] = item ? item.slice(item.indexOf('=') + 1) : ''
    }

    if (Object.keys(cookieFields).length === 0) {
      // 什么都没改：若该平台已配置，提示当前保存内容；未配置则提示先填写
      if (data?.cookies[platform]?.configured) {
        const name = PLATFORMS.find((p) => p.id === platform)?.name ?? platform
        message.info(`${name} 凭据未改动，已保存的配置保持不变`)
      } else {
        message.info('请先填写凭据再保存')
      }
      return
    }
    try {
      const r = await post<{ ok: boolean; fields?: string[]; hasUa?: boolean }>('/api/settings/cookies', {
        platform,
        cookieFields,
      })
      const name = PLATFORMS.find((p) => p.id === platform)?.name ?? platform
      const desc = [...(r.fields ?? []), ...(r.hasUa ? ['User-Agent'] : [])].join(' + ')
      message.success(`${name} 凭据已保存${desc ? `（${desc}）` : ''}；未填写的字段保持原值`)
      // 清空已改动标记 + 清空输入框：避免遮蔽框残留旧值被再次误提交
      setDirtyFields((s) => ({ ...s, [platform]: new Set<string>() }))
      setCookieInputs((s) => ({ ...s, [platform]: {} }))
      // 清除旧检测结果：上方 data 变化驱动的 effect 会据此重新检测，刷新连接状态点
      setCookieCheck((s) => {
        const next = { ...s }
        delete next[platform]
        return next
      })
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /** 显式清除该平台全部凭据（含浏览器 UA），需二次确认 */
  const clearCookie = (platform: PlatformId) => {
    const name = PLATFORMS.find((p) => p.id === platform)?.name ?? platform
    modal.confirm({
      title: `清除 ${name} 的全部凭据？`,
      content: '将删除已保存的 Cookie（含浏览器 UA 配置）。清除后该平台无法自动同步，需要重新填写。',
      okText: '清除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await post('/api/settings/cookies', { platform, cookie: '', csrf: '' })
          message.warning(`${name} 凭据已清除`)
          setDirtyFields((s) => ({ ...s, [platform]: new Set<string>() }))
          setCookieInputs((s) => ({ ...s, [platform]: {} }))
          setCookieCheck((s0) => {
            const next = { ...s0 }
            delete next[platform]
            return next
          })
          load()
        } catch (e) {
          message.error((e as Error).message)
        }
      },
    })
  }

  const checkCookie = async (platform: PlatformId) => {
    setCookieCheck((s) => ({ ...s, [platform]: 'checking' }))
    try {
      // 各输入框都为空时检测已保存的 Cookie（后端兜底读取 settings）
      const cookie = assembleCookie(platform, cookieInputs[platform])
      const r = await post<{ ok: boolean; message: string }>('/api/settings/cookies/check', {
        platform,
        ...(cookie ? { cookie } : {}),
      })
      setCookieCheck((s) => ({ ...s, [platform]: r }))
    } catch (e) {
      setCookieCheck((s) => ({ ...s, [platform]: { ok: false, message: (e as Error).message } }))
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
              const c = cookieInputs[p.id] ?? {}
              const check = cookieCheck[p.id]
              const fields = cookieFieldsOf(p.id)
              // 连接状态点：自动同步平台看「已绑定 + 适配器开启」；cookie 平台看检测登录态
              // （未检测但有已保存 Cookie 时显示检测中，由上方 effect 自动触发检测）
              const dot =
                p.sync === 'auto'
                  ? account && enabled
                    ? { cls: 'conn-dot-ok', title: '已连接' }
                    : { cls: 'conn-dot-fail', title: '未连接' }
                  : check === 'checking'
                    ? { cls: 'conn-dot-checking', title: '检测中…' }
                    : check
                      ? check.ok
                        ? { cls: 'conn-dot-ok', title: '已连接' }
                        : { cls: 'conn-dot-fail', title: '未连接' }
                      : data.cookies[p.id]?.configured
                        ? { cls: 'conn-dot-checking', title: '检测中…' }
                        : { cls: 'conn-dot-fail', title: '未连接' }
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
                    {/* 已绑定账号列表（多账号）：同平台可并存多个账号，各账号提交隔离保留 */}
                    {platformAccounts.length > 0 && (
                      <div style={{ marginBottom: 10 }}>
                        {platformAccounts.map((a) => (
                          <div
                            key={a.handle}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 10,
                              padding: '4px 0',
                              opacity: a.enabled === 1 ? 1 : 0.55,
                            }}
                          >
                            <b style={{ minWidth: 120 }}>{a.handle}</b>
                            <span className="mono" style={{ fontSize: 12, color: '#8993a2' }}>
                              {a.last_sync_at ? `上次同步 ${relativeTimeText(a.last_sync_at)}` : '从未同步'}
                            </span>
                            <span style={{ flex: 1 }} />
                            <span style={{ fontSize: 12, color: '#8993a2' }}>参与同步</span>
                            <Switch
                              size="small"
                              checked={a.enabled === 1}
                              onChange={(v) => void toggleAccountEnabled(p.id, a.handle, v)}
                            />
                            <Popconfirm
                              title={`删除账号 ${a.handle}`}
                              description="将同时删除该账号的全部提交记录；删除前自动创建恢复点，误删可在「数据管理 → 备份与恢复」找回。"
                              okText="删除"
                              cancelText="取消"
                              onConfirm={() => void removeAccount(p.id, a.handle)}
                            >
                              <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                            </Popconfirm>
                          </div>
                        ))}
                      </div>
                    )}
                    <Space wrap>
                      <Input
                        placeholder={p.id === 'codeforces' ? 'CF handle' : '用户名 / uid'}
                        style={{ width: 200 }}
                        value={handleInputs[p.id] ?? ''}
                        onPressEnter={() => void bindAccount(p.id)}
                        onChange={(e) => setHandleInputs((s) => ({ ...s, [p.id]: e.target.value }))}
                      />
                      <Button onClick={() => void bindAccount(p.id)}>
                        {platformAccounts.length > 0 ? '添加账号' : '绑定'}
                      </Button>
                    </Space>
                    <p style={{ margin: '8px 0 0', color: '#8993a2', fontSize: 12 }}>
                      同一平台可绑定多个账号（如大号 + 小号），各账号提交记录隔离保留、互不覆盖；
                      删除账号会连带删除其提交记录，删除前自动创建恢复点，可在「数据管理 → 备份与恢复」找回。
                      单次同步会依次拉取所有启用账号。
                      {p.sync === 'cookie' && ' 需登录平台（Cookie 类）各账号共用平台级 Cookie，请以当前登录账号为准。'}
                    </p>
                    {p.sync === 'cookie' && (
                      <div style={{ marginTop: 10 }}>
                        {/* Cookie 原文不回传前端，输入框恒为空；服务端只回传逐对打码版（masked），
                            按 cookieName 拆回各框，placeholder 显示「已配置 + 遮蔽值」供确认 */}
                        {(() => {
                          const configured = data?.cookies[p.id]?.configured === true
                          const maskedHeader = configured ? (data?.cookies[p.id]?.masked ?? '') : ''
                          const hasUa = data?.cookies[p.id]?.hasUa === true
                          /** 改动某字段：记入 dirty 集合（保存时只提交这些字段） */
                          const setField = (key: string, value: string) => {
                            setCookieInputs((s) => ({ ...s, [p.id]: { ...(s[p.id] ?? {}), [key]: value } }))
                            setDirtyFields((s) => {
                              const next = new Set(s[p.id] ?? [])
                              next.add(key)
                              return { ...s, [p.id]: next }
                            })
                          }
                          return (
                            <>
                              <Space wrap size={8}>
                                {fields.map((f) => {
                                  const maskedVal = f.configOnly ? '' : extractCookieValue(maskedHeader, f.cookieName)
                                  const fieldConfigured = f.configOnly ? hasUa : configured && maskedVal !== ''
                                  const ph = fieldConfigured
                                    ? maskedVal
                                      ? `已配置 ${maskedVal} · 粘贴新值可覆盖`
                                      : '已配置 · 粘贴新值可覆盖'
                                    : f.placeholder
                                  const input = f.password ? (
                                    <Input.Password
                                      placeholder={ph}
                                      style={{ width: 240 }}
                                      value={c[f.key] ?? ''}
                                      onChange={(e) => setField(f.key, e.target.value)}
                                    />
                                  ) : (
                                    <Input
                                      placeholder={ph}
                                      style={{ width: 240 }}
                                      value={c[f.key] ?? ''}
                                      onChange={(e) => setField(f.key, e.target.value)}
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
                                <div style={{ alignSelf: 'flex-end', paddingBottom: 1 }}>
                                  <Space size={8}>
                                    <Button size="small" onClick={() => saveCookie(p.id)}>
                                      保存
                                    </Button>
                                    <Button size="small" loading={check === 'checking'} onClick={() => checkCookie(p.id)}>
                                      检测
                                    </Button>
                                    {configured && (
                                      <Button size="small" danger onClick={() => clearCookie(p.id)}>
                                        清除
                                      </Button>
                                    )}
                                    <Tag color={configured ? 'success' : 'default'} style={{ marginRight: 0 }}>
                                      {configured ? '已配置' : '未配置'}
                                    </Tag>
                                  </Space>
                                </div>
                              </Space>
                              {p.id === 'jisuanke' && (
                                <div style={{ fontSize: 12, color: '#8993a2', marginTop: 6 }}>
                                  登录 www.jisuanke.com 后，F12 → Application → Cookies 复制 s 与 JSKUSS 的值（acw_tc / XSRF-TOKEN 不需要）；未登录时的 s 是游客会话，校验不过。
                                </div>
                              )}
                              {p.id === 'qoj' && (
                                <div style={{ fontSize: 12, color: '#8993a2', marginTop: 6 }}>
                                  两项 Cookie 按名分框填写（保存时由后端合并成 Cookie 头，不必手工拼串）：
                                  <div style={{ marginTop: 2 }}>
                                    ① <b>UOJSESSID</b>（登录会话，必需）：浏览器登录 qoj.ac 后 F12 → Application → Cookies，
                                    找 <code>UOJSESSID</code> 复制它的值。
                                  </div>
                                  <div style={{ marginTop: 2 }}>
                                    ② <b>cf_clearance</b>（Cloudflare 通行凭据，必需）：同页 <code>cf_clearance</code> 的值（较长）。
                                    两项都在同一个站点的 Domain 下；也可把 Network 里 Request Headers 的整段 <code>Cookie</code>
                                    粘进任一框，后端会自动把各名字分派到对应字段（其余展示项 uoj_locale / OptanonConsent 等无影响）。
                                  </div>
                                  <div style={{ marginTop: 2 }}>
                                    ③ <b>浏览器 User-Agent</b>（必需）：在该页 Console 输入 <code>navigator.userAgent</code> 回车，整行粘贴。
                                    <code>cf_clearance</code> 与签发它的浏览器 UA 绑定，UA 不填或不一致会 100% 被 Cloudflare 拦截。
                                  </div>
                                  <div style={{ marginTop: 2 }}>
                                    <code>cf_clearance</code> 约 30 分钟过期：过期后重新复制该项保存即可，另一项保持不变。
                                  </div>
                                </div>
                              )}
                            </>
                          )
                        })()}
                        {check && check !== 'checking' && (
                          <Alert
                            style={{ marginTop: 8, maxWidth: 520 }}
                            type={check.ok ? 'success' : 'warning'}
                            showIcon
                            closable
                            message={check.message}
                          />
                        )}
                      </div>
                    )}
                  </>
                ),
              }
            })}
          />
          <p className="muted-note">
            说明：每个 Cookie 单独一框，按输入框上方的名称到浏览器 F12 → Application → Cookies 复制对应值（框内整段粘贴亦可，后端自动分派到各字段）。<b>保存只覆盖你本次填写过的字段</b>，留空的字段保持已保存值。代码源仅需 sid；LeetCode 需 LEETCODE_SESSION 与 csrftoken；计蒜客需 s 与 JSKUSS 两项（未登录时站点的 s 是游客会话，校验不过）；QOJ 需 UOJSESSID 与 cf_clearance 两项 Cookie，外加同浏览器的 User-Agent，三项缺一不可。
          </p>
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
        <BackupCard />
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

/** 备份与恢复点：每日首次启动 / 升级前 / 大批量导入前 / 换账号重置前自动创建；恢复重启后生效 */
function BackupCard() {
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
  useEffect(load, [message])

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
