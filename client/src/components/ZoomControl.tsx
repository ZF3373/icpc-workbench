import { useState, useSyncExternalStore } from 'react'
import { Button, Popover } from 'antd'
import { MinusOutlined, PlusOutlined, ZoomInOutlined } from '@ant-design/icons'
import { getZoomPreferences, MAX_ZOOM, MIN_ZOOM, setZoomPreference, subscribeZoomPreferences, ZOOM_STEP } from '../zoomPreferences'

export default function ZoomControl({ kind, compact = false }: { kind: 'global' | 'reply'; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const preferences = useSyncExternalStore(subscribeZoomPreferences, getZoomPreferences)
  const percent = preferences[kind]
  const label = kind === 'reply' ? '对话文字' : '界面'
  return (
    <Popover
      trigger="click"
      placement={kind === 'global' ? 'rightBottom' : 'bottomRight'}
      open={open}
      onOpenChange={setOpen}
      content={
        <div className="zoom-panel" data-zoom-panel={kind}>
          <div className="zoom-panel-label">{label}缩放</div>
          <div className="zoom-panel-actions">
            <Button size="small" aria-label={`缩小${label}`} icon={<MinusOutlined />} disabled={percent <= MIN_ZOOM} onClick={() => setZoomPreference(kind, percent - ZOOM_STEP)} />
            <output aria-label={`${label}缩放比例`} aria-live="polite">{percent}%</output>
            <Button size="small" aria-label={`放大${label}`} icon={<PlusOutlined />} disabled={percent >= MAX_ZOOM} onClick={() => setZoomPreference(kind, percent + ZOOM_STEP)} />
            <Button size="small" aria-label={`重置${label}缩放`} disabled={percent === 100} onClick={() => setZoomPreference(kind, 100)}>重置</Button>
          </div>
          <div className="zoom-panel-hint">
            {MIN_ZOOM}%–{MAX_ZOOM}% · {kind === 'reply' ? 'Ctrl + 滚轮同步调整双方消息' : 'Ctrl + + / -，Ctrl + 0 重置'}
          </div>
        </div>
      }
    >
      <button type="button" className="zoom-trigger" aria-label={`${label}缩放（${percent}%）`} aria-expanded={open} title={`${label}缩放`}>
        <ZoomInOutlined />
        {!compact && <span>{label} {percent}%</span>}
      </button>
    </Popover>
  )
}
