import { setupRegionTextZoom } from './regionTextZoom'
import { getZoomPreferences, initializeZoomPreferences, setZoomPreference, ZOOM_STEP } from './zoomPreferences'

/** 返回应用缩放倍率，用于把屏幕坐标转换为布局坐标。 */
export function getAppZoom(): number {
  return Number(document.documentElement.style.getPropertyValue('--app-zoom')) || 1
}

/** 整页缩放包含 body 下的弹窗；捕获阶段也能覆盖输入框和代码编辑器。 */
export function setupAppZoom(): () => void {
  const textZoom = setupRegionTextZoom()
  initializeZoomPreferences()

  const onKey = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return
    let step: number
    if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') {
      step = ZOOM_STEP
    } else if (event.key === '-' || event.code === 'NumpadSubtract') {
      step = -ZOOM_STEP
    } else if (event.key === '0' || event.code === 'Numpad0') {
      step = 0
    } else {
      return
    }
    // 阻止浏览器或 WebView 的默认缩放，避免两层缩放叠加。
    event.preventDefault()
    event.stopPropagation()
    setZoomPreference('global', step === 0 ? 100 : getZoomPreferences().global + step)
  }

  let lastReplyWheelTime = -Infinity
  let lastReplyWheelDirection = 0
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey || event.altKey || event.deltaY === 0) return
    event.preventDefault()
    event.stopPropagation()
    const direction = event.deltaY < 0 ? 1 : -1
    if (event.target instanceof Element && event.target.closest('[data-ai-page]')) {
      // AI 页双方消息正文同步缩放；页头、上下文、能力卡和输入框不参与。
      if (!event.target.closest('.assistant-message-text') || event.target.closest('button, [role="button"], .md-code-head')) return
      if (direction === lastReplyWheelDirection && event.timeStamp - lastReplyWheelTime < 80) return
      lastReplyWheelDirection = direction
      lastReplyWheelTime = event.timeStamp
      setZoomPreference('reply', getZoomPreferences().reply + direction * ZOOM_STEP)
      return
    }
    textZoom.zoom(event.target, direction, event.timeStamp)
  }

  window.addEventListener('keydown', onKey, true)
  window.addEventListener('wheel', onWheel, { capture: true, passive: false })
  return () => {
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('wheel', onWheel, true)
    textZoom.cleanup()
  }
}
