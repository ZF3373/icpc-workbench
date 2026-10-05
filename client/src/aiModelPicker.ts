/**
 * 「获取可用模型」勾选采纳的纯逻辑（与 AiSettingsCard 组件解耦，便于单测）。
 *
 * 为什么单独成文件：目录条目上限（AI_PROVIDER_MODELS_MAX）是**服务端也会强制**的口径
 * （见 server/src/config.ts 的 sanitizeModelEntries）——若前端「全选」一次性加入几百条
 * （OpenRouter 等网关会返回上百个模型），保存时服务端会静默截到上限，而界面仍显示全部；
 * 且结构对账为了保住未保存的编辑，不会用服务端的目录回写草稿，于是「界面 300 条 / 库里
 * 50 条」永久不一致、用户看不到任何提示。这里把上限判断前移到采纳动作，
 * 并回报被丢弃的条数供界面提示。
 */
import { AI_PROVIDER_MODELS_MAX, type AiProviderModelEntry, type ModelCaps } from '../../shared/src/index.ts'

/** 网关返回的候选模型（可带真实参数档位） */
export interface PickedModelCandidate {
  id: string
  caps?: ModelCaps
}

export interface MergePickedResult {
  /** 合并后的目录：已有条目保持原顺序与原参数，新采纳条目按候选顺序追加 */
  models: AiProviderModelEntry[]
  /** 因超出目录上限而未采纳的候选数（>0 时调用方应提示用户） */
  skipped: number
}

/** 参数档位 → 目录条目补丁：只有正数才收（与服务端净化口径一致） */
function capsPatch(caps: ModelCaps | undefined): Partial<AiProviderModelEntry> {
  const out: Partial<AiProviderModelEntry> = {}
  if (typeof caps?.maxTokens === 'number' && Number.isFinite(caps.maxTokens) && caps.maxTokens > 0) {
    out.maxTokens = caps.maxTokens
  }
  if (typeof caps?.contextWindow === 'number' && Number.isFinite(caps.contextWindow) && caps.contextWindow > 0) {
    out.contextWindow = caps.contextWindow
  }
  return out
}

/**
 * 把勾选的候选并入目录（**幂等**：目录里已有的 id 一律不覆盖——用户调过的参数优先于网关值）。
 * 超出上限的候选计入 skipped 而不静默丢弃。
 */
export function mergePickedModels(
  existing: AiProviderModelEntry[],
  candidates: PickedModelCandidate[],
  pickedIds: ReadonlySet<string>,
  max: number = AI_PROVIDER_MODELS_MAX,
): MergePickedResult {
  const byId = new Map<string, AiProviderModelEntry>()
  for (const m of existing) {
    if (!byId.has(m.id)) byId.set(m.id, m)
  }
  let skipped = 0
  for (const c of candidates) {
    if (!pickedIds.has(c.id) || byId.has(c.id)) continue
    if (byId.size >= max) {
      skipped += 1
      continue
    }
    byId.set(c.id, { id: c.id, ...capsPatch(c.caps) })
  }
  return { models: [...byId.values()], skipped }
}
