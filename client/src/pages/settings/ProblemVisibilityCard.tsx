import { Card, Space, Switch, Tag } from 'antd'
import { EyeInvisibleOutlined } from '@ant-design/icons'
import {
  HIDDEN_LABEL,
  setVisibility,
  useProblemVisibility,
} from '../../problemVisibility'

/**
 * 「题目信息隐藏」设置卡（issue #68）。
 *
 * 两个开关互相独立、只作用于**尚未 AC 的题**：
 * - 隐藏算法标签：避免顺着标签猜解法，少了自己从题面发现性质的过程；
 * - 隐藏难度：避免难度先入为主地影响对题目的预判。
 *
 * 偏好存 localStorage（与编辑器缩进同款），改动即时生效，不必再点保存；
 * 题目管理页与写题历史里的格子都由同一个 hook 订阅。
 */
export function ProblemVisibilityCard() {
  const vis = useProblemVisibility()
  const toggle = (patch: Partial<typeof vis>) => setVisibility({ ...vis, ...patch })

  return (
    <Card
      title={
        <span className="settings-section-title">
          <EyeInvisibleOutlined />题目信息隐藏
        </span>
      }
      size="small"
    >
      <p className="muted-note">
        只影响<b>还没 AC 过</b>的题：已 AC 的题照常显示标签与难度，方便复盘。
        隐藏后的格子显示为「{HIDDEN_LABEL}」而不是直接消失 —— 免得你以为这一版把功能砍了。
        悬停不显示真实内容（否则随手一瞥就剧透了），要看得在这里关掉开关。
      </p>
      <Space direction="vertical" size={10}>
        <Space>
          <Switch
            checked={vis.hideTags}
            onChange={(checked) => toggle({ hideTags: checked })}
            aria-label="隐藏未 AC 题目的算法标签"
          />
          <span>隐藏未 AC 题目的算法标签</span>
          <Tag color={vis.hideTags ? 'green' : 'default'}>{vis.hideTags ? '已隐藏' : '显示中'}</Tag>
        </Space>
        <Space>
          <Switch
            checked={vis.hideDifficulty}
            onChange={(checked) => toggle({ hideDifficulty: checked })}
            aria-label="隐藏未 AC 题目的难度"
          />
          <span>隐藏未 AC 题目的难度</span>
          <Tag color={vis.hideDifficulty ? 'green' : 'default'}>{vis.hideDifficulty ? '已隐藏' : '显示中'}</Tag>
        </Space>
      </Space>
    </Card>
  )
}
