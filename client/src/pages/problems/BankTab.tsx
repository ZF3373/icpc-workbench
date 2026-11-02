import { useMemo, useState } from 'react'
import { App as AntdApp, Button, InputNumber, Select, Space, Switch } from 'antd'
import { CloudDownloadOutlined } from '@ant-design/icons'
import type { PlatformId } from '../../../../shared/src/index.ts'
import { PLATFORMS } from '../../../../shared/src/index.ts'
import { post } from '../../api'
import { bankTaskKey } from '../../backgroundRuns'
import { startBackgroundTask, useBackgroundTask } from '../../backgroundTasks'
import { platformName } from '../../ui'
import { BackfillDifficultyCard } from './BackfillDifficultyCard'

const LUOGU_DIFFICULTY_OPTIONS = [
  { value: 2, label: '普及- 及以上（含入门水题）' },
  { value: 3, label: '普及/提高- 及以上（推荐）' },
  { value: 4, label: '普及+/提高 及以上' },
  { value: 5, label: '提高+/省选- 及以上' },
  { value: 6, label: '省选/NOI- 及以上' },
]

/** 平台默认拉取条数：CF / AtCoder 单次 API 调用即可拿全量，LeetCode 全量约 3300 题、代码源约 500 题、
 *  DashOJ 约 2000+ 题（蓝桥杯/考研真题持续新增，取上限 5000 一次拉全，实际由站点页数终止） */
function defaultBankMax(p: PlatformId): number {
  return p === 'codeforces' ? 10000 : p === 'leetcode' ? 3500 : p === 'atcoder' ? 5000 : p === 'dashoj' ? 5000 : 1000
}

interface BankResponse {
  ok: boolean
  platform: string
  total: number | null
  fetched: number
  inserted: number
  updated: number
  tagScanned?: number
  tagMatched?: number
  tagWithTags?: number
  tagSkipped?: number
}

function bankResultText(r: BankResponse): string {
  const totalPart = r.total ? `（题库共 ${r.total} 题）` : ''
  // 标签桥统计只在真的开了桥时由服务端下发（未开时无这些键）
  const tagPart =
    r.tagScanned === undefined
      ? ''
      : `；洛谷镜像补标签：扫描 ${r.tagScanned} 题、命中题号 ${r.tagMatched ?? 0}、其中带标签 ${r.tagWithTags ?? 0}`
  return `拉取 ${r.fetched} 题${totalPart}：新增 ${r.inserted}，更新 ${r.updated}${tagPart}`
}

/** 「拉取题库」页签：从公开题库批量入库，扩充训练计划待选题池（无需账号）。 */
export function BankTab({ onStarted }: { onStarted: () => void }) {
  const { message } = AntdApp.useApp()
  // 平台列表来自共享定义的题库能力（PLATFORMS.hasBank），不硬编码：QOJ 无公开题库接口，故不在此提供
  const bankPlatforms = useMemo(() => PLATFORMS.filter((p) => p.hasBank), [])
  const [platform, setPlatform] = useState<PlatformId>('luogu')
  const [max, setMax] = useState(() => defaultBankMax('luogu'))
  const [luoguMin, setLuoguMin] = useState(3)
  // AtCoder：用洛谷 AT 镜像题补算法标签（默认关，覆盖有限）。仅该平台时随请求下发 atcoderTags
  const [atcoderTags, setAtcoderTags] = useState(false)
  const task = useBackgroundTask(bankTaskKey(platform))
  const busy = task?.status === 'running'

  const switchPlatform = (v: PlatformId) => {
    setPlatform(v)
    setMax(defaultBankMax(v))
  }

  const run = () => {
    const body = {
      platform,
      max,
      ...(platform === 'luogu' ? { luoguMinDifficulty: luoguMin } : {}),
      ...(platform === 'atcoder' && atcoderTags ? { atcoderTags: true } : {}),
    }
    const started = startBackgroundTask<BankResponse>({
      key: bankTaskKey(platform),
      title: `拉取题库 · ${platformName(platform)}`,
      href: '/problems',
      run: () => post<BankResponse>('/api/problems/bank', body),
      describe: bankResultText,
    })
    if (started) {
      message.info('已开始拉取，可以切换页面，进度见右下角')
      // 弹窗遮罩会挡住侧边栏：任务开始就关掉，用户才切得了页面
      onStarted()
    }
  }

  return (
    <div>
      <p style={{ color: 'var(--text-3)' }}>
        软件已内置 Codeforces 等题库，开箱即可供训练计划/题单选题；需要更多题目时从这里扩充（无需账号/Cookie，不影响刷题统计）。
        Codeforces / AtCoder 一次调用秒级完成；洛谷/牛客/LeetCode/代码源按页拉取，拉取量越大耗时越长（约 1-2 分钟/千题）。
        列表只列有公开题库的平台（QOJ 无题库接口，故不提供拉取）。
      </p>
      <Space wrap>
        <Select
          style={{ width: 140 }}
          value={platform}
          onChange={switchPlatform}
          options={bankPlatforms.map((p) => ({ value: p.id, label: p.name }))}
        />
        <InputNumber
          min={50}
          max={platform === 'codeforces' ? 20000 : platform === 'atcoder' ? 10000 : platform === 'dashoj' ? 20000 : 5000}
          step={platform === 'codeforces' || platform === 'atcoder' ? 500 : 50}
          value={max}
          onChange={(v) => setMax(v ?? 1000)}
          addonAfter="题"
          style={{ width: 140 }}
        />
        <Button type="primary" icon={<CloudDownloadOutlined />} loading={busy} onClick={run}>
          拉取题库
        </Button>
      </Space>
      {platform === 'luogu' && (
        <div style={{ marginTop: 12 }}>
          <Select
            style={{ width: 300 }}
            value={luoguMin}
            onChange={setLuoguMin}
            options={LUOGU_DIFFICULTY_OPTIONS}
          />
        </div>
      )}
      {platform === 'atcoder' && (
        <div style={{ marginTop: 12 }}>
          <Space>
            <Switch checked={atcoderTags} onChange={setAtcoderTags} />
            <span style={{ color: 'var(--text-3)' }}>
              用洛谷镜像补标签（默认关；覆盖有限：实测 250 行样本中 139 行命中题号、仅 68 行真的带标签，
              结果里的命中计数如实回传）
            </span>
          </Space>
        </div>
      )}
      {task?.status === 'done' && task.resultText && <p style={{ marginTop: 12 }}>{task.resultText}</p>}
      {task?.status === 'error' && <p style={{ marginTop: 12, color: 'var(--red)' }}>拉取失败：{task.error}</p>}
      <BackfillDifficultyCard onStarted={onStarted} />
    </div>
  )
}

