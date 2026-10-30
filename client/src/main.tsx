import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import 'antd/dist/reset.css'
// Inter 自托管（@fontsource/inter）。原先走 index.html 里的 fonts.googleapis.com 外链：
// 每次打开页面都要 DNS+TCP+TLS 连一次 Google，并把本机 IP / UA / 来源页交出去。
// 本包按 unicode-range 分片，浏览器只下载实际用到的子集（latin 约 23 KB），外观与原来一致。
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import './index.css'
import { setupExternalLinks } from './externalLinks'
import { setupAppZoom } from './appZoom'
import { ThemeProvider } from './themeContext'
import { UpdateProvider } from './updateContext'
import { SyncProgressProvider } from './syncProgressContext'
import App from './App.tsx'
import { AppearanceProvider } from './appearance'
import './fantasy.css'

dayjs.locale('zh-cn')
setupExternalLinks()
const cleanupAppZoom = setupAppZoom()
if (import.meta.hot) import.meta.hot.dispose(cleanupAppZoom)

/**
 * GPU 节能：应用不可见（最小化 / 切走标签页）立即冻结动画；窗口失焦但仍在
 * 屏幕上时**延迟 30 秒**再冻结 —— 给 <html> 挂 `app-hidden`，CSS 据此把所有
 * infinite 动画 play-state 置为 paused（见 index.css 尾部）。动画帧没人看却仍
 * 让 WebView 的 GPU 进程满负荷重绘 —— 冻结后 GPU 占用立即回落，回前台自动恢复。
 *
 * 失焦延迟而非立即：用户短暂切走（复制代码、查个文档就回来）时界面保持鲜活，
 * 只有长时离开（在看题/写代码，工作台退居背景）才冻结 —— 实测失焦态 WebView
 * 3d 引擎有持续底噪。重新聚焦时立即恢复，无感知。
 */
const BLUR_FREEZE_DELAY_MS = 30_000
let blurFreezeTimer: ReturnType<typeof setTimeout> | null = null
const setAppHidden = (hidden: boolean) => {
  document.documentElement.classList.toggle('app-hidden', hidden)
}
const syncAppHidden = () => {
  if (blurFreezeTimer) {
    clearTimeout(blurFreezeTimer)
    blurFreezeTimer = null
  }
  if (document.hidden) {
    setAppHidden(true) // 不可见：立即冻结
  } else if (document.hasFocus()) {
    setAppHidden(false) // 聚焦：立即恢复
  } else {
    blurFreezeTimer = setTimeout(() => setAppHidden(true), BLUR_FREEZE_DELAY_MS) // 失焦：延迟冻结
  }
}
syncAppHidden()
document.addEventListener('visibilitychange', syncAppHidden)
window.addEventListener('blur', syncAppHidden)
window.addEventListener('focus', syncAppHidden)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <AppearanceProvider>
      <BrowserRouter>
        <UpdateProvider>
          {/* 同步进度：全应用共享一份轮询（悬浮卡 / 数据概览面板 / 页内提示都读它） */}
          <SyncProgressProvider>
            <App />
          </SyncProgressProvider>
        </UpdateProvider>
      </BrowserRouter>
      </AppearanceProvider>
    </ThemeProvider>
  </StrictMode>,
)
