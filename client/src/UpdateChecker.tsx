import { useEffect, useState } from 'react'
import { Alert, Button, Popconfirm, Space } from 'antd'
import { openExternal } from './externalLinks'
import { useSoftwareUpdate } from './updateContext'
import { nextUpdateCheckAt, shouldCheckUpdate } from './updateThrottle'

const LAST_CHECK_KEY = 'update.lastCheckAt'
const DISMISS_KEY = 'update.dismissed'

/**
 * 应用打开时静默检查更新（24 小时一次，localStorage 节流），
 * 有新版本或新提交构建且用户未忽略时，在页面顶部显示横幅。
 * 支持自更新时提供一键更新；检查失败完全静默，不打扰使用。
 *
 * 节流判定与写戳都走 updateThrottle（存「下次允许检查的时刻」）：
 * 成功 → 24 小时；失败 → 30 分钟。见该模块注释里的历史缺陷。
 */
export default function UpdateChecker() {
  const { info, check, busy, runUpdate, hasUpdate } = useSoftwareUpdate()
  const [hidden, setHidden] = useState(true)

  useEffect(() => {
    if (!shouldCheckUpdate(Date.now(), localStorage.getItem(LAST_CHECK_KEY))) return
    let cancelled = false
    void check().then((info) => {
      if (cancelled) return
      // 成功记满 24 小时节流；失败 30 分钟后才允许重试
      localStorage.setItem(LAST_CHECK_KEY, String(nextUpdateCheckAt(Date.now(), info?.ok === true)))
    })
    return () => {
      cancelled = true
    }
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
          {/* canSelfUpdate 只表达环境能力；推荐通道有没有产物看 info.download，
              缺产物时一键更新会拿到「无产物」失败，不如直接只给下载页 */}
          {info.canSelfUpdate && info.download && (
            <Popconfirm
              title="确认更新？"
              description="将下载并替换程序文件，完成后需关闭并重新打开软件；练习数据不受影响。"
              okText="开始更新"
              cancelText="取消"
              onConfirm={() => runUpdate()}
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
