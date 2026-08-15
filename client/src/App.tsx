import { Layout, Menu, theme } from 'antd'
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
  const { token } = theme.useToken()
  const selected = MENU.some((m) => m.key === loc.pathname) ? loc.pathname : '/'

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Reminder />
      <Sider theme="dark" width={200}>
        <div
          style={{
            color: '#fff',
            padding: '16px',
            fontWeight: 600,
            fontSize: 16,
            whiteSpace: 'nowrap',
          }}
        >
          ICPC Workbench
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selected]}
          items={MENU}
          onClick={({ key }) => nav(key)}
        />
      </Sider>
      <Content style={{ padding: 24, background: token.colorBgLayout }}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/problems" element={<Problems />} />
          <Route path="/plans" element={<Plans />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </Content>
    </Layout>
  )
}
