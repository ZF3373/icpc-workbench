import { useEffect, useState } from 'react'
import { Alert, Button, Popconfirm, Space } from 'antd'
import { openExternal } from './externalLinks'
import { useSoftwareUpdate } from './updateContext'
import { nextUpdateCheckAt, shouldCheckUpdate } from './updateThrottle'

const LAST_CHECK_KEY = 'update.lastCheckAt'
const DISMISS_KEY = 'update.dismissed'

/**
 * 应用打开时静默检查更新（24 小时一次，localStorage 节流），在页面顶部显示横幅。
 *
 * 横幅只提醒**正式版**发布：预览（提交构建）通道不主动推送——预览版可能包含
 * 未完善的功能，弹窗催更等于把它推给所有用户；想尝鲜的用户到「关于 → 检查更新」
 * 自行选择。检查失败完全静默，不打扰使用。
 *
 * 节流判定与写戳都走 updateThrottle（存「下次允许检查的时刻」）：
 * 成功 → 24 小时；失败 → 30 分钟。见该模块注释里的历史缺陷。
 */
export default function UpdateChecker() {
  const { info, check, busy, runUpdate } = useSoftwareUpdate()
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

  // 只认正式版更新：dev 构建恒「有新版本」但那是开发机自己的事，不该弹横幅
  const stableUpdate = !!(info?.ok && info.hasUpdate && info.current !== 'dev')

  useEffect(() => {
    if (!info || !stableUpdate) return
    setHidden(localStorage.getItem(DISMISS_KEY) === (info.latest ?? ''))
  }, [info, stableUpdate])

  if (!info || !stableUpdate || hidden) return null

  return (
    <Alert
      style={{ marginBottom: 16 }}
      type="info"
      showIcon
      closable
      onClose={() => info.latest && localStorage.setItem(DISMISS_KEY, info.latest)}
      message={`发现新版本 ${info.latest}（当前 ${info.current}）`}
      description="到下载页下载安装包覆盖，或用新便携版 exe 替换旧文件；练习数据不受影响。"
      action={
        <Space>
          {info.canSelfUpdate && info.stableDownload && (
            <Popconfirm
              title={`更新到正式版 ${info.latest}？`}
              description="将下载并替换程序文件，完成后需关闭并重新打开软件；练习数据不受影响。"
              okText="开始更新"
              cancelText="取消"
              onConfirm={() => runUpdate('stable')}
            >
              <Button size="small" type="primary" loading={busy}>
                一键更新
              </Button>
            </Popconfirm>
          )}
          {info.releasePage && (
            <Button size="small" onClick={() => openExternal(info.releasePage!)}>
              前往下载
            </Button>
          )}
        </Space>
      }
    />
  )
}
