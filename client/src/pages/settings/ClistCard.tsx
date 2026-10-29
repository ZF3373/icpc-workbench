import { useEffect, useState } from 'react'
import { App as AntdApp, Button, Card, Input, Space, Tag } from 'antd'
import { CloudSyncOutlined, LinkOutlined } from '@ant-design/icons'
import { post } from '../../api'
import { openExternal } from '../../externalLinks'

/**
 * clist.by 凭据的界面视图（与 `GET /api/settings` 的 `clist` 字段对应）。
 * 只回显 Key 的打码值：原文不下发前端（与 Cookie / AI Key 同口径）。
 */
export interface ClistSettingsView {
  username: string
  configured: boolean
  keyMasked: string
}

interface ClistSaveResponse {
  ok: boolean
  clist: ClistSettingsView
}

/**
 * 难度回填的**第三方备选源**设置卡（issue #57）。
 *
 * 为什么需要它：平台自己给不出难度（AtCoder 未被 kenkoooo 收录的旧题、CF gym/官方 Unrated、
 * 牛客难度格为空、洛谷「暂无评定」…）时，clist.by 上的 rating 可以兜底。
 * 但 clist.by 的 API **必须带 Key**（无凭据 401、网页端被 Cloudflare 挑战拦截），
 * 所以能力默认不可用，必须由用户在这里填一次凭据 —— 这也保证不会替用户悄悄打第三方站点。
 *
 * 交互约定（与设置页其他密钥框一致）：Key 框留空 = 保持已存值（不是清除）；要清除点「清除凭据」。
 */
export function ClistCard({
  clist,
  onSaved,
}: {
  clist: ClistSettingsView
  /** 保存/清除成功后通知父级重新拉取 /api/settings（本卡片不自持来源，避免两份真相） */
  onSaved: () => void
}) {
  const { message } = AntdApp.useApp()
  const [username, setUsername] = useState(clist.username)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  // 服务端值变化（保存后刷新）时同步用户名；Key 框刻意不预填（原文不回传）
  useEffect(() => {
    setUsername(clist.username)
  }, [clist.username])

  const save = async () => {
    setSaving(true)
    try {
      const r = await post<ClistSaveResponse>('/api/settings/clist', { username, apiKey })
      setApiKey('')
      message.success(r.clist.configured ? 'clist.by 凭据已保存' : '已保存用户名（API Key 仍为空，备选源暂不可用）')
      onSaved()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      const r = await post<{ ok: boolean; message: string }>('/api/settings/clist/test', { username, apiKey })
      if (r.ok) message.success(r.message)
      else message.error(r.message)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setTesting(false)
    }
  }

  const clear = async () => {
    setSaving(true)
    try {
      await post<ClistSaveResponse>('/api/settings/clist', { clear: true })
      setApiKey('')
      message.success('已清除 clist.by 凭据')
      onSaved()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card
      title={
        <span className="settings-section-title">
          <CloudSyncOutlined />第三方难度备选（clist.by）
        </span>
      }
      size="small"
    >
      <p className="muted-note">
        难度回填在平台确实给不出难度时（CF gym/官方 Unrated、AtCoder 未被 kenkoooo 收录的旧题、
        牛客难度格为空、洛谷「暂无评定」等），会到 clist.by 再查一次 rating 作为兜底。
        该站 API 必须带 Key（<b>免费账号即可</b>，在账户页可复制；无凭据返回 401），
        且有 <b>10 次/分钟</b> 的限额 —— 因此每轮回填最多查几十次，查不到的题不会无限重试。
        写入的难度会标注来源为第三方（标度 <code>clist-rating</code>），平台后来给出官方难度时会被覆盖。
        实测该站 rating 相对官方<b>中位偏高约 110 分</b>、个别可达 +400，约 1/4 会跨难度档 ——
        它只用于「本来永远未知」的题，请勿当成官方难度使用。
      </p>
      <Space wrap>
        <Input
          placeholder="clist.by 用户名（可留空，此时 Key 直接填 user:key 整串）"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          style={{ width: 320 }}
          maxLength={100}
          disabled={saving || testing}
        />
        <Input.Password
          placeholder={clist.configured ? `已保存 ${clist.keyMasked}（留空 = 不修改）` : 'API Key'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          style={{ width: 280 }}
          maxLength={200}
          disabled={saving || testing}
        />
        <Button type="primary" loading={saving} onClick={() => void save()}>
          保存
        </Button>
        <Button loading={testing} onClick={() => void test()}>
          测试连接
        </Button>
        {clist.configured && (
          <Button danger disabled={saving || testing} onClick={() => void clear()}>
            清除凭据
          </Button>
        )}
        <Tag color={clist.configured ? 'green' : 'default'}>
          {clist.configured ? '已配置' : '未配置（备选源不生效）'}
        </Tag>
        <Button
          type="link"
          icon={<LinkOutlined />}
          onClick={() => void openExternal('https://clist.by/api/v4/doc/')}
        >
          获取 Key / API 说明
        </Button>
      </Space>
    </Card>
  )
}
