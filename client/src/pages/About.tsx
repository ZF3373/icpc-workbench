import { useEffect, useState } from 'react'
import { Alert, Button, Card, Col, Progress, Row, Space, Tooltip } from 'antd'
import {
  AppstoreOutlined,
  DatabaseOutlined,
  GithubOutlined,
  InfoCircleOutlined,
  LinkOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/PageHeader'
import { get } from '../api'
import { openExternal } from '../externalLinks'
import { useSoftwareUpdate } from '../updateContext'

const GITHUB_REPO_URL = 'https://github.com/ZF3373/icpc-workbench'

/** 软件介绍要点 */
const FEATURES: { title: string; desc: string }[] = [
  { title: '多平台刷题导入', desc: 'CF / AtCoder 自动同步，洛谷 / 代码源 / LeetCode 配 Cookie 后同步' },
  { title: '弱项分析', desc: '按标签 / 难度 / 平台统计 AC 率，输出弱项画像与趋势' },
  { title: '掌握度地图', desc: '按知识点五档评估，串联刷题数据与模板课程' },
  { title: 'AI 训练计划', desc: '一键生成个性化计划，或导出喂给任意 AI' },
  { title: 'AI 助手', desc: '算法问答、代码调试、联网搜索、文档附件' },
  { title: '模板库 / 题单 / 复习库', desc: '内置算法课程、题单整理、遗忘曲线复习' },
  { title: '赛事中心 / 日历打卡', desc: '四平台赛事聚合，逐任务打卡与提醒' },
]

export default function About() {
  const { info, checking, check, phase, percent, busy, result, runUpdate } = useSoftwareUpdate()
  const [appVersion, setAppVersion] = useState('')
  const [dataDir, setDataDir] = useState('')

  useEffect(() => {
    get<{ version?: string; dbPath?: string }>('/api/health')
      .then((h) => {
        setAppVersion(h.version ?? '')
        // dbPath 形如 .../server/data/icpc.db，取其所在目录作为数据文件夹绝对路径
        if (h.dbPath) {
          const parts = h.dbPath.replace(/\\/g, '/')
          setDataDir(parts.substring(0, parts.lastIndexOf('/')))
        }
      })
      .catch(() => {})
  }, [])

  return (
    <div>
      <PageHeader title="关于" description="了解 ICPC Workbench 与检查软件更新" />

      <Row gutter={[16, 24]}>
        {/* 软件介绍 */}
        <Col span={24}>
          <Card
            title={
              <span className="settings-section-title">
                <InfoCircleOutlined />
                软件介绍
              </span>
            }
            size="small"
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
              <img src="/favicon.svg" alt="logo" style={{ width: 48, height: 48 }} />
              <div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>
                  ICPC Workbench <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--text-3)' }}>· ICPC 备赛工作台</span>
                </div>
              </div>
            </div>
            <p className="muted-note" style={{ marginBottom: 16 }}>
              基于刷题记录分析弱项、由 AI 生成个性化训练计划，并提供日历打卡的本地 Web 应用。数据存储在本地 SQLite，隐私安全。
            </p>
            <Row gutter={[16, 12]}>
              {FEATURES.map((f) => (
                <Col key={f.title} xs={24} md={12} lg={8}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2, color: 'var(--brand)' }}>{f.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.6 }}>{f.desc}</div>
                </Col>
              ))}
            </Row>
            <div style={{ marginTop: 20, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Button icon={<GithubOutlined />} onClick={() => openExternal(GITHUB_REPO_URL)}>
                GitHub 仓库
              </Button>
              <Button icon={<LinkOutlined />} onClick={() => openExternal(`${GITHUB_REPO_URL}/releases`)}>
                发布页面
              </Button>
            </div>
          </Card>
        </Col>

        {/* 数据说明 */}
        <Col span={24}>
          <Card
            title={
              <span className="settings-section-title">
                <DatabaseOutlined />
                数据说明
              </span>
            }
            size="small"
          >
            <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-2)' }}>
              所有数据（刷题记录、训练计划、模板、设置等）存储在本地 SQLite 数据库（<b className="mono">icpc.db</b>），不上传任何服务器。
            </p>
            {dataDir && (
              <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>数据目录：</span>
                <b className="mono" style={{ fontSize: 13, color: 'var(--brand-text)', wordBreak: 'break-all' }}>{dataDir}</b>
              </div>
            )}
            <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '12px 16px', fontSize: 13, color: 'var(--text-3)', lineHeight: 1.8 }}>
              <b style={{ color: 'var(--text-2)' }}>迁移到新电脑 / 新位置：</b><br />
              ① 关闭软件 → ② 复制整个数据目录到新位置 → ③ 在新位置启动软件即可，数据完整保留。<br />
              <b style={{ color: 'var(--text-2)' }}>备份：</b>复制数据目录下的 <b className="mono">icpc.db</b> 到任意位置即可；恢复时覆盖回原文件。
            </div>
          </Card>
        </Col>

        {/* 软件更新（单独卡片） */}
        <Col span={24}>
          <Card
            title={
              <span className="settings-section-title">
                <AppstoreOutlined />
                软件更新
              </span>
            }
            size="small"
          >
            <Space wrap>
              <span>
                当前版本：<b>{appVersion || '未知'}</b>
              </span>
              <Button loading={checking} onClick={check}>
                检查更新
              </Button>
            </Space>
            {/* 通道选项：一行一个通道（名称 + 版本 + 一键更新），不搞确认弹窗与长段说明 */}
            {info?.ok && (info.hasUpdate || info.hasCommitUpdate) && (
              <div className="update-channels">
                {info.hasUpdate && (
                  <div className="update-channel">
                    <span className="update-channel__name">正式版</span>
                    <span className="update-channel__ver mono">{info.latest}</span>
                    {info.canSelfUpdate && info.stableDownload ? (
                      <Button type="primary" size="small" loading={busy} onClick={() => runUpdate('stable')}>
                        一键更新
                      </Button>
                    ) : (
                      info.releasePage && (
                        <Button size="small" type="primary" onClick={() => openExternal(info.releasePage!)}>
                          前往下载
                        </Button>
                      )
                    )}
                  </div>
                )}
                {info.hasCommitUpdate && (
                  <div className="update-channel">
                    <span className="update-channel__name">预览版</span>
                    <span className="update-channel__ver mono">{info.commit?.shortSha}</span>
                    {info.canSelfUpdate && info.commitDownload ? (
                      <Tooltip title="自动构建、可能未完善；回退需重装旧版本">
                        <Button size="small" loading={busy} onClick={() => runUpdate('commit')}>
                          一键更新
                        </Button>
                      </Tooltip>
                    ) : (
                      info.commit?.page && (
                        <Button size="small" onClick={() => openExternal(info.commit!.page)}>
                          查看构建
                        </Button>
                      )
                    )}
                  </div>
                )}
              </div>
            )}
            {info?.ok && !info.hasUpdate && !info.hasCommitUpdate && (
              <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--text-3)' }}>
                已是最新版本{info.buildCommit && info.buildCommit !== 'dev' ? `（${info.buildCommit}）` : ''}
              </p>
            )}
            {info && !info.ok && (
              <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--amber)' }}>
                检查更新失败：{info.message ?? '网络异常'}，可稍后重试
              </p>
            )}
            {busy && (
              <div style={{ marginTop: 12, maxWidth: 720 }}>
                <Progress percent={percent} status="active" />
                <span style={{ color: 'var(--text-3)', fontSize: 12 }}>
                  {phase === 'verifying' ? '正在校验文件完整性…' : '正在下载更新（下载完自动替换，请勿关闭软件）'}
                </span>
              </div>
            )}
            {result && (
              <Alert
                style={{ marginTop: 12, maxWidth: 720 }}
                type={result.ok ? 'success' : 'error'}
                showIcon
                message={result.text}
              />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  )
}
