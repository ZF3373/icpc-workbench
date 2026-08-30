import { useEffect, useState } from 'react'
import { Alert, Button, Popconfirm, Space } from 'antd'
import { openExternal } from './externalLinks'
import { useSoftwareUpdate } from './useSoftwareUpdate'

const LAST_CHECK_KEY = 'update.lastCheckAt'
const DISMISS_KEY = 'update.dismissed'
const CHECK_INTERVAL = 24 * 60 * 60 * 1000

/**
 * 应用打开时静默检查更新（24 小时一次，localStorage 节流），
 * 有新版本或新提交构建且用户未忽略时，在页面顶部显示横幅。
 * 支持自更新时提供一键更新；检查失败完全静默，不打扰使用。
 */
export default function UpdateChecker() {
  const { info, check, busy, runUpdate, hasUpdate } = useSoftwareUpdate()
  const [hidden, setHidden] = useState(true)

  useEffect(() => {
    const last = Number(localStorage.getItem(LAST_CHECK_KEY) ?? 0)
    if (Date.now() - last < CHECK_INTERVAL) return
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()))
    void check()
  }, [check])

  useEffect(() => {
    if (!info || !hasUpdate) return
    const id = info.channel === 'commit' ? (info.commit?.sha ?? '') : (info.latest ?? '')
    setHidden(localStorage.getItem(DISMISS_KEY) === id)
  }, [info, hasUpdate])

  if (!info || !hasUpdate || hidden) return null

  const dismissId = info.channel === 'commit' ? (info.commit?.sha ?? '') : (info.latest ?? '')
  const page = info.channel === 'commit' ? (info.commit?.page ?? info.releasePage) : info.releasePage

  return (
    <Alert
      style={{ marginBottom: 16 }}
      type="info"
      showIcon
      closable
      onClose={() => dismissId && localStorage.setItem(DISMISS_KEY, dismissId)}
      message={
        info.channel === 'commit'
          ? `发现新提交构建 ${info.commit?.shortSha ?? ''}（当前 ${info.current}）`
          : `发现新版本 ${info.latest}（当前 ${info.current}）`
      }
      description={
        info.channel === 'commit'
          ? `包含最新提交修复${info.commit?.message ? `：${info.commit.message}` : ''}。`
          : '到下载页下载安装包覆盖，或用新便携版 exe 替换旧文件；练习数据不受影响。'
      }
      action={
        <Space>
          {info.canSelfUpdate && (
            <Popconfirm
              title="确认更新？"
              description="将下载并替换程序文件，完成后需关闭并重新打开软件；练习数据不受影响。"
              okText="开始更新"
              cancelText="取消"
              onConfirm={runUpdate}
            >
              <Button size="small" type="primary" loading={busy}>
                一键更新
              </Button>
            </Popconfirm>
          )}
          {page && (
            <Button size="small" onClick={() => openExternal(page)}>
              前往下载
            </Button>
          )}
        </Space>
      }
    />
  )
}
