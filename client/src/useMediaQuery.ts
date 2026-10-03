import { useEffect, useState } from 'react'

/**
 * 视口断点（UI 优化方案 §6.5）：1280 桌面 / 1024 小桌面与平板横屏 / 768 平板竖屏 / 640 手机。
 *
 * 为什么需要 JS 断点而不是纯 CSS：有些地方不是「换个样式」而是**换一套结构** ——
 * 例如题目管理的算法标签栏，宽屏是常驻侧栏，≤920px 要变成顶部 Select。
 * 只靠 CSS 做不到（两套 DOM 都在就会有两个 Tab 停靠点、也会重复读屏），
 * 所以必须由 JS 决定渲染哪一个。
 *
 * `matchMedia` 而不是监听 resize：只在**跨过断点**时触发一次重渲染，
 * 拖动窗口时不会每帧 setState。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    // 挂载时同步一次：SSR/首帧与真实视口可能不一致
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/** 常用断点（与 index.css 的 @media 保持同一组数值，避免两处口径分叉） */
export const BP = {
  /** ≤920px：题目管理/模板库的分类栏改为顶部 Select */
  narrowTaxonomy: '(max-width: 920px)',
  /** ≤1024px：小桌面 / 平板横屏 */
  lgDown: '(max-width: 1024px)',
  /** ≤768px：平板竖屏，卡片列表转单列 */
  mdDown: '(max-width: 768px)',
  /** ≤640px：手机 */
  smDown: '(max-width: 640px)',
  /**
   * ≥1280px：宽屏。设置页的分区导航在这一档从「顶部吸顶横排」换成「左侧竖排」
   * —— 横排 Segmented 在窄栏里放不下，必须换成 vertical（DOM 结构由 antd 决定，
   * 只靠 CSS 改不了，所以走 JS 断点）。与 index.css 的 `@media (min-width: 1280px)` 同数值。
   */
  xlUp: '(min-width: 1280px)',
} as const
