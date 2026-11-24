/**
 * 被隐藏的题目信息格子（issue #68）：隐藏算法标签 / 难度时统一显示「已隐藏」。
 *
 * 为什么不是直接不渲染：整列 / 整格消失会让用户以为这一版把功能删了；
 * 显示一个明确的占位更诚实。
 *
 * 为什么不把真实值挂在 tooltip 上：这两个开关的目的就是「别在动手前剧透」，
 * 悬停即显示等于给了一个随手一瞥就能看穿的洞（而人一定会瞥）。
 * 所以 tooltip 只说明「在哪关掉」，要看得回设置页显式关掉开关。
 */
import { Tooltip } from 'antd'
import { HIDDEN_LABEL } from '../problemVisibility'

export default function HiddenCell({ label = HIDDEN_LABEL }: { label?: string }) {
  return (
    <Tooltip title="已按「设置 → 题目信息隐藏」隐藏；要查看请到设置里关掉对应开关">
      <span className="hidden-cell" aria-label={label}>
        {label}
      </span>
    </Tooltip>
  )
}
