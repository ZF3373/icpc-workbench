import { Suspense, lazy, useEffect, useState } from 'react'
import { Layout, Tooltip } from 'antd'
import { IconPanelLeft, IconPanelRight, IconSearch } from './components/icons'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
// 首屏页面保持同步 import：Dashboard 是默认路由，懒加载只会多一次往返
import Dashboard from './pages/Dashboard'
// 其余页面路由级懒加载：recharts / katex / codemirror 等重依赖随之拆出主 chunk
const Problems = lazy(() => import('./pages/Problems'))
const Plans = lazy(() => import('./pages/Plans'))
const Assistant = lazy(() => import('./pages/Assistant'))
const Lists = lazy(() => import('./pages/Lists'))
const CalendarPage = lazy(() => import('./pages/Calendar'))
const Settings = lazy(() => import('./pages/Settings'))
const About = lazy(() => import('./pages/About'))
const Today = lazy(() => import('./pages/Today'))
const Reviews = lazy(() => import('./pages/Reviews'))
const Contests = lazy(() => import('./pages/Contests'))
const Templates = lazy(() => import('./pages/Templates'))
const Mastery = lazy(() => import('./pages/Mastery'))
import PageSkeleton from './components/PageSkeleton'
import Reminder from './Reminder'
import ContestReminder from './ContestReminder'
import UpdateChecker from './UpdateChecker'
import SyncProgressBadge from './SyncProgressBadge'
import { get } from './api'
import SiderMenu from './components/SiderMenu'
import CommandPalette from './components/CommandPalette'
import { MENU } from './menuConfig'
import { pushRecentPage } from './recentPages'
import ZoomControl from './components/ZoomControl'

const { Sider, Content } = Layout

export default function App() {
  const nav = useNavigate()
  const loc = useLocation()
  const selected = MENU.some((m) => m.key === loc.pathname) ? loc.pathname : '/'
  const [collapsed, setCollapsed] = useState(false)
  const [version, setVersion] = useState('')
  /** 全局命令面板（Cmd/Ctrl + K） */
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    // 侧边栏版本号取自后端（exe 打包时注入 git tag；源码运行为 dev）
    get<{ version?: string }>('/api/health')
      .then((h) => setVersion(h.version ?? ''))
      .catch(() => {})
  }, [])

  // 记录最近访问（命令面板的第一个分组）；只记已知路由，避免把带 query 的地址记成两个入口
  useEffect(() => {
    if (MENU.some((m) => m.key === loc.pathname)) pushRecentPage(loc.pathname)
  }, [loc.pathname])

  // 快捷键：Cmd/Ctrl + K 唤起命令面板，Esc 由面板自己处理
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <Layout style={{ minHeight: 'var(--app-viewport-height)' }}>
      <Reminder />
      <ContestReminder />
      {/* 全局同步悬浮卡：切到任何页面都能看到「还在同步」，避免用户误以为卡住而退出 */}
      <SyncProgressBadge />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={nav} />
      <Sider
        width={222}
        collapsedWidth={68}
        collapsed={collapsed}
        breakpoint="md"
        onBreakpoint={setCollapsed}
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
        <div className="sider-zoom"><ZoomControl kind="global" compact={collapsed} /></div>
        <div className="sider-footer">
          <button
            type="button"
            className="sider-footer-toggle"
            title={collapsed ? '展开侧栏' : '收起侧栏'}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? <IconPanelRight size={16} /> : <IconPanelLeft size={16} />}
          </button>
          {!collapsed && (
            <button
              type="button"
              className="sider-footer-search"
              title="全局搜索（Ctrl/⌘ + K）"
              onClick={() => setPaletteOpen(true)}
            >
              <IconSearch size={14} />
              <span>搜索</span>
              <kbd>⌘K</kbd>
            </button>
          )}
          <span className="sider-footer-version">
            <span className="sider-footer-dot" />
            {version || 'local'}
          </span>
        </div>
      </Sider>
      {/* 内边距与底色统一交给 index.css 的 .app-content（亮色极简版需要更大的留白，
          内联 style 会盖掉主题样式，所以这里不再写死 padding） */}
      <Content className="app-content">
        <UpdateChecker />
        <div className="content-container page-content" key={loc.pathname}>
          {/* Suspense 放 key 容器内层：切路由时 key 先强制重挂载，再按新页面 chunk 加载显示骨架 */}
          <Suspense fallback={<PageSkeleton stats={false} table rows={8} />}>
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
          </Suspense>
        </div>
      </Content>
    </Layout>
  )
}
