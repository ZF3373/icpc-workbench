import type { PlatformId } from '../../shared/src/index.ts'

export interface TrainingAccount {
  platform: PlatformId
  handle: string
  enabled?: number
}

/** 稳定账号键选择；同平台多个账号全部保留，禁用账号不参与同步。 */
export function syncTargets(accounts: TrainingAccount[], selection = '*', platform?: PlatformId): TrainingAccount[] {
  return accounts.filter((a) => a.enabled !== 0 && (!platform || a.platform === platform)
    && (selection === '*' || `${a.platform}:${a.handle}` === selection))
}
