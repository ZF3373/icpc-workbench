import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Col,
  Space,
  Spin,
  Switch,
  Tag,
  TimePicker,
  Upload,
} from 'antd'
import { ImportOutlined, RobotOutlined, UploadOutlined, UserOutlined, BellOutlined, FileMarkdownOutlined, AppstoreOutlined } from '@ant-design/icons'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import type { PlatformId } from '../../../shared/src/index.ts'
import { PLATFORMS } from '../../../shared/src/index.ts'
import PageHeader from '../components/PageHeader'
import PlatformTag from '../components/PlatformTag'
import { get, post } from '../api'
import { openExternal } from '../externalLinks'
import { useSoftwareUpdate } from '../useSoftwareUpdate'
import type { ContestReminderConfig, ReminderConfig } from '../types'

interface SettingsData {
  ai: { enabled: boolean; baseURL: string; apiKey: string; model: string }
  accounts: Array<{ platform: PlatformId; handle: string; last_sync_at: string | null; enabled: number }>
  adapterEnabled: Record<string, boolean>
  platforms: typeof PLATFORMS
  cookies: Record<string, { cookie?: string; csrf?: string }>
  reminder: ReminderConfig
  contestReminder: ContestReminderConfig
}

const SYNC_NOTE_COLOR: Record<string, string> = {
  auto: 'success',
  cookie: 'processing',
  manual: 'default',
}

/** 输入框兼容纯值与整段粘贴：不含 = 视为直接填的值；含 = 时提取对应 cookie 字段（(?:^|;) 锚定，避免误匹配到其他同前缀 cookie 名的值） */
function extractCookieValue(raw: string, name: string): string {
  const s = raw.trim()
  if (!s) return ''
  if (!s.includes('=')) return s
  const m = s.match(new RegExp(`(?:^|;)\\s*${name}=([^;\\s]+)`))
  return m ? m[1] : ''
}

/** 用户只填 _uid / __client_id 两项的值，请求用 Cookie 头由这里拼装；C3VK 等挑战 Cookie 由适配器自动续期 */
function assembleLuoguCookie(v: { uid: string; clientId: string }): string {
  const uid = extractCookieValue(v.uid, '_uid') || extractCookieValue(v.clientId, '_uid')
  const token = extractCookieValue(v.clientId, '__client_id') || extractCookieValue(v.uid, '__client_id')
  return [uid && `_uid=${uid}`, token && `__client_id=${token}`].filter(Boolean).join('; ')
}

export default function Settings() {
  const [data, setData] = useState<SettingsData | null>(null)
  const [aiForm] = Form.useForm()
  const [handleInputs, setHandleInputs] = useState<Record<string, string>>({})
  const [cookieInputs, setCookieInputs] = useState<Record<string, { uid: string; clientId: string }>>({})
  const [cookieCheck, setCookieCheck] = useState<Record<string, { ok: boolean; message: string } | 'checking'>>({})
  const [reminderEnabled, setReminderEnabled] = useState(false)
  const [reminderTime, setReminderTime] = useState<Dayjs>(dayjs('20:00', 'HH:mm'))
  const [contestReminder, setContestReminder] = useState<ContestReminderConfig>({ enabled: false, minutesBefore: 30 })
  const [importOpen, setImportOpen] = useState(false)
  const [exportDays, setExportDays] = useState(14)
  const [appVersion, setAppVersion] = useState('')

  const load = () => {
    get<SettingsData>('/api/settings')
      .then((d) => {
        setData(d)
        aiForm.setFieldsValue(d.ai)
        const handles: Record<string, string> = {}
        const cookies: Record<string, { uid: string; clientId: string }> = {}
        for (const a of d.accounts) handles[a.platform] = a.handle
        for (const [platform, c] of Object.entries(d.cookies)) {
          // 已保存的是拼装好的 Cookie 头，回填时拆回 _uid / __client_id 两个输入框
          const saved = c.cookie ?? ''
          cookies[platform] = {
            uid: extractCookieValue(saved, '_uid'),
            clientId: extractCookieValue(saved, '__client_id'),
          }
        }
        setHandleInputs(handles)
        setCookieInputs(cookies)
        setReminderEnabled(d.reminder.enabled)
        setReminderTime(dayjs(d.reminder.time, 'HH:mm'))
        setContestReminder(d.contestReminder)
      })
      .catch((e: Error) => message.error(e.message))
  }

  useEffect(load, [aiForm])

  useEffect(() => {
    get<{ version?: string }>('/api/health')
      .then((h) => setAppVersion(h.version ?? ''))
      .catch(() => {})
  }, [])

  const { info, checking, check, phase, percent, busy, result, runUpdate, hasUpdate } = useSoftwareUpdate()

  if (!data) return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />

  const saveAi = async () => {
    const v = await aiForm.validateFields().catch(() => null)
    if (!v) return
    try {
      await post('/api/settings/ai', v)
      message.success('AI 配置已保存')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const bindAccount = async (platform: PlatformId) => {
    const handle = handleInputs[platform]?.trim()
    if (!handle) {
      message.warning('请先填写用户名')
      return
    }
    try {
      await post('/api/settings/accounts', { platform, handle })
      message.success(`${PLATFORMS.find((p) => p.id === platform)?.name} 已绑定；请到「题目管理 → 导入 → 平台同步」填入同一用户名完成同步`)
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

  const saveCookie = async (platform: PlatformId) => {
    const v = cookieInputs[platform] ?? { uid: '', clientId: '' }
    try {
      // 用户只填 _uid / __client_id 两项的值，请求头格式由前端拼装；
      // csrf: '' 让后端清掉历史遗留的 csrf 记录——同步请求全是 GET，不需要 x-csrf-token
      await post('/api/settings/cookies', { platform, cookie: assembleLuoguCookie(v), csrf: '' })
      message.success(`${PLATFORMS.find((p) => p.id === platform)?.name} Cookie 已保存`)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const checkCookie = async (platform: PlatformId) => {
    const v = cookieInputs[platform] ?? { uid: '', clientId: '' }
    setCookieCheck((s) => ({ ...s, [platform]: 'checking' }))
    try {
      // 两个输入框都为空时检测已保存的 Cookie（后端兜底读取 settings）
      const cookie = assembleLuoguCookie(v)
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

  const downloadPrompt = async (url: string, filename: string) => {
    try {
      const res = await fetch(url)
      const text = await res.text()
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = filename
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <div>
      <PageHeader title="设置" description="配置平台账号、AI 和提醒" />
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
              <Input.Password placeholder="留空则不填（可用环境变量 AI_API_KEY）" />
            </Form.Item>
            <Form.Item name="model" label="模型">
              <Input placeholder="deepseek-chat / gpt-4o-mini / qwen-plus" />
            </Form.Item>
            <Button type="primary" onClick={saveAi}>
              保存 AI 配置
            </Button>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card title={<span className="settings-section-title"><UserOutlined />平台账号与适配器</span>} size="small">
          {data.platforms.map((p) => {
            const account = data.accounts.find((a) => a.platform === p.id)
            const enabled = data.adapterEnabled[p.id] !== false
            const syncNote =
              p.sync === 'auto' ? '自动同步' : p.sync === 'cookie' ? '配置 Cookie 后自动同步' : '仅手动导入'
            const c = cookieInputs[p.id] ?? { uid: '', clientId: '' }
            return (
              <div key={p.id} className="platform-row">
                <div className="platform-row-head">
                  <PlatformTag id={p.id} name={<b>{p.name}</b>} />
                  <Tag color={SYNC_NOTE_COLOR[p.sync]}>{syncNote}</Tag>
                  <span className="spacer" />
                  <Space size={6}>
                    <span className="adapter-label">自动同步</span>
                    <Switch
                      size="small"
                      checked={enabled}
                      onChange={(v) => toggleAdapter(p.id, v)}
                    />
                  </Space>
                </div>
                <Space wrap>
                  <Input
                    placeholder={p.id === 'codeforces' ? 'CF handle' : '用户名 / uid'}
                    style={{ width: 200 }}
                    value={handleInputs[p.id] ?? ''}
                    onChange={(e) => setHandleInputs((s) => ({ ...s, [p.id]: e.target.value }))}
                  />
                  <Button onClick={() => bindAccount(p.id)}>
                    保存
                  </Button>
                  {account && <span className="bound-info">已绑定 {account.handle}</span>}
                </Space>
                {p.sync === 'cookie' && (
                  <div style={{ marginTop: 10 }}>
                    {(() => {
                      const check = cookieCheck[p.id]
                      return (
                        <>
                          <Space wrap>
                            <Input
                              placeholder="_uid（洛谷用户 uid，纯数字）"
                              style={{ width: 200 }}
                              value={c.uid}
                              onChange={(e) =>
                                setCookieInputs((s) => ({
                                  ...s,
                                  [p.id]: { ...(s[p.id] ?? { clientId: '' }), uid: e.target.value },
                                }))
                              }
                            />
                            <Input.Password
                              placeholder="__client_id（登录令牌，F12 → Application → Cookies 复制）"
                              style={{ width: 300 }}
                              value={c.clientId}
                              onChange={(e) =>
                                setCookieInputs((s) => ({
                                  ...s,
                                  [p.id]: { ...(s[p.id] ?? { uid: '' }), clientId: e.target.value },
                                }))
                              }
                            />
                            <Button size="small" onClick={() => saveCookie(p.id)}>
                              保存 Cookie
                            </Button>
                            <Button size="small" loading={check === 'checking'} onClick={() => checkCookie(p.id)}>
                              检测 Cookie
                            </Button>
                          </Space>
                          {check && check !== 'checking' && (
                            <Alert
                              style={{ marginTop: 8, maxWidth: 520 }}
                              type={check.ok ? 'success' : 'warning'}
                              showIcon
                              closable
                              message={check.message}
                            />
                          )}
                        </>
                      )
                    })()}
                  </div>
                )}
              </div>
            )
          })}
          <p className="muted-note">
            说明：Codeforces / AtCoder / 牛客自动同步；洛谷填写 `_uid` / `__client_id` 两项 Cookie 后自动同步（未配置时请在「题目管理」手动导入）。
          </p>
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
            <Button onClick={() => void downloadPrompt(`/api/export/plan-prompt.md?days=${exportDays}`, 'plan-prompt.md')}>
              下载提示词 .md
            </Button>
            <Button onClick={() => void downloadPrompt('/api/export/summary.md', 'practice-summary.md')}>
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
        <Card title={<span className="settings-section-title"><AppstoreOutlined />软件更新</span>} size="small">
          <Space wrap>
            <span>
              当前版本：<b>{appVersion || '未知'}</b>
            </span>
            {info?.buildCommit && info.buildCommit !== 'dev' && (
              <span>
                构建 commit：<b className="mono">{info.buildCommit}</b>
              </span>
            )}
            <Button loading={checking} onClick={check}>
              检查更新
            </Button>
            {hasUpdate && info!.canSelfUpdate && (
              <Popconfirm
                title="确认更新？"
                description="将下载并替换程序文件（约百余 MB），完成后需关闭并重新打开软件；练习数据不受影响。"
                okText="开始更新"
                cancelText="取消"
                onConfirm={runUpdate}
              >
                <Button type="primary" loading={busy}>
                  一键更新
                </Button>
              </Popconfirm>
            )}
            {hasUpdate && !info!.canSelfUpdate && info!.releasePage && (
              <Button type="primary" onClick={() => openExternal(info!.releasePage!)}>
                前往下载 {info!.latest}
              </Button>
            )}
          </Space>
          {busy && (
            <div style={{ marginTop: 12, maxWidth: 720 }}>
              <Progress percent={percent} status="active" />
              <span style={{ color: 'var(--text-tertiary, #8993a2)', fontSize: 12 }}>
                {phase === 'verifying' ? '正在校验文件完整性…' : '正在下载更新（下载完自动替换，请勿关闭软件）'}
              </span>
            </div>
          )}
          {result && (
            <Alert
              style={{ marginTop: 12, maxWidth: 720 }}
              type={result.ok ? 'success' : 'error'}
              showIcon
              message={result.text}
            />
          )}
          {info && (
            <Alert
              style={{ marginTop: 12, maxWidth: 720 }}
              type={info.ok ? (hasUpdate ? 'warning' : 'success') : 'info'}
              showIcon
              message={
                info.ok
                  ? hasUpdate
                    ? info.channel === 'commit'
                      ? `有新提交构建 ${info.commit?.shortSha}（当前 ${info.current}）`
                      : `发现新版本 ${info.latest}（当前 ${info.current}）`
                    : `已是最新版本（${info.current}${info.buildCommit && info.buildCommit !== 'dev' ? ` · ${info.buildCommit}` : ''}）`
                  : `检查更新失败：${info.message ?? '网络异常'}，可稍后重试`
              }
              description={
                info.ok && hasUpdate ? (
                  info.channel === 'commit' ? (
                    <span>
                      包含最新提交修复{info.commit?.message ? `：${info.commit.message}` : ''}。
                      {!info.canSelfUpdate && info.commit && (
                        <a onClick={() => openExternal(info.commit!.page)}>查看该构建 ↗</a>
                      )}
                    </span>
                  ) : (
                    '正式版更新；到下载页下载安装包覆盖，或下载便携版用新 exe 替换旧文件即可，练习数据不受影响。'
                  )
                ) : undefined
              }
            />
          )}
        </Card>
      </Col>

      <ImportPlanModal open={importOpen} onClose={() => setImportOpen(false)} />
      </Row>
    </div>
  )
}

/** 「导出提示词 → 手动喂给任意 AI → 导入」闭环的导入弹窗：粘贴/上传 AI 返回的 JSON 文本。 */
function ImportPlanModal({ open, onClose }: { open: boolean; onClose: () => void }) {
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
