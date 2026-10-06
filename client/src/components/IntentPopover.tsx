/**
 * 「卡在哪」入口：用户在题目页一次性声明卡点，写入 submission_intents。
 *
 * 为什么需要它：题源标签一题多标签是常态（实测 75.7% 的题有 ≥2 个标签），
 * 且低难度题的标签严重膨胀（贪心/数学各占 ~40%），因此从题目反推「用户哪个知识点不熟」
 * 是无解的。用户自己声明是唯一无歧义的归因来源。
 *
 * 交互刻意做到最小摩擦：Popover + 一次点击即写入，不做弹窗问卷。
 *
 * 可见可管（2026-10）：打开时拉取该题已记卡点展示在上方，单条可撤销——
 * 记完就消失 = 用户不知道记没记过、记错了也无法纠正，声明意愿会迅速萎缩。
 */
import { useEffect, useState } from 'react'
import { Button, Popover, Select, Space, Typography } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'
import { del, get, post } from '../api'
import { relativeTimeText } from '../syncStatus'
import {
  buildIntentBody,
  intentDeletePath,
  intentLabel,
  intentPath,
  intentsPath,
  INTENT_OPTIONS,
  type IntentOutcome,
  type IntentRecord,
} from '../intentOptions'

interface Props {
  platform: string
  problemKey: string
  /** 该题的知识点 code 候选（可留空 = 不指定知识点） */
  codeOptions?: ReadonlyArray<{ value: string; label: string }>
  /** 写入成功回调（通常用于关闭所在菜单 + 刷新当前页） */
  onDone?: () => void
  /** 记录或撤销成功后的回调（用于刷新行角标；不关闭 Popover） */
  onChanged?: () => void
  /** 成功提示回调（沿用调用方的 AntdApp.useApp() 实例，避免脱离 ConfigProvider） */
  onSuccess?: (msg: string) => void
  onError?: (msg: string) => void
}

export default function IntentPopover({
  platform,
  problemKey,
  codeOptions = [],
  onDone,
  onChanged,
  onSuccess,
  onError,
}: Props) {
  const [open, setOpen] = useState(false)
  const [outcome, setOutcome] = useState<IntentOutcome>('wrong_approach')
  const [code, setCode] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  const [records, setRecords] = useState<IntentRecord[] | null>(null)
  const [removingId, setRemovingId] = useState<number | null>(null)

  // 每次打开都重拉（量小、口径最新）；关闭不清空——重开时旧列表先顶住，避免闪 Empty
  useEffect(() => {
    if (!open) return
    get<{ items: IntentRecord[] }>(intentsPath(platform, problemKey))
      .then((res) => setRecords(res.items))
      .catch((e: Error) => onError?.(e.message))
  }, [open, platform, problemKey, onError])

  const submit = async () => {
    setSaving(true)
    try {
      const res = await post<{ ok: boolean; id: number }>(intentPath(platform, problemKey), buildIntentBody(outcome, code))
      // 本地追加即可更新列表：POST 已返回自增 id，无需为一条新记录重拉
      setRecords((prev) => [
        { id: res.id, code: code ?? null, outcome, createdAt: new Date().toISOString() },
        ...(prev ?? []),
      ])
      onSuccess?.('已记录卡点，弱项判断会据此更准')
      onChanged?.()
      setOpen(false)
      onDone?.()
    } catch (e) {
      onError?.((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: number) => {
    setRemovingId(id)
    try {
      await del(intentDeletePath(platform, problemKey, id))
      setRecords((prev) => prev?.filter((r) => r.id !== id) ?? [])
      onChanged?.()
    } catch (e) {
      onError?.((e as Error).message)
    } finally {
      setRemovingId(null)
    }
  }

  const content = (
    <Space direction="vertical" size={8} style={{ width: 240 }}>
      {records !== null && records.length > 0 && (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          {records.map((r) => (
            <div
              key={r.id}
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, lineHeight: '20px' }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <Typography.Text style={{ fontSize: 12 }}>{intentLabel(r.outcome)}</Typography.Text>
                {r.code && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {' '}
                    · {codeOptions.find((o) => o.value === r.code)?.label ?? r.code}
                  </Typography.Text>
                )}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {' '}
                  · {relativeTimeText(r.createdAt)}
                </Typography.Text>
              </span>
              <Button
                type="text"
                size="small"
                title="撤销这条记录"
                aria-label="撤销这条记录"
                loading={removingId === r.id}
                onClick={() => void remove(r.id)}
                icon={<DeleteOutlined style={{ fontSize: 12 }} />}
              />
            </div>
          ))}
        </Space>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        这题卡在哪？（一次点击即可，不必填完整）
      </Typography.Text>
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        {INTENT_OPTIONS.map((o) => (
          <Button
            key={o.value}
            size="small"
            block
            type={outcome === o.value ? 'primary' : 'default'}
            onClick={() => setOutcome(o.value)}
            title={o.hint}
          >
            {o.label}
          </Button>
        ))}
      </Space>
      <Select
        allowClear
        size="small"
        style={{ width: '100%' }}
        placeholder="哪个知识点？（可跳过）"
        value={code}
        onChange={setCode}
        options={codeOptions as { value: string; label: string }[]}
      />
      <Button type="primary" size="small" block loading={saving} onClick={() => void submit()}>
        记录
      </Button>
    </Space>
  )

  return (
    <Popover content={content} title="卡在哪" trigger="click" open={open} onOpenChange={setOpen}>
      <Button size="small" type="text">卡在哪</Button>
    </Popover>
  )
}
