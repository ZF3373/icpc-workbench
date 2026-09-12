import { useEffect, useState } from 'react'
import { Layout, Tooltip } from 'antd'
import { MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import Problems from './pages/Problems'
import Plans from './pages/Plans'
import Assistant from './pages/Assistant'
import Lists from './pages/Lists'
import CalendarPage from './pages/Calendar'
import Settings from './pages/Settings'
import About from './pages/About'
import Today from './pages/Today'
import Reviews from './pages/Reviews'
import Contests from './pages/Contests'
import Templates from './pages/Templates'
import Mastery from './pages/Mastery'
import Reminder from './Reminder'
import ContestReminder from './ContestReminder'
import UpdateChecker from './UpdateChecker'
import { get } from './api'
import SiderMenu from './components/SiderMenu'
import { MENU } from './menuConfig'

const { Sider, Content } = Layout

export default function App() {
  const nav = useNavigate()
  const loc = useLocation()
  const selected = MENU.some((m) => m.key === loc.pathname) ? loc.pathname : '/'
  const [collapsed, setCollapsed] = useState(false)
  const [version, setVersion] = useState('')

  useEffect(() => {
    // 侧边栏版本号取自后端（exe 打包时注入 git tag；源码运行为 dev）
    get<{ version?: string }>('/api/health')
      .then((h) => setVersion(h.version ?? ''))
      .catch(() => {})
  }, [])

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Reminder />
      <ContestReminder />
      <Sider
        width={200}
        collapsedWidth={68}
        collapsed={collapsed}
        className="app-sider"
      >
        <div className="sider-logo">
          {collapsed ? (
            <Tooltip title="ICPC Workbench" placement="right">
              <span className="sider-logo-badge">
                <img src="/favicon.svg" alt="logo" />
              </span>
            </Tooltip>
          ) : (
            <span className="sider-logo-badge">
              <img src="/favicon.svg" alt="logo" />
            </span>
          )}
          <span className="sider-logo-text">
            ICPC Workbench
            <span className="sider-logo-sub">备赛工作台</span>
          </span>
        </div>
        <SiderMenu selected={selected} collapsed={collapsed} onNavigate={nav} />
        <div className="sider-footer">
          <button
            type="button"
            className="sider-footer-toggle"
            title={collapsed ? '展开侧栏' : '收起侧栏'}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </button>
          <span className="sider-footer-version">
            <span className="sider-footer-dot" />
            {version || 'local'}
          </span>
        </div>
      </Sider>
      <Content style={{ padding: '20px 24px 24px', background: 'transparent' }}>
        <UpdateChecker />
        <div className="content-container page-content" key={loc.pathname}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/today" element={<Today />} />
            <Route path="/ai" element={<Assistant />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/lists" element={<Lists />} />
            <Route path="/problems" element={<Problems />} />
            <Route path="/mastery" element={<Mastery />} />
            <Route path="/plans" element={<Plans />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/reviews" element={<Reviews />} />
            <Route path="/contests" element={<Contests />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/about" element={<About />} />
          </Routes>
        </div>
      </Content>
    </Layout>
  )
}
