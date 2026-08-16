import type { ReactNode } from 'react'
import type { PlatformId } from '../../../shared/src/index.ts'
import { PLATFORM_COLOR, platformName } from '../ui'

/** 彩色圆点 + 平台名（表格 / 设置页通用，纯展示组件） */
export default function PlatformTag({ id, name }: { id: PlatformId; name?: ReactNode }) {
  return (
    <span className="platform-cell">
      <span className="platform-dot" style={{ background: PLATFORM_COLOR[id] }} />
      {name ?? platformName(id)}
    </span>
  )
}
