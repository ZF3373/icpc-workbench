import { useEffect, useState } from 'react'
import { Alert, Button } from 'antd'
import { get } from './api'
import type { UpdateInfo } from './types'

const LAST_CHECK_KEY = 'update.lastCheckAt'
const DISMISS_KEY = 'update.dismissed'
const CHECK_INTERVAL = 24 * 60 * 60 * 1000

/**
 * 应用打开时静默检查更新（24 小时一次，localStorage 节流），
 * 有新版本且用户未忽略该版本时，在页面顶部显示横幅。
 * 检查失败完全静默，不打扰使用。
 */
export default function UpdateChecker() {
  const [info, setInfo] = useState<UpdateInfo | null>(null)

  useEffect(() => {
    const last = Number(localStorage.getItem(LAST_CHECK_KEY) ?? 0)
    if (Date.now() - last < CHECK_INTERVAL) return
    get<UpdateInfo>('/api/update/check')
      .then((r) => {
        localStorage.setItem(LAST_CHECK_KEY, String(Date.now()))
        if (r.ok && r.hasUpdate && r.latest && localStorage.getItem(DISMISS_KEY) !== r.latest) {
          setInfo(r)
        }
      })
      .catch(() => {})
  }, [])

  if (!info?.releasePage) return null

  return (
    <Alert
      style={{ marginBottom: 16 }}
      type="info"
      showIcon
      closable
      onClose={() => info.latest && localStorage.setItem(DISMISS_KEY, info.latest)}
      message={`发现新版本 ${info.latest}（当前 ${info.current}）`}
      description="到下载页下载 zip 并解压，用新的 exe 替换旧文件即可完成升级；练习数据（data 文件夹）不受影响。"
      action={
        <Button size="small" type="primary" onClick={() => window.open(info.releasePage!, '_blank')}>
          前往下载
        </Button>
      }
    />
  )
}
