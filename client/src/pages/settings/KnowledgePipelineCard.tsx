import { useEffect, useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  List,
  Modal,
  Row,
  Slider,
  Space,
  Spin,
} from 'antd'
import { DatabaseOutlined } from '@ant-design/icons'
import type { KnowledgeCompareReport, KnowledgeCoverage } from '../../../../shared/src/index.ts'
import { get, post } from '../../api'
import { pct } from '../../ui'

/** 知识点管线设置卡：统计置信度阈值 + 切换期双口径对比（tag vs 知识点弱项）。 */
export function KnowledgePipelineCard() {
  const { message } = AntdApp.useApp()
  const [threshold, setThreshold] = useState(0.6)
  const [saving, setSaving] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [compare, setCompare] = useState<KnowledgeCompareReport | null>(null)
  const [compareLoading, setCompareLoading] = useState(false)

  useEffect(() => {
    get<KnowledgeCoverage>('/api/knowledge/coverage')
      .then((c) => setThreshold(c.threshold))
      .catch(() => { /* 服务端未升级时忽略 */ })
  }, [])

  const saveThreshold = async (v: number) => {
    setSaving(true)
    try {
      const r = await post<{ threshold: number }>('/api/knowledge/threshold', { value: v })
      setThreshold(r.threshold)
      message.success(`阈值已保存：${r.threshold}（掌握度地图、题单统计、覆盖率已标注数、双口径对比未覆盖桶即时生效；弱项画像不受此阈值影响）`)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const openCompare = async () => {
    setCompareOpen(true)
    setCompareLoading(true)
    try {
      setCompare(await get<KnowledgeCompareReport>('/api/knowledge/compare'))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setCompareLoading(false)
    }
  }

  const renderCaliber = (items: KnowledgeCompareReport['knowledgeCaliber']) => (
    <List
      size="small"
      dataSource={items}
      locale={{ emptyText: '暂无数据（提交数不足）' }}
      renderItem={(it) => (
        <List.Item>
          <span style={{ flex: 1 }}>{it.tag}</span>
          <span className="mono" style={{ color: 'var(--text-3)' }}>
            {it.attempts} 提交 · AC {pct(it.acRate)} · 差 {pct(it.gap)}
          </span>
        </List.Item>
      )}
    />
  )

  return (
    <Card title={<span className="settings-section-title"><DatabaseOutlined />知识点管线</span>} size="small">
      <div style={{ maxWidth: 480 }}>
        <div style={{ marginBottom: 4 }}>
          统计置信度阈值：<strong>{threshold.toFixed(2)}</strong>
        </div>
        <Slider
          min={0}
          max={1}
          step={0.05}
          marks={{ 0: '0', 0.5: '0.5', 1: '1' }}
          value={threshold}
          disabled={saving}
          onChange={(v) => setThreshold(v)}
          onChangeComplete={(v) => void saveThreshold(v)}
        />
      </div>
      <Space wrap style={{ marginTop: 8 }}>
        <Button onClick={() => void openCompare()}>双口径对比（tag vs 知识点）</Button>
        <span className="muted-note">
          阈值过滤低置信标注，只影响统计口径，不删标注数据；双口径对比用于切换期观察两种统计的弱项差异。
          题库页「知识点管线」按钮可跑批跑/人工校正。
        </span>
      </Space>

      <Modal
        title="双口径对比：题源 tag 口径 vs 自建知识点口径（弱项 Top）"
        open={compareOpen}
        onCancel={() => setCompareOpen(false)}
        footer={null}
        width={880}
      >
        <Spin spinning={compareLoading}>
          {compare && (
            <>
              <Row gutter={24}>
                <Col span={12}>
                  <div className="settings-section-title" style={{ marginBottom: 8 }}>题源 tag 口径</div>
                  {renderCaliber(compare.tagCaliber)}
                </Col>
                <Col span={12}>
                  <div className="settings-section-title" style={{ marginBottom: 8 }}>
                    知识点口径（阈值 {compare.threshold}）
                  </div>
                  {renderCaliber(compare.knowledgeCaliber)}
                </Col>
              </Row>
              {compare.uncovered && (
                <Alert
                  style={{ marginTop: 12 }}
                  type="info"
                  showIcon
                  message={`未覆盖桶：${compare.uncovered.attempts} 次提交所属题目无达标知识点标注（统计端回退题源 tag），AC 率 ${pct(compare.uncovered.acRate)}。跑管线可提高覆盖率。`}
                />
              )}
            </>
          )}
        </Spin>
      </Modal>
    </Card>
  )
}
