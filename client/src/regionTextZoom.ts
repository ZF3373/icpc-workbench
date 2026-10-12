const REGION_SELECTOR = '[data-text-zoom-region], .markdown-body, .cm-editor, textarea, .ant-table-wrapper, .ant-card-body, .page-content'
const CONTROL_SELECTOR = 'button, [role="button"], input, select, .ant-select, .ant-pagination, .ant-tabs-nav, .anticon, .md-code-head, .cm-panels, .cm-tooltip'

interface FontSnapshot {
  value: string
  priority: string
}

interface RegionState {
  percent: number
  lastTime: number
  lastDirection: number
  fonts: Map<HTMLElement, FontSnapshot>
  observer: MutationObserver
  textareaSize?: { width: string; height: string }
}

/** 鼠标下最近的阅读/编辑区域独立调整字号，导航和操作控件保持原大小。 */
export function setupRegionTextZoom(): { zoom: (target: EventTarget | null, direction: number, time: number) => boolean; cleanup: () => void } {
  const regions = new Map<HTMLElement, RegionState>()
  const restore = (fonts: Map<HTMLElement, FontSnapshot>) => {
    for (const [element, font] of fonts) {
      if (font.value) element.style.setProperty('font-size', font.value, font.priority)
      else element.style.removeProperty('font-size')
    }
  }
  const apply = (region: HTMLElement) => {
    const state = regions.get(region)!
    restore(state.fonts)
    const elements = [region, ...region.querySelectorAll<HTMLElement>('*')].filter(
      (element) => element instanceof HTMLElement && (
        element.closest(REGION_SELECTOR) === region ||
        // 嵌套区域的边界保留原字号，避免继承父区域的缩放。
        (element.matches(REGION_SELECTOR) && element.parentElement?.closest(REGION_SELECTOR) === region && !regions.has(element))
      ),
    )
    // 先读完原始字号再写入，避免父子继承造成倍数叠加；公式也保留原字号比例。
    const sizes = elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize))
    elements.forEach((element, index) => {
      if (!state.fonts.has(element)) {
        state.fonts.set(element, {
          value: element.style.getPropertyValue('font-size'),
          priority: element.style.getPropertyPriority('font-size'),
        })
      }
      const size = sizes[index]
      if (!Number.isFinite(size)) return
      const factor = element.closest(CONTROL_SELECTOR) || element.closest(REGION_SELECTOR) !== region ? 1 : state.percent / 100
      element.style.setProperty('font-size', `${size * factor}px`, 'important')
    })
    for (const element of state.fonts.keys()) {
      if (!region.contains(element) && element !== region) state.fonts.delete(element)
    }
  }
  return {
    zoom(target, direction, time) {
      for (const [element, state] of regions) {
        if (!element.isConnected) {
          state.observer.disconnect()
          restore(state.fonts)
          regions.delete(element)
        }
      }
      if (!(target instanceof Element) || target.closest('.app-sider, .ant-menu, .sider-footer')) return false
      const region = target.closest<HTMLElement>(REGION_SELECTOR)
      if (!region) return false
      let state = regions.get(region)
      if (!state) {
        const observer = new MutationObserver(() => apply(region))
        state = { percent: 100, lastTime: -Infinity, lastDirection: 0, fonts: new Map(), observer }
        // 字号变化不改变 textarea 默认按 cols/rows 计算的编辑框尺寸。
        if (region instanceof HTMLTextAreaElement) {
          state.textareaSize = { width: region.style.width, height: region.style.height }
          const style = getComputedStyle(region)
          const width = style.width
          const height = style.height
          region.style.width = width
          region.style.height = height
        }
        // 子区域开始独立调整后，父区域不再拥有它的边界字号。
        for (const parentState of regions.values()) parentState.fonts.delete(region)
        regions.set(region, state)
        // 流式回复、新增编辑内容继续采用该区域的字号。
        observer.observe(region, { childList: true, subtree: true })
      }
      // 同一区域内限制触控板连续事件的速度；切换区域或反向时立即响应。
      if (state.lastDirection === direction && time - state.lastTime < 80) return true
      state.lastTime = time
      state.lastDirection = direction
      state.percent = Math.min(200, Math.max(50, state.percent + direction * 10))
      apply(region)
      return true
    },
    cleanup() {
      for (const [region, state] of regions) {
        state.observer.disconnect()
        restore(state.fonts)
        if (state.textareaSize) {
          region.style.width = state.textareaSize.width
          region.style.height = state.textareaSize.height
        }
      }
      regions.clear()
    },
  }
}
