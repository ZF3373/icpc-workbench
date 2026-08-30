import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ConfigProvider, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import 'antd/dist/reset.css'
import './index.css'
import { setupExternalLinks } from './externalLinks'
import App from './App.tsx'

setupExternalLinks()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: antdTheme.darkAlgorithm,
        token: {
          colorPrimary: '#86a8ff',
          colorSuccess: '#69d7a5',
          colorWarning: '#f2c46d',
          colorError: '#ff7b84',
          colorInfo: '#58a3ff',
          colorText: '#f5f7fb',
          colorTextSecondary: '#c4cad4',
          colorTextTertiary: '#8993a2',
          colorBgContainer: '#181b22',
          colorBgElevated: '#1d212a',
          colorBgLayout: '#111318',
          colorBorder: '#2a3039',
          colorBorderSecondary: '#222831',
          borderRadius: 10,
          fontFamily:
            "'Segoe UI Variable Text', 'Segoe UI', 'Inter', system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei UI', sans-serif",
        },
        components: {
          Layout: {
            siderBg: '#12151a',
            headerBg: '#12151a',
            bodyBg: '#111318',
          },
          Menu: {
            darkItemBg: 'transparent',
            darkSubMenuItemBg: '#1d212a',
            darkItemSelectedBg: 'rgba(134, 168, 255, 0.13)',
            darkItemHoverBg: '#20242c',
            darkItemSelectedColor: '#86a8ff',
            darkItemColor: '#8b94a3',
            itemBorderRadius: 10,
            itemMarginInline: 10,
            itemMarginBlock: 2,
            itemHeight: 40,
            iconSize: 17,
            activeBarBorderWidth: 0,
          },
          Card: {
            colorBgContainer: '#181b22',
            borderRadiusLG: 14,
          },
          Button: {
            borderRadius: 8,
            primaryShadow: '0 6px 18px rgba(58, 76, 128, 0.28)',
            defaultShadow: 'none',
            dangerShadow: 'none',
          },
          Table: {
            headerBg: '#1b1f27',
            headerColor: '#929ba9',
            rowHoverBg: '#1d222a',
            borderColor: '#222831',
          },
          Modal: {
            contentBg: '#1d212a',
            headerBg: '#1d212a',
            borderRadiusLG: 14,
          },
          Drawer: {
            colorBgElevated: '#181b22',
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
