import { useRef } from 'react'
import { Button, Card, Slider, Space } from 'antd'
import { PictureOutlined, UploadOutlined, UndoOutlined } from '@ant-design/icons'
import { useAppearance } from '../appearanceCore'

export default function BackgroundSettings() {
  const appearance = useAppearance()
  const fileInput = useRef<HTMLInputElement>(null)
  return <Card className="background-settings-card" title={<span className="settings-section-title"><PictureOutlined />全局背景</span>} size="small">
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap>
        <Button icon={<UploadOutlined />} loading={appearance.busy} onClick={() => fileInput.current?.click()}>导入图片 / 视频</Button>
        <Button icon={<UndoOutlined />} disabled={appearance.busy || !appearance.settings.file} onClick={() => void appearance.reset()}>恢复默认背景</Button>
      </Space>
      <input ref={fileInput} type="file" aria-label="选择背景图片或视频" hidden accept=".png,.jpg,.jpeg,.webp,.gif,.bmp,.avif,.mp4,.webm,.m4v,.mov" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (file) void appearance.importFile(file)
      }} />
      <div className="background-file">{appearance.settings.file ? `${appearance.settings.kind === 'video' ? '视频' : '图片'} · ${appearance.settings.name}` : '尚未设置自定义背景'}</div>
      <div className="background-strength">
        <label id="background-strength-label">背景显示强度</label>
        <Slider ariaLabelledByForHandle="background-strength-label" min={0} max={100} step={1} value={Math.round(appearance.opacity * 100)}
          disabled={appearance.busy || !appearance.settings.available} onChange={value => appearance.previewOpacity(value / 100)} onChangeComplete={value => void appearance.saveOpacity(value / 100)} />
        <output>{Math.round(appearance.opacity * 100)}%</output>
      </div>
      <div className="muted-note">背景连续覆盖主内容区和侧边栏，卡片与控件随强度调整透明度。拖动滑块实时预览，设为 0% 隐藏背景。视频静音循环，窗口隐藏或最小化时暂停。</div>
      <div className="muted-note">图片支持 PNG、JPG、WebP、GIF、BMP、AVIF；视频支持 MP4、WebM、M4V、MOV（取决于视频编码）。导入后保留应用内副本，设置自动保存。</div>
      <div className="background-status" role="status" aria-live="polite">{appearance.status}</div>
    </Space>
  </Card>
}
