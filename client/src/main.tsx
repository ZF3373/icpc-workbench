import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import 'antd/dist/reset.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#863bff',
          colorSuccess: '#10b981',
          colorWarning: '#f59e0b',
          colorError: '#ef4444',
          colorInfo: '#3b82f6',
          colorText: '#17172b',
          colorTextSecondary: '#6f6f85',
          colorTextTertiary: '#9a9ab0',
          colorBorderSecondary: 'rgba(23, 23, 43, 0.08)',
          borderRadius: 10,
          fontFamily: "'Inter', system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
          colorBgContainer: '#ffffff',
          colorBgLayout: '#f6f6fb',
        },
        components: {
          Layout: {
            siderBg: '#0f0f23',
            headerBg: '#0f0f23',
          },
          Menu: {
            darkItemBg: 'transparent',
            darkSubMenuItemBg: '#1a1a3e',
            darkItemSelectedBg: 'rgba(134, 59, 255, 0.15)',
            darkItemHoverBg: 'rgba(134, 59, 255, 0.08)',
            darkItemSelectedColor: '#ffffff',
            itemBorderRadius: 8,
            itemMarginInline: 10,
          },
          Card: {
            borderRadiusLG: 14,
          },
          Button: {
            borderRadius: 8,
            primaryShadow: '0 2px 10px rgba(134, 59, 255, 0.28)',
            defaultShadow: 'none',
            dangerShadow: 'none',
          },
          Table: {
            borderRadius: 8,
            headerBg: '#f8f8fd',
            rowHoverBg: 'rgba(134, 59, 255, 0.035)',
          },
          Modal: {
            borderRadiusLG: 14,
          },
          Drawer: {
            colorBgElevated: '#ffffff',
          },
          Tag: {
            borderRadiusSM: 6,
          },
        },
      }}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ConfigProvider>
  </StrictMode>,
)
