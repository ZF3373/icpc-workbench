import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Layout, Menu, Tooltip } from 'antd'
import {
  CalendarOutlined,
  CodeOutlined,
  DashboardOutlined,
  FileTextOutlined,
  FlagOutlined,
  HeatMapOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ReadOutlined,
  ScheduleOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import type { ItemType } from 'antd/es/menu/interface'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import Problems from './pages/Problems'
import Plans from './pages/Plans'
import CalendarPage from './pages/Calendar'
import Settings from './pages/Settings'
import Today from './pages/Today'
import Reviews from './pages/Reviews'
import Contests from './pages/Contests'
import Templates from './pages/Templates'
import Mastery from './pages/Mastery'
import Reminder from './Reminder'
import ContestReminder from './ContestReminder'
import UpdateChecker from './UpdateChecker'
import { get } from './api'

const { Sider, Content } = Layout

const MENU: Array<{ key: string; icon: ReactNode; label: string }> = [
  { key: '/', icon: <DashboardOutlined />, label: '数据概览' },
  { key: '/today', icon: <ThunderboltOutlined />, label: '今日训练' },
  { key: '/templates', icon: <CodeOutlined />, label: '模板库' },
  { key: '/problems', icon: <FileTextOutlined />, label: '题目管理' },
  { key: '/mastery', icon: <HeatMapOutlined />, label: '掌握度地图' },
  { key: '/plans', icon: <ScheduleOutlined />, label: '训练计划' },
  { key: '/calendar', icon: <CalendarOutlined />, label: '日历打卡' },
  { key: '/reviews', icon: <ReadOutlined />, label: '复习库' },
  { key: '/contests', icon: <FlagOutlined />, label: '赛事中心' },
  { key: '/settings', icon: <SettingOutlined />, label: '设置' },
]

const menuIcon = (key: string) => MENU.find((m) => m.key === key)?.icon
const menuLabel = (key: string) => MENU.find((m) => m.key === key)?.label ?? key

/** 分组导航：训练动作 / 记录与检索 / 系统。折叠态由 AntD 自动隐藏组标题。 */
const MENU_ITEMS: ItemType[] = [
  { key: '/', icon: menuIcon('/'), label: menuLabel('/') },
  {
    type: 'group',
    label: '训练',
    children: [
      { key: '/today', icon: menuIcon('/today'), label: menuLabel('/today') },
      { key: '/templates', icon: menuIcon('/templates'), label: menuLabel('/templates') },
      { key: '/plans', icon: menuIcon('/plans'), label: menuLabel('/plans') },
      { key: '/reviews', icon: menuIcon('/reviews'), label: menuLabel('/reviews') },
    ],
  },
  {
    type: 'group',
    label: '题库与记录',
    children: [
      { key: '/problems', icon: menuIcon('/problems'), label: menuLabel('/problems') },
      { key: '/mastery', icon: menuIcon('/mastery'), label: menuLabel('/mastery') },
      { key: '/calendar', icon: menuIcon('/calendar'), label: menuLabel('/calendar') },
      { key: '/contests', icon: menuIcon('/contests'), label: menuLabel('/contests') },
    ],
  },
  { key: '/settings', icon: menuIcon('/settings'), label: menuLabel('/settings') },
]

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
        <Menu
          className="sider-menu"
          theme="dark"
          mode="inline"
          selectedKeys={[selected]}
          items={MENU_ITEMS}
          onClick={({ key }) => nav(key)}
        />
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
            <Route path="/templates" element={<Templates />} />
            <Route path="/problems" element={<Problems />} />
            <Route path="/mastery" element={<Mastery />} />
            <Route path="/plans" element={<Plans />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/reviews" element={<Reviews />} />
            <Route path="/contests" element={<Contests />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </Content>
    </Layout>
  )
}
