import { Layout, Menu } from 'antd'
import {
  CalendarOutlined,
  DashboardOutlined,
  FileTextOutlined,
  ScheduleOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import Problems from './pages/Problems'
import Plans from './pages/Plans'
import CalendarPage from './pages/Calendar'
import Settings from './pages/Settings'
import Reminder from './Reminder'

const { Sider, Content } = Layout

const MENU = [
  { key: '/', icon: <DashboardOutlined />, label: '仪表盘' },
  { key: '/problems', icon: <FileTextOutlined />, label: '题目管理' },
  { key: '/plans', icon: <ScheduleOutlined />, label: '训练计划' },
  { key: '/calendar', icon: <CalendarOutlined />, label: '日历打卡' },
  { key: '/settings', icon: <SettingOutlined />, label: '设置' },
]

export default function App() {
  const nav = useNavigate()
  const loc = useLocation()
  const selected = MENU.some((m) => m.key === loc.pathname) ? loc.pathname : '/'

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Reminder />
      <Sider theme="dark" width={216} className="app-sider">
        <div className="sider-logo">
          <span className="sider-logo-badge">
            <img src="/favicon.svg" alt="logo" />
          </span>
          <span className="sider-logo-text">
            ICPC Workbench
            <span className="sider-logo-sub">COMPETITIVE PROGRAMMING</span>
          </span>
        </div>
        <div className="sider-divider" />
        <Menu
          className="sider-menu"
          theme="dark"
          mode="inline"
          selectedKeys={[selected]}
          items={MENU}
          onClick={({ key }) => nav(key)}
        />
        <div className="sider-footer">
          <span className="sider-footer-dot" />
          v0.1.0 · 本地运行
        </div>
      </Sider>
      <Content style={{ padding: 24, background: 'transparent' }}>
        <div className="content-container page-content" key={loc.pathname}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/problems" element={<Problems />} />
            <Route path="/plans" element={<Plans />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </Content>
    </Layout>
  )
}
