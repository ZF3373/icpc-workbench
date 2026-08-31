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
import type { ReminderConfig } from '../types'

interface SettingsData {
  ai: { enabled: boolean; baseURL: string; apiKey: string; model: string }
  accounts: Array<{ platform: PlatformId; handle: string; last_sync_at: string | null; enabled: number }>
  adapterEnabled: Record<string, boolean>
  platforms: typeof PLATFORMS
  cookies: Record<string, { cookie?: string; csrf?: string }>
  reminder: ReminderConfig
  /** CF 小组 code 列表（空格分隔），赛事中心聚合小组内训练赛 */
  cfGroups: string
  /** CF API 认证（contest.list?group= 小组赛必需，codeforces.com/settings/api 生成） */
  cfApiKey: string
  cfSecret: string
}

const SYNC_NOTE_COLOR: Record<string, string> = {
  auto: 'success',
  cookie: 'processing',
  manual: 'default',
}

export default function Settings() {
  const [data, setData] = useState<SettingsData | null>(null)
  const [aiForm] = Form.useForm()
  const [handleInputs, setHandleInputs] = useState<Record<string, string>>({})
  const [cookieInputs, setCookieInputs] = useState<Record<string, { cookie: string; csrf: string }>>({})
  const [cookieCheck, setCookieCheck] = useState<Record<string, { ok: boolean; message: string } | 'checking'>>({})
  const [reminderEnabled, setReminderEnabled] = useState(false)
  const [reminderTime, setReminderTime] = useState<Dayjs>(dayjs('20:00', 'HH:mm'))
  const [cfGroupsInput, setCfGroupsInput] = useState('')
  const [cfKeyInput, setCfKeyInput] = useState('')
  const [cfSecretInput, setCfSecretInput] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [exportDays, setExportDays] = useState(14)
  const [appVersion, setAppVersion] = useState('')

  const load = () => {
    get<SettingsData>('/api/settings')
      .then((d) => {
        setData(d)
        aiForm.setFieldsValue(d.ai)
        const handles: Record<string, string> = {}
        const cookies: Record<string, { cookie: string; csrf: string }> = {}
        for (const a of d.accounts) handles[a.platform] = a.handle
        for (const [platform, c] of Object.entries(d.cookies)) {
          cookies[platform] = { cookie: c.cookie ?? '', csrf: c.csrf ?? '' }
        }
        setHandleInputs(handles)
        setCookieInputs(cookies)
        setReminderEnabled(d.reminder.enabled)
        setReminderTime(dayjs(d.reminder.time, 'HH:mm'))
        setCfGroupsInput(d.cfGroups ?? '')
        setCfKeyInput(d.cfApiKey ?? '')
        setCfSecretInput(d.cfSecret ?? '')
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

  const saveCfGroups = async () => {
    try {
      const r = await post<{ codes: string[] }>('/api/settings/cf-groups', {
        groups: cfGroupsInput,
        apiKey: cfKeyInput,
        secret: cfSecretInput,
      })
      message.success(r.codes.length ? `已保存 ${r.codes.length} 个小组，赛事中心将展示组内比赛` : '已清空小组配置')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const saveCookie = async (platform: PlatformId) => {
    const v = cookieInputs[platform] ?? { cookie: '', csrf: '' }
    try {
      await post('/api/settings/cookies', { platform, cookie: v.cookie, csrf: v.csrf })
      message.success(`${PLATFORMS.find((p) => p.id === platform)?.name} Cookie 已保存`)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const checkCookie = async (platform: PlatformId) => {
    const v = cookieInputs[platform] ?? { cookie: '', csrf: '' }
    setCookieCheck((s) => ({ ...s, [platform]: 'checking' }))
    try {
      // 未填写输入框时检测已保存的 Cookie（后端兜底读取 settings）
      const r = await post<{ ok: boolean; message: string }>('/api/settings/cookies/check', {
        platform,
        ...(v.cookie.trim() ? { cookie: v.cookie.trim() } : {}),
        ...(v.csrf.trim() ? { csrf: v.csrf.trim() } : {}),
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

  const downloadPrompt = async () => {
    try {
      const url = `/api/export/plan-prompt.md?days=${exportDays}`
      const res = await fetch(url)
      const text = await res.text()
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'plan-prompt.md'
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
            const c = cookieInputs[p.id] ?? { cookie: '', csrf: '' }
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
                            <Input.Password
                              placeholder="登录 Cookie"
                              style={{ width: 260 }}
                              value={c.cookie}
                              onChange={(e) =>
                                setCookieInputs((s) => ({
                                  ...s,
                                  [p.id]: { ...(s[p.id] ?? { csrf: '' }), cookie: e.target.value },
                                }))
                              }
                            />
                            {p.id === 'luogu' && (
                              <Input
                                placeholder="CSRF（x-csrf-token，可选）"
                                style={{ width: 200 }}
                                value={c.csrf}
                                onChange={(e) =>
                                  setCookieInputs((s) => ({
                                    ...s,
                                    [p.id]: { ...(s[p.id] ?? { cookie: '' }), csrf: e.target.value },
                                  }))
                                }
                              />
                            )}
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
            说明：Codeforces / AtCoder 自动同步；洛谷 / 牛客在填写登录 Cookie 后可自动同步（未配置时请在「题目管理」手动导入）。
          </p>
          <div style={{ marginTop: 14 }}>
            <Space wrap>
              <span className="adapter-label">CF 小组赛</span>
              <Input
                placeholder="小组 code，多个用空格 / 逗号分隔（如 MWSDmqGsZm）"
                style={{ width: 380 }}
                value={cfGroupsInput}
                onChange={(e) => setCfGroupsInput(e.target.value)}
              />
              <Button size="small" onClick={saveCfGroups}>
                保存小组配置
              </Button>
            </Space>
            <Space wrap style={{ marginTop: 8 }}>
              <Input.Password
                placeholder="CF API Key（拉小组赛必需）"
                style={{ width: 260 }}
                value={cfKeyInput}
                onChange={(e) => setCfKeyInput(e.target.value)}
              />
              <Input.Password
                placeholder="API Secret"
                style={{ width: 260 }}
                value={cfSecretInput}
                onChange={(e) => setCfSecretInput(e.target.value)}
              />
            </Space>
            <p className="muted-note" style={{ marginBottom: 0 }}>
              组内训练赛需 Codeforces 官方认证才能拉取：到 <b>codeforces.com/settings/api</b> 生成 API Key（Key 主人须为该小组成员），
              与小组 code（codeforces.com/group/<b>小组code</b>/…）一同填写保存。组内比赛以「小组」标签出现在赛事中心，最多 10 个小组。
            </p>
          </div>
        </Card>
      </Col>
      <Col span={24}>
        <Card title={<span className="settings-section-title"><BellOutlined />打卡提醒</span>} size="small">
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
          </Space>
          <p className="muted-note" style={{ marginBottom: 0 }}>
            应用保持打开时，到达提醒时间若当天仍有未打卡任务，会弹出系统通知与页面内通知，点击跳转日历打卡；当天任务全部完成或无任务则不打扰。
          </p>
        </Card>
      </Col>
      <Col span={24}>
        <Card title={<span className="settings-section-title"><FileMarkdownOutlined />导出提示词（手动喂给任意 AI）</span>} size="small">
          <Space wrap>
            <InputNumber min={1} max={90} value={exportDays} onChange={(v) => setExportDays(v ?? 14)} style={{ width: 80 }} />
            <Button onClick={downloadPrompt}>
              下载提示词 .md
            </Button>
            <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
              导入 AI 计划
            </Button>
            <span style={{ color: '#8993a2', fontSize: 12 }}>
              下载后把内容粘贴给任何 AI，再把返回的 JSON 计划通过「导入 AI 计划」粘贴进来即可入库。
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
