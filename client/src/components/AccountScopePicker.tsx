/**
 * 账号视角切换器（多账号统计隔离）。
 *
 * v0.8 允许同平台绑多个账号，但统计族接口此前只按 user_id 聚合，主力号 + 练习小号
 * 的 AC 率会被静默混算。这里给出「全部账号 / 某个具体账号」的入口，选中值持久化在
 * localStorage（见 accountScope.ts），各统计页共用同一个视角。
 * 只有一个账号时不显示——没有可比对象，白白占掉页头位置。
 */
import { useEffect, useMemo, useState } from 'react'
import { Select } from 'antd'
import type { AccountRow, AccountScope } from '../accountScope'
import { ALL_ACCOUNTS, isAllAccounts, pickerVisible } from '../accountScope'
import { platformName } from '../ui'
import { get } from '../api'

const ALL_VALUE = -1

export default function AccountScopePicker({
  value,
  onChange,
}: {
  value: AccountScope
  onChange: (scope: AccountScope) => void
}) {
  const [rows, setRows] = useState<AccountRow[] | null>(null)

  useEffect(() => {
    let current = true
    get<AccountRow[]>('/api/stats/accounts')
      .then((r) => {
        if (current) setRows(r)
      })
      .catch(() => {
        // 账号列表拿不到就不显示切换器：统计页仍按全部账号正常展示
        if (current) setRows([])
      })
    return () => {
      current = false
    }
  }, [])

  const selectedIndex = useMemo(
    () =>
      rows && !isAllAccounts(value)
        ? rows.findIndex((a) => a.platform === value.platform && a.account === value.account)
        : ALL_VALUE,
    [rows, value],
  )

  // 账号被删掉后 localStorage 里可能还留着它，服务端会按不存在的账号过滤出空画像 ——
  // 直接退回「全部账号」，让用户看到数据而不是诡异的 0
  useEffect(() => {
    if (!rows || isAllAccounts(value) || selectedIndex >= 0) return
    onChange(ALL_ACCOUNTS)
  }, [rows, value, selectedIndex, onChange])

  if (!rows || !pickerVisible(rows)) return null

  return (
    <Select
      size="small"
      style={{ minWidth: 200 }}
      value={selectedIndex < 0 ? ALL_VALUE : selectedIndex}
      onChange={(idx) => {
        if (idx === ALL_VALUE) {
          onChange(ALL_ACCOUNTS)
          return
        }
        const row = rows[idx]
        onChange({ platform: row.platform, account: row.account })
      }}
      options={[
        { value: ALL_VALUE, label: '全部账号' },
        ...rows.map((a, i) => ({
          value: i,
          label: `${platformName(a.platform)} · ${a.account}（${a.attempts} 次提交 / ${a.solved} 题）`,
        })),
      ]}
    />
  )
}