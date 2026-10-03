/**
 * 账号视角切换器（多账号统计隔离）。
 *
 * v0.8 允许同平台绑多个账号，但统计族接口此前只按 user_id 聚合，主力号 + 练习小号
 * 的 AC 率会被静默混算。这里给出「全部账号 / 某个具体账号」的入口，选中值持久化在
 * localStorage（见 accountScope.ts），各统计页共用同一个视角。
 * 只有一个账号时不显示——没有可比对象，白白占掉页头位置。
 *
 * Select 的 value 用 `platform:account` 稳定键值（见 accountScope.ts 的 accountKey），
 * **不再用数组下标**：账号增删或排序变化后，同一个下标会指向另一个账号，用户看到的
 * 选中项没变而实际统计口径已经换号 —— 属于静默串数据。
 */
import { useEffect, useMemo, useState } from 'react'
import { Select } from 'antd'
import type { AccountRow, AccountScope } from '../accountScope'
import {
  ALL_ACCOUNTS,
  ALL_ACCOUNTS_KEY,
  accountKey,
  isAllAccounts,
  parseAccountKey,
  pickerVisible,
  scopeKey,
} from '../accountScope'
import { platformName } from '../ui'
import { get } from '../api'

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

  const options = useMemo(
    () => [
      { value: ALL_ACCOUNTS_KEY, label: '全部账号' },
      ...(rows ?? []).map((a) => ({
        value: accountKey(a.platform, a.account),
        label: `${platformName(a.platform)} · ${a.account}（${a.attempts} 次提交 / ${a.solved} 题）`,
      })),
    ],
    [rows],
  )

  // 账号被删掉后 localStorage 里可能还留着它，服务端会按不存在的账号过滤出空画像 ——
  // 直接退回「全部账号」，让用户看到数据而不是诡异的 0。
  // 判断依据是「当前 scope 是否还能在账号列表里找到」，与 Select 的键值表示无关。
  useEffect(() => {
    if (!rows || isAllAccounts(value)) return
    const stillExists = rows.some((a) => a.platform === value.platform && a.account === value.account)
    if (!stillExists) onChange(ALL_ACCOUNTS)
  }, [rows, value, onChange])

  if (!rows || !pickerVisible(rows)) return null

  return (
    <Select
      size="small"
      style={{ minWidth: 200 }}
      value={scopeKey(value)}
      onChange={(key) => {
        if (key === ALL_ACCOUNTS_KEY) {
          onChange(ALL_ACCOUNTS)
          return
        }
        const parsed = parseAccountKey(key)
        // 解析不出来（理论上只有脏数据）就不改视角，避免写进半截作用域
        if (parsed) onChange(parsed)
      }}
      options={options}
    />
  )
}
