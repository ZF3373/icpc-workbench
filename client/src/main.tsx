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
import './App.css'
import { setupExternalLinks } from './externalLinks'
import { ThemeProvider } from './themeContext'
import { UpdateProvider } from './updateContext'
import { SyncProgressProvider } from './syncProgressContext'
import App from './App.tsx'

dayjs.locale('zh-cn')
setupExternalLinks()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <UpdateProvider>
          {/* 同步进度：全应用共享一份轮询（悬浮卡 / 数据概览面板 / 页内提示都读它） */}
          <SyncProgressProvider>
            <App />
          </SyncProgressProvider>
        </UpdateProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
)
