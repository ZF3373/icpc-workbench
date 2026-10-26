import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import {
  Alert,
  App as AntdApp,
  AutoComplete,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Row,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
} from 'antd'
import type { InputNumberProps } from 'antd'
import {
  ApiOutlined,
  DeleteOutlined,
  PlusOutlined,
  RobotOutlined,
} from '@ant-design/icons'
import {
  AI_PROVIDER_CUSTOM_PRESET,
  AI_PROVIDER_MODELS_MAX,
  AI_PROVIDER_PRESETS,
  AI_PROVIDERS_MAX,
  MODEL_CAPS_AS_OF,
  guessModelCaps,
  SEARCH_ENGINES,
  searchEngineMeta,
  type AiProviderModelEntry,
  type AiProviderView,
  type ModelCaps,
} from '../../../../shared/src/index.ts'
import { mergePickedModels } from '../../aiModelPicker'
import { post } from '../../api'
import { openExternal } from '../../externalLinks'

/** 设置页 AI 配置块的数据形状（SettingsData.ai 的原始定义随本卡片迁入，类型单源在这里） */
export interface SettingsAiData {
  enabled: boolean
  baseURL: string
  apiKey: string
  model: string
  timeoutMs?: number
  maxTokens?: number
  contextWindow?: number
  searchOrder?: string[]
  searchKeyStats?: Array<{ engine: string; keysMasked: string[] }>
  hasApiKey?: boolean
  apiKeyMasked?: string
  /** 环境变量 AI_API_KEY 生效中（全局运行时覆盖，不落库） */
  apiKeyFromEnv?: boolean
  /** 多提供商：当前活跃提供商 id（旧版服务端无此字段） */
  activeProviderId?: string
  /** 多提供商列表（密钥已打码，原文不下发；旧版服务端无此字段） */
  providers?: AiProviderView[]
  /** 全局兜底档位（不含提供商覆盖）：提供商参数留空时回退到这里 */
  globalMaxTokens?: number
  globalContextWindow?: number
}

/**
 * 带「单位」后缀的数字输入框。
 *
 * antd 5 起 `InputNumber` 的 `addonAfter` 已弃用（每次进设置页 6 处各刷一条控制台告警），
 * 官方推荐用 `Space.Compact` 把单位拼成一个附件块。这里统一成一个组件，避免 6 处各写一遍、
 * 又各自长歪；单位用 `disabled` 的 Button，视觉上就是 addonAfter 的等效形态（灰底、贴边）。
 */
function NumberUnitInput({
  unit,
  className,
  size,
  ...rest
}: Omit<InputNumberProps<number>, 'addonAfter'> & { unit: string }) {
  return (
    <Space.Compact block className={className}>
      <InputNumber<number> {...rest} size={size} style={{ width: '100%', ...rest.style }} />
      <Button disabled className="compact-unit" size={size}>
        {unit}
      </Button>
    </Space.Compact>
  )
}

/**
 * 「AI 配置」表单卡片。
 *
 * 为什么单独拆成组件（H2）：`Form.useForm()` 必须在 Form 自身挂载时才创建实例。
 * 本页首屏在数据回来之前是早退渲染骨架的（见上面的 `if (!data)`），若把 useForm 留在
 * 页面组件顶部，实例先于 Form 诞生，antd 就会在控制台刷
 * 「Instance created by `useForm` is not connected to any Form element」。
 * 拆出来后实例与卡片同生共死，告警根治。
 *
 * 结构（多提供商改造后）：
 * - 全局项走 antd Form（启用开关 / 对话参数），`validateFields` 校验；
 * - 提供商列表走卡片内部 React 状态（每家：预设 / API 密钥 / API 地址 / 默认模型），
 *   因为「N 个提供商 × 动态增删」塞进一份 Form 会把字段路径搞得很脆，手写状态反而直观；
 * - 对外通过 ref 暴露 `collectSavePayload`：一次「保存 AI 配置」把全局项 + 提供商列表
 *   一起收集、校验成请求体（提供商密钥留空 = 保持已存值，语义与服务端缺省合并对齐）。
 */

/** 卡片内模型目录条目：在服务端条目上带一个草稿期的稳定 UI key（不落库，见 draftOf） */
type ModelDraftEntry = AiProviderModelEntry & {
  /**
   * 仅前端使用的行标识：目录行可编辑、可删除，用下标做 key 会在删除中间条目后
   * 让后续输入框复用错位节点（受控值被旧 DOM 占着）；模型 id 编辑期间也不唯一，故另发一个。
   */
  uiKey: string
}

/** 卡片内正在编辑的一个提供商草稿（apiKey 只装「本次新输入」；'' = 未改动，保存时不下发） */
type ProviderDraft = {
  id: string
  /** 所选预设（AI_PROVIDER_PRESETS 的 key；'custom' = 自定义） */
  presetKey: string
  name: string
  baseURL: string
  model: string
  apiKey: string
  hasApiKey: boolean
  apiKeyMasked: string
  /** 该提供商单独设置的输出上限（token）；undefined = 留空，运行时回退全局默认 */
  maxTokens?: number
  /** 该提供商单独设置的上下文窗口（token）；undefined = 留空，运行时回退全局默认 */
  contextWindow?: number
  /** 自动填写已生效的模型名：同一模型不重复覆盖（用户改过的数值得以保留） */
  capsModel?: string
  /** 模型目录（对齐 dsh 的模型管理）：候选清单 + 条目级参数；条目参数优先于提供商级生效 */
  models: ModelDraftEntry[]
}

type AiFormValues = {
  enabled: boolean
  timeoutMs: number
}

export type AiSettingsCardHandle = {
  validateFields: () => Promise<AiFormValues>
  /** 收集「全局项 + 提供商列表」的保存请求体；校验失败（表单或提供商）返回 null 并已就地提示 */
  collectSavePayload: () => Promise<Record<string, unknown> | null>
  /** 保存成功后清空「本次新输入」的密钥草稿（输入的清空只发生在保存动作成功后，全局刷新不碰草稿） */
  clearSubmittedApiKeys: () => void
  resetFields: () => void
}

/** 草稿期模型条目的 UI key：只需在本卡片内唯一且跨渲染稳定，不参与保存 */
function newModelUiKey(): string {
  return `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 纯逻辑（如 mergePickedModels）返回的条目：来自草稿的已带 uiKey，新采纳的没有。
 * 统一补成草稿条目，避免用下标 key（删除中间条目后输入框值会错位）。
 */
function withModelUiKey(m: AiProviderModelEntry & { uiKey?: string }): ModelDraftEntry {
  return { ...m, uiKey: m.uiKey ?? newModelUiKey() }
}

/** 服务端已存提供商视图 → 编辑草稿（密钥原文不下发，草稿里 apiKey 恒从空开始） */
function draftOf(p: AiProviderView): ProviderDraft {
  // 预设回显：baseURL 命中内置预设就显示该预设（用户改名不影响），否则归为「自定义」
  const preset = AI_PROVIDER_PRESETS.find((x) => x.baseURL === p.baseURL)
  return {
    id: p.id,
    presetKey: preset?.key ?? 'custom',
    name: p.name,
    baseURL: p.baseURL,
    model: p.model,
    apiKey: '',
    hasApiKey: p.hasApiKey,
    apiKeyMasked: p.apiKeyMasked,
    maxTokens: p.maxTokens,
    contextWindow: p.contextWindow,
    // 服务端已带参数 → 标记「该模型已填过」，失焦不重填（保住用户已调的值）
    capsModel: p.maxTokens !== undefined || p.contextWindow !== undefined ? p.model : undefined,
    models: p.models ? p.models.map((m) => ({ ...m, uiKey: newModelUiKey() })) : [],
  }
}

/** 参数档位 → 草稿补丁（只填表里有的字段，避免用 undefined 冲掉已有值） */
function capsPatch(caps: ModelCaps): Partial<ProviderDraft> {
  return {
    ...(caps.maxTokens !== undefined ? { maxTokens: caps.maxTokens } : {}),
    ...(caps.contextWindow !== undefined ? { contextWindow: caps.contextWindow } : {}),
  }
}

/** 新提供商 id：时间戳 + 随机尾巴，够唯一且肉眼可读 */
function newProviderId(): string {
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** 「当前使用」下拉的选项值分隔符：值 = `提供商id::模型名`（id 由 newProviderId 生成，不含冒号） */
const ACTIVE_PICKER_SEP = '::'

export const AiSettingsCard = ({
  ref,
  ai,
  onSave,
}: {
  ref: Ref<AiSettingsCardHandle>
  ai: SettingsAiData
  onSave: () => void
}) => {
  const { message } = AntdApp.useApp()
  const [form] = Form.useForm<AiFormValues>()

  // ---- 提供商编辑状态（整表草稿，点「保存 AI 配置」一次性提交） ----
  const [providers, setProviders] = useState<ProviderDraft[]>([])
  const [activeId, setActiveId] = useState('')
  /** 展开的提供商面板（新增提供商时自动展开它的编辑面板） */
  const [openPanels, setOpenPanels] = useState<string[]>([])
  /** 每家提供商的「获取可用模型」结果（providerId → 模型名下拉选项） */
  const [modelOptionsBy, setModelOptionsBy] = useState<Record<string, { value: string }[]>>({})
  /** 每家提供商的模型真实参数档位（providerId → 模型名 → caps；来自网关 /models 响应） */
  const [capsBy, setCapsBy] = useState<Record<string, Record<string, ModelCaps>>>({})
  /** 「获取可用模型」勾选弹窗（对齐 dsh 的 model picker）：providerId + 候选；null = 关闭 */
  const [picker, setPicker] = useState<{ providerId: string; providerName: string; candidates: Array<{ id: string; caps?: ModelCaps }> } | null>(null)
  /** 弹窗里勾选的模型 id 集合；打开时默认勾选「目录里还没有的」 */
  const [pickedIds, setPickedIds] = useState<Set<string>>(() => new Set())
  const [pickerQuery, setPickerQuery] = useState('')
  /** 每家提供商的测试连接 / 拉模型 loading 与结果（同一提供商一个 key，互不闪烁） */
  const [testingBy, setTestingBy] = useState<Record<string, boolean>>({})
  const [testResultBy, setTestResultBy] = useState<Record<string, { ok: boolean; message: string } | undefined>>({})
  const [fetchingBy, setFetchingBy] = useState<Record<string, boolean>>({})
  const [searchOrder, setSearchOrder] = useState<string[]>([])
  const [searchKeysDraft, setSearchKeysDraft] = useState<Record<string, string>>({})
  const [searchClearDraft, setSearchClearDraft] = useState<Set<string>>(() => new Set())
  const [searchKeyStats, setSearchKeyStats] = useState<Record<string, string[]>>({})
  const searchOrderDirtyRef = useRef(false)

  const storedIds = new Set((ai.providers ?? []).map((p) => p.id))

  /** 同步护栏：首挂载全量对齐后，后续 load() 只做结构对账（见下方同步 effect） */
  const syncedOnce = useRef(false)
  /** 最近一次同步时服务端已有的提供商 id（区分「未保存的新增草稿」与「已在别处删除的提供商」） */
  const storedIdsRef = useRef<Set<string>>(new Set())
  /** 本地已删但服务端还挂着的提供商 id：未保存的删除，不让无关 load() 把它复活 */
  const locallyDeletedRef = useRef<Set<string>>(new Set())

  // 服务端值 → 表单/草稿同步：首挂载全量对齐；此后只做「结构对账」，绝不整体重建草稿。
  // ⚠ 本页任何一处无关保存/开关/绑定成功后的 load() 都会产生新的 `ai` 引用——草稿若跟着
  // 重建，用户正在编辑的半成品（密钥/地址/模型/参数，乃至尚未保存的新增提供商）会被静默
  // 清掉，且表单里未保存的启用/超时/搜索 Key 一并重置。与本页 cookieInputs/acctInputs 的
  // 历史缺陷同款：输入的清空只发生在对应动作成功后的局部 setState（saveAi 成功 → 清本次
  // 已提交的密钥草稿，见 clearSubmittedApiKeys），全局刷新一律不碰输入。
  useEffect(() => {
    const serverList = ai.providers ?? []
    const serverIds = new Set(serverList.map((p) => p.id))
    setSearchKeyStats(Object.fromEntries((ai.searchKeyStats ?? []).map((s) => [s.engine, s.keysMasked])))
    // 无关设置保存也会刷新 ai；启停与排序草稿必须等本次保存成功后才能重新对齐。
    if (!searchOrderDirtyRef.current) {
      setSearchOrder((ai.searchOrder ?? []).filter((id) => searchEngineMeta(id)))
    }
    if (!syncedOnce.current) {
      syncedOnce.current = true
      form.setFieldsValue({
        enabled: ai.enabled,
        timeoutMs: ai.timeoutMs ? ai.timeoutMs / 1000 : 120,
      })
      setProviders(serverList.map(draftOf))
      setActiveId(ai.activeProviderId || serverList[0]?.id || '')
      storedIdsRef.current = serverIds
      return
    }
    // 结构对账：服务端新增 → 补建草稿；本地删过且还没保存 → 不复活；
    // 已存提供商的既有草稿内容一律不动（那可能是用户没保存的编辑）
    for (const id of [...locallyDeletedRef.current]) {
      // 删除已随某次保存落库（服务端清单里也消失了）→ 停止跟踪
      if (!serverIds.has(id)) locallyDeletedRef.current.delete(id)
    }
    const prevStoredIds = storedIdsRef.current
    storedIdsRef.current = serverIds
    setProviders((cur) => {
      const curById = new Map(cur.map((p) => [p.id, p]))
      const next: ProviderDraft[] = serverList
        .filter((p) => !locallyDeletedRef.current.has(p.id))
        .map((p) => {
          const d = curById.get(p.id)
          if (!d) return draftOf(p)
          // hasApiKey / apiKeyMasked 是服务端权威的展示字段（草稿里不可编辑）：保存成功后
          // 跟着服务端刷新，避免「已存密钥」徽标停在旧值；其余字段保持草稿（未保存的编辑）
          return d.hasApiKey === p.hasApiKey && d.apiKeyMasked === p.apiKeyMasked
            ? d
            : { ...d, hasApiKey: p.hasApiKey, apiKeyMasked: p.apiKeyMasked }
        })
      // 服务端没有、上一次同步时也没有 = 还没保存的新增草稿，保留
      for (const d of cur) {
        if (!serverIds.has(d.id) && !prevStoredIds.has(d.id)) next.push(d)
      }
      const same =
        next.length === cur.length && next.every((p, i) => p === cur[i])
      return same ? cur : next
    })
  }, [ai, form])

  const patchProvider = (id: string, patch: Partial<ProviderDraft>) => {
    setProviders((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  /**
   * 设为当前使用（提供商 + 模型）：一步到位，不必展开面板去模型目录里点 radio 再滚到底保存。
   * 本地草稿同步跟随（activeId + 该提供商的 model），已存库的提供商同时写库、AI 请求立即生效；
   * 尚未保存的新增提供商服务端还不认识（按 id 切换会 404），只改草稿并提示先保存。
   */
  const activateModel = async (id: string, model: string) => {
    const target = providers.find((p) => p.id === id)
    if (!target) return
    setActiveId(id)
    if (model !== '') patchProvider(id, { model })
    if (!storedIds.has(id)) {
      message.info(`提供商「${target.name}」还没保存，点下方「保存 AI 配置」后即可使用`)
      return
    }
    try {
      await post('/api/settings/ai/providers/active', { id, model })
      message.success(`当前使用：${target.name} · ${model}`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /** 「当前使用」下拉候选：按提供商分组，组内是该提供商的可选模型（目录 + 目录外当前模型）。
   *  框里显示「提供商 · 模型」（display），下拉里只列模型名（label），避免整组重复前缀；
   *  searchText 带上提供商名，这样搜「大工」也能定位到它那组。 */
  const activePickerOptions = providers.map((p) => {
    const groupLabel = storedIds.has(p.id) ? p.name : `${p.name}（未保存）`
    const ids = [...new Set([p.model.trim(), ...p.models.map((m) => m.id.trim())].filter((x) => x !== ''))]
    return {
      label: groupLabel,
      options:
        ids.length === 0
          ? [{ value: `${p.id}${ACTIVE_PICKER_SEP}`, label: '还没有可选模型', display: groupLabel, disabled: true }]
          : ids.map((id) => ({
              value: `${p.id}${ACTIVE_PICKER_SEP}${id}`,
              label: id,
              display: `${p.name} · ${id}`,
              searchText: `${p.name} ${id}`,
            })),
    }
  })
  const activeDraft = providers.find((p) => p.id === activeId)
  /** 当前选中的模型不在目录里时也要能回显，所以候选含 p.model；模型为空（还没填）→ 显示占位 */
  const activePickerValue =
    activeDraft && activeDraft.model.trim() !== ''
      ? `${activeId}${ACTIVE_PICKER_SEP}${activeDraft.model.trim()}`
      : undefined

  /** 点眼睛按需取回该提供商已存的密钥原文（平时只下发打码版，见 /ai/reveal）：填回输入框后，
   *  眼睛就能正常在明文/掩码间切换。没存过就明确提示——环境变量 AI_API_KEY 从不落库，
   *  服务端也不会把它当该提供商的密钥下发，否则一次保存就把它写进了 settings。 */
  const revealProviderKey = async (p: ProviderDraft) => {
    if (!storedIds.has(p.id)) {
      message.info('该提供商还没保存，没有可显示的密钥')
      return
    }
    try {
      const r = await post<{ value: string }>('/api/settings/ai/reveal', { providerId: p.id })
      if (r.value) {
        patchProvider(p.id, { apiKey: r.value })
        return
      }
      message.info(
        ai.apiKeyFromEnv
          ? '该提供商没单独存过密钥，用的是环境变量 AI_API_KEY（不落库，无法显示）'
          : '该提供商还没有保存过密钥',
      )
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const patchSearchKeys = (engine: string, value: string) => {
    setSearchKeysDraft((draft) => ({ ...draft, [engine]: value }))
    setSearchClearDraft((cleared) => {
      const next = new Set(cleared)
      next.delete(engine)
      return next
    })
  }

  const revealSearchKeys = async (engine: string) => {
    try {
      const r = await post<{ value: string }>('/api/settings/ai/reveal', { target: 'searchProviderKeys', engine })
      if (r.value) {
        patchSearchKeys(engine, r.value)
        return
      }
      message.info('还没有可显示的搜索密钥')
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const changeSearchOrder = (update: (order: string[]) => string[]) => {
    searchOrderDirtyRef.current = true
    setSearchOrder(update)
  }

  const moveSearchEngine = (index: number, direction: -1 | 1) => {
    changeSearchOrder((order) => {
      const next = [...order]
      const target = index + direction
      if (target < 0 || target >= next.length) return order
      ;[next[index], next[target]] = [next[target]!, next[index]!]
      return next
    })
  }

  /**
   * 自动智能填写参数档位（触发：预设切换 / 行内模型 ID 失焦）。
   * 优先用网关返回的真实档位（获取过可用模型时），否则查内置参数表；两边都没有
   * （本地模型/小众网关）就不动。落点：模型在目录里 → 只填「没有参数的条目」
   * （用户调过的条目不覆盖，对齐 dsh）；目录外 → 落到提供商级（「目录外」行可见可改）。
   * capsModel 记录已填过的模型名，同一模型不重复覆盖。
   */
  const autoFillCaps = (id: string, rawModel: string) => {
    const model = rawModel.trim()
    if (!model) return
    setProviders((ps) =>
      ps.map((p) => {
        if (p.id !== id || p.capsModel === model) return p
        const caps = capsBy[id]?.[model] ?? guessModelCaps(model)
        if (!caps || (caps.maxTokens === undefined && caps.contextWindow === undefined)) return p
        const entry = p.models.find((m) => m.id === model)
        if (entry) {
          // 条目已有参数 → 视为用户调过，只登记不覆盖
          if (entry.maxTokens !== undefined || entry.contextWindow !== undefined) return { ...p, capsModel: model }
          return {
            ...p,
            capsModel: model,
            models: p.models.map((m) => (m.id === model ? { ...m, ...capsPatch(caps) } : m)),
          }
        }
        return { ...p, capsModel: model, ...capsPatch(caps) }
      }),
    )
  }

  /**
   * 按现行参数表重填档位。
   *
   * 为什么需要手动入口：失焦自动填写（autoFillCaps）只填「还没有参数」的条目，为的是保住用户
   * 调过的值；代价是**老配置里存的旧参数表建议值永远不会被更新**（比如 2026-07 前按 deepseek-chat
   * 128K 存下来的档位）。这里给一个明确的覆盖入口：认得出的模型按现表（网关真实档位优先）重填，
   * 认不出的原样保留，手动调过的值会被覆盖——所以走 Popconfirm 确认。
   */
  const refillCaps = (id: string) => {
    const target = providers.find((p) => p.id === id)
    if (!target) return
    const capsFor = (model: string): ModelCaps | null =>
      capsBy[id]?.[model.trim()] ?? guessModelCaps(model)
    const models = target.models.map((m) => {
      const caps = capsFor(m.id)
      return caps ? { ...m, ...capsPatch(caps) } : m
    })
    const activeModel = target.model.trim()
    const activeCaps = activeModel ? capsFor(activeModel) : null
    const hit = target.models.filter((m) => capsFor(m.id)).length + (activeCaps ? 1 : 0)
    setProviders((ps) =>
      ps.map((p) =>
        p.id === id
          ? {
              ...p,
              models,
              ...(activeCaps ? capsPatch(activeCaps) : {}),
              ...(activeCaps ? { capsModel: activeModel } : {}),
            }
          : p,
      ),
    )
    message.success(
      hit > 0
        ? `已按 ${MODEL_CAPS_AS_OF} 参数表重填 ${hit} 个模型的档位（要点「保存 AI 配置」才落库）`
        : '参数表认不出这些模型，档位保持不变',
    )
  }

  /** 「添加模型提供商」弹窗（对齐 dsh 的添加流程）：先选添加方式（第三方目录 / 自定义 API），
   *  明确填写后保存才创建——不静默预建任何默认提供商的草稿 */
  const [addModal, setAddModal] = useState<
    | null
    | { tab: 'preset' | 'custom'; presetKey: string; name: string; baseURL: string; apiKey: string; model: string }
  >(null)

  const openAddModal = () => {
    setAddModal({ tab: 'preset', presetKey: '', name: '', baseURL: '', apiKey: '', model: '' })
  }

  /** 选内置预设：名称 / Base URL / 默认模型一键带入（API 密钥保留用户可能已输入的值） */
  const applyAddPreset = (key: string) => {
    setAddModal((m) => {
      if (!m) return m
      const preset = AI_PROVIDER_PRESETS.find((x) => x.key === key)
      if (!preset) return { ...m, presetKey: '' }
      return { ...m, presetKey: key, name: preset.name, baseURL: preset.baseURL, model: preset.defaultModel }
    })
  }

  const saveAddProvider = () => {
    if (!addModal) return
    if (providers.length >= AI_PROVIDERS_MAX) {
      message.error(`最多配置 ${AI_PROVIDERS_MAX} 个提供商`)
      return
    }
    const isPreset = addModal.tab === 'preset'
    if (isPreset && !addModal.presetKey) {
      message.error('请先选择提供商')
      return
    }
    const baseURL = addModal.baseURL.trim()
    if (!addModal.name.trim()) {
      message.error('请填写提供商名称')
      return
    }
    if (!/^https?:\/\//.test(baseURL)) {
      message.error(`API 地址需为 http(s) 地址，当前：${baseURL || '（空）'}`)
      return
    }
    const presetKey = isPreset ? addModal.presetKey : 'custom'
    const preset = [...AI_PROVIDER_PRESETS, AI_PROVIDER_CUSTOM_PRESET].find((x) => x.key === presetKey) ?? AI_PROVIDER_CUSTOM_PRESET
    const model = addModal.model.trim() || preset.defaultModel
    // 同名不打架：自动追加序号
    let name = addModal.name.trim()
    let n = 2
    while (providers.some((p) => p.name === name)) name = `${addModal.name.trim()} ${n++}`
    const caps = model ? guessModelCaps(model) : null
    const draft: ProviderDraft = {
      id: newProviderId(),
      presetKey,
      name,
      baseURL,
      model,
      apiKey: addModal.apiKey.trim(),
      hasApiKey: false,
      apiKeyMasked: '',
      // 预设提供商：目录带默认清单（含 defaultModel），无需提供商级档位；
      // 自定义网关：目录留空，默认模型走「目录外」行（档位能认出就先垫上）
      models:
        preset.defaultModels.length > 0
          ? preset.defaultModels.map((mid) => ({ id: mid, ...(guessModelCaps(mid) ?? {}), uiKey: newModelUiKey() }))
          : [],
      ...(caps && !preset.defaultModels.includes(model) ? capsPatch(caps) : {}),
      ...(caps ? { capsModel: model } : {}),
    }
    setProviders((ps) => [...ps, draft])
    setOpenPanels((k) => [...k, draft.id])
    setAddModal(null)
  }

  const removeProvider = (id: string) => {
    // 记入「本地已删」：服务端清单里它还在，若不跟踪，任何一处无关保存触发的 load()
    // 都会在结构对账时把它复活（未保存的删除也是用户编辑，同样要保护）
    locallyDeletedRef.current.add(id)
    setProviders((ps) => {
      const next = ps.filter((p) => p.id !== id)
      // 删的是当前使用的 → 回退到剩下的第一个（空列表时 activeId 置空，保存前会被校验拦下）
      setActiveId((cur) => (cur === id ? next[0]?.id ?? '' : cur))
      return next
    })
  }

  // ---- 模型目录（对齐 dsh 的模型管理）：行编辑 / 恢复默认 / 勾选添加 ----

  const patchModelEntry = (pid: string, index: number, patch: Partial<AiProviderModelEntry>) => {
    setProviders((ps) =>
      ps.map((p) => (p.id !== pid ? p : { ...p, models: p.models.map((m, i) => (i === index ? { ...m, ...patch } : m)) })),
    )
  }

  const removeModelEntry = (pid: string, index: number) => {
    setProviders((ps) =>
      ps.map((p) => (p.id !== pid ? p : { ...p, models: p.models.filter((_, i) => i !== index) })),
    )
  }

  const addModelEntry = (pid: string) => {
    setProviders((ps) =>
      ps.map((p) => (p.id !== pid ? p : { ...p, models: [...p.models, { id: '', uiKey: newModelUiKey() }] })),
    )
  }

  /** 恢复默认模型目录：回到内置预设的默认模型清单（参数按内置参数表补齐），当前使用模型不动 */
  const resetModelCatalog = (pid: string) => {
    setProviders((ps) =>
      ps.map((p) => {
        if (p.id !== pid) return p
        const preset = [...AI_PROVIDER_PRESETS, AI_PROVIDER_CUSTOM_PRESET].find((x) => x.key === p.presetKey)
        if (!preset || preset.defaultModels.length === 0) return p
        return { ...p, models: preset.defaultModels.map((id) => ({ id, ...(guessModelCaps(id) ?? {}), uiKey: newModelUiKey() })) }
      }),
    )
  }

  /** 勾选添加：已有条目原样保留（用户调过的参数优先于网关值），新条目带网关档位加入 */
  const adoptPickedModels = () => {
    if (!picker) return
    const pid = picker.providerId
    const target = providers.find((p) => p.id === pid)
    if (!target) {
      setPicker(null)
      return
    }
    // 上限判断前移到采纳动作：否则草稿会超上限、保存时被服务端静默截断，
    // 而界面仍显示全部（结构对账不会回写目录）→ 界面与库永久不一致
    const merged = mergePickedModels(target.models, picker.candidates, pickedIds)
    // 纯逻辑只认业务字段：新采纳的条目补上草稿期 UI key（已有条目来自草稿，自带 key）
    const models = merged.models.map(withModelUiKey)
    const skipped = merged.skipped
    setProviders((ps) => ps.map((p) => (p.id === pid ? { ...p, models } : p)))
    if (skipped > 0) {
      message.warning(
        `模型目录上限 ${AI_PROVIDER_MODELS_MAX} 个：本次加入 ${models.length - target.models.length} 个，` +
        `另有 ${skipped} 个未加入（先移除部分条目再获取即可）`,
      )
    }
    setPicker(null)
  }

  /** 选预设：名称 / Base URL / 默认模型 / 参数档位一键带入；「自定义」保留当前值由用户手填 */
  const applyPreset = (id: string, presetKey: string) => {
    const preset = [...AI_PROVIDER_PRESETS, AI_PROVIDER_CUSTOM_PRESET].find((x) => x.key === presetKey)
    if (!preset) return
    setProviders((ps) =>
      ps.map((p) => {
        if (p.id !== id) return p
        if (presetKey === 'custom') {
          // 从预设切到自定义：名字还挂在预设名上时换成「自定义」，用户改过的名字不动
          const wasPresetName = AI_PROVIDER_PRESETS.some((x) => x.name === p.name)
          return { ...p, presetKey, ...(wasPresetName ? { name: '自定义' } : {}) }
        }
        const caps = guessModelCaps(preset.defaultModel)
        return {
          ...p,
          presetKey,
          name: preset.name,
          baseURL: preset.baseURL,
          model: preset.defaultModel,
          // 换预设 = 换模型 → 参数档位跟随重填（内置参数表口径）
          ...(caps ? { capsModel: preset.defaultModel, ...capsPatch(caps) } : { capsModel: undefined }),
        }
      }),
    )
  }

  /** 测试单个提供商：已存的传 providerId（服务端用已存密钥兜底），未存的全靠表单值 */
  const testProvider = async (p: ProviderDraft) => {
    if (!/^https?:\/\//.test(p.baseURL.trim())) {
      setTestResultBy((m) => ({ ...m, [p.id]: { ok: false, message: 'Base URL 需为 http(s) 地址' } }))
      return
    }
    setTestingBy((m) => ({ ...m, [p.id]: true }))
    setTestResultBy((m) => ({ ...m, [p.id]: undefined }))
    try {
      const r = await post<{ ok: boolean; message: string; models?: string[] }>('/api/settings/ai/test', {
        providerId: storedIds.has(p.id) ? p.id : undefined,
        baseURL: p.baseURL.trim(),
        apiKey: p.apiKey.trim() || undefined,
        model: p.model.trim(),
      })
      setTestResultBy((m) => ({ ...m, [p.id]: r }))
      if (r.models?.length) setModelOptionsBy((mm) => ({ ...mm, [p.id]: r.models!.map((v) => ({ value: v })) }))
    } catch (e) {
      setTestResultBy((m) => ({ ...m, [p.id]: { ok: false, message: (e as Error).message } }))
    } finally {
      setTestingBy((m) => ({ ...m, [p.id]: false }))
    }
  }

  const fetchProviderModels = async (p: ProviderDraft) => {
    if (!/^https?:\/\//.test(p.baseURL.trim())) {
      message.error(`提供商「${p.name}」的 Base URL 需为 http(s) 地址`)
      return
    }
    setFetchingBy((m) => ({ ...m, [p.id]: true }))
    try {
      const r = await post<{ models: string[]; caps?: Record<string, ModelCaps> }>('/api/settings/ai/models', {
        providerId: storedIds.has(p.id) ? p.id : undefined,
        baseURL: p.baseURL.trim(),
        apiKey: p.apiKey.trim() || undefined,
      })
      if (r.models.length === 0) {
        message.warning('服务未返回任何模型')
        return
      }
      setModelOptionsBy((mm) => ({ ...mm, [p.id]: r.models.map((v) => ({ value: v })) }))
      if (r.caps && Object.keys(r.caps).length > 0) {
        setCapsBy((m) => ({ ...m, [p.id]: { ...(m[p.id] ?? {}), ...r.caps! } }))
      }
      // 直接进入勾选弹窗（对齐 dsh）：候选 = 网关返回的模型 + 其真实档位；
      // 默认勾选目录里还没有的——已配置的条目保持不勾，采纳选择不会改写已调过的参数
      const candidates = r.models.map((id) => ({ id, caps: r.caps?.[id] }))
      setPicker({ providerId: p.id, providerName: p.name, candidates })
      setPickerQuery('')
      const known = new Set(p.models.map((m) => m.id))
      setPickedIds(new Set(candidates.filter((c) => !known.has(c.id)).map((c) => c.id)))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setFetchingBy((m) => ({ ...m, [p.id]: false }))
    }
  }

  // 反向 ref：把表单实例交给父组件（React 19 里 ref 可以直接作为普通 prop 传递）
  useImperativeHandle(ref, () => ({
    validateFields: () => form.validateFields(),
    collectSavePayload: async () => {
      const globals = await form.validateFields().catch(() => null)
      if (!globals) return null
      if (providers.length === 0) {
        message.error('至少保留一个提供商（不想用 AI 可直接关掉「启用 AI 生成」开关）')
        return null
      }
      for (let i = 0; i < providers.length; i++) {
        const p = providers[i]!
        if (!p.name.trim()) {
          message.error(`第 ${i + 1} 个提供商缺少名称`)
          return null
        }
        if (!/^https?:\/\//.test(p.baseURL.trim())) {
          message.error(`提供商「${p.name}」的 Base URL 需为 http(s) 地址`)
          return null
        }
      }
      const { timeoutMs, ...rest } = globals
      return {
        ...rest,
        searchProviders: {
          order: searchOrder,
          keys: {
            ...Object.fromEntries(Object.entries(searchKeysDraft).filter(([, value]) => value.trim() !== '')),
            ...Object.fromEntries([...searchClearDraft].map((engine) => [engine, ''])),
          },
        },
        // apiKey 只在本次输入了新值时下发：缺省 = 服务端保持该提供商已存密钥；
        // maxTokens/contextWindow 显式下发（null = 清除该提供商的单独设置，回退全局默认）；
        // 模型目录总是全量下发（空数组 = 明确清空目录），id 为空的半填行丢弃
        providers: providers.map((p) => ({
          id: p.id,
          name: p.name.trim(),
          baseURL: p.baseURL.trim(),
          model: p.model.trim(),
          ...(p.apiKey.trim() ? { apiKey: p.apiKey.trim() } : {}),
          maxTokens: p.maxTokens ?? null,
          contextWindow: p.contextWindow ?? null,
          models: p.models
            .filter((m) => m.id.trim() !== '')
            .map((m) => ({
              id: m.id.trim(),
              ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
              ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
            })),
        })),
        activeProviderId: activeId,
        // 表单以秒为单位，后端存储毫秒
        timeoutMs: Math.round(timeoutMs * 1000),
      }
    },
    resetFields: () => form.resetFields(),
    clearSubmittedApiKeys: () => {
      // 只清「本次新输入」的密钥（非空草稿）：它们已随保存提交，留在输入框里既无意义
      // 又让用户分不清「已存」还是「未存」。全局 load() 不再整体重建草稿，清空必须就地做
      setProviders((ps) => ps.map((p) => (p.apiKey.trim() !== '' ? { ...p, apiKey: '' } : p)))
      setSearchKeysDraft({})
      setSearchClearDraft(new Set())
      searchOrderDirtyRef.current = false
    },
  }), [form, providers, activeId, message, searchOrder, searchKeysDraft, searchClearDraft])

  // 勾选弹窗的可见候选：按搜索词过滤（id 子串、忽略大小写）
  const pickerQueryNorm = pickerQuery.trim().toLowerCase()
  const pickerCandidates = (picker?.candidates ?? []).filter(
    (c) => pickerQueryNorm === '' || c.id.toLowerCase().includes(pickerQueryNorm),
  )
  const allVisiblePicked =
    pickerCandidates.length > 0 && pickerCandidates.every((c) => pickedIds.has(c.id))

  return (
    <Card title={<span className="settings-section-title"><RobotOutlined />AI 配置</span>} size="small">
      <Form form={form} layout="vertical">
        <Form.Item name="enabled" label="启用 AI 生成" valuePropName="checked">
          <Switch />
        </Form.Item>

        {/* ---- 模型提供商（多提供商管理） ---- */}
        <div style={{ borderTop: '1px solid var(--line)', margin: '12px 0', paddingTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: 'var(--text)' }}>模型提供商</div>
          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 12px' }}>
            可配置多个 OpenAI 兼容提供商，各自维护模型目录。「当前使用」选完
            <b>立即生效</b>（不用保存），其余改动点下方「保存 AI 配置」生效。
          </p>
          <Row gutter={8} align="middle" style={{ marginBottom: 8 }}>
            {/* minWidth:0 —— 否则这一列撑到「当前使用 + 完整选项文字」的 min-content 宽，
                卡片窄时把「添加提供商」按钮整个挤到下一行 */}
            <Col flex="auto" style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, flexShrink: 0 }}>当前使用</span>
                <Select
                  style={{ width: '100%', maxWidth: 400 }}
                  showSearch
                  optionLabelProp="display"
                  optionFilterProp="searchText"
                  value={activePickerValue}
                  onChange={(v: string) => {
                    const sep = v.indexOf(ACTIVE_PICKER_SEP)
                    void activateModel(v.slice(0, sep), v.slice(sep + ACTIVE_PICKER_SEP.length))
                  }}
                  placeholder={providers.length ? '选择提供商与模型' : '先添加一个提供商'}
                  options={activePickerOptions}
                />
              </div>
            </Col>
            <Col>
              <Button icon={<PlusOutlined />} onClick={openAddModal}>
                添加提供商
              </Button>
            </Col>
          </Row>
          {providers.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '12px 0' }}>
              还没有提供商，点「添加提供商」从内置目录选择 DeepSeek、OpenAI、Kimi 等，填入其 API 密钥即可使用。
            </div>
          ) : (
            <Collapse
              size="small"
              className="provider-collapse"
              activeKey={openPanels}
              onChange={(keys) => setOpenPanels(Array.isArray(keys) ? keys : [keys])}
              items={providers.map((p) => ({
                key: p.id,
                label: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={{ fontWeight: 600 }}>{p.name}</span>
                    {p.id === activeId && <Tag color="success">当前使用</Tag>}
                    {!storedIds.has(p.id) && <Tag color="warning">未保存</Tag>}
                    {!p.hasApiKey && !p.apiKey && (ai.apiKeyFromEnv
                      ? <Tag color="processing">密钥来自环境变量</Tag>
                      : <Tag color="error">未配密钥</Tag>)}
                    <span
                      style={{
                        fontSize: 12, color: 'var(--text-3)', overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                    >
                      {p.baseURL}
                    </span>
                  </span>
                ),
                extra: (
                  <span onClick={(e) => e.stopPropagation()}>
                    <Popconfirm
                      title={`删除提供商「${p.name}」？`}
                      description="仅删除本工作台里的该提供商配置，不影响其历史对话。"
                      okText="删除"
                      cancelText="取消"
                      onConfirm={() => removeProvider(p.id)}
                    >
                      <Tooltip title="删除提供商">
                        <Button size="small" danger icon={<DeleteOutlined />} aria-label="删除提供商" />
                      </Tooltip>
                    </Popconfirm>
                  </span>
                ),
                children: (
                  <>
                    <Form.Item label="提供商" style={{ marginBottom: 12 }}>
                      <Select
                        value={p.presetKey}
                        onChange={(k) => applyPreset(p.id, k)}
                        options={[
                          ...AI_PROVIDER_PRESETS.map((x) => ({ value: x.key, label: x.name })),
                          { value: AI_PROVIDER_CUSTOM_PRESET.key, label: AI_PROVIDER_CUSTOM_PRESET.name },
                        ]}
                      />
                    </Form.Item>
                    {p.presetKey !== 'custom' && AI_PROVIDER_PRESETS.find((x) => x.key === p.presetKey)?.consoleUrl && (
                      <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 12px' }}>
                        还没有 API Key？前往{' '}
                        <a onClick={() => openExternal(AI_PROVIDER_PRESETS.find((x) => x.key === p.presetKey)!.consoleUrl)}>
                          {AI_PROVIDER_PRESETS.find((x) => x.key === p.presetKey)!.name} 控制台 ↗
                        </a>{' '}
                        注册获取。
                      </p>
                    )}
                    <Form.Item label="API 密钥" style={{ marginBottom: 12 }}>
                      <Input.Password
                        value={p.apiKey}
                        onChange={(e) => patchProvider(p.id, { apiKey: e.target.value })}
                        visibilityToggle={{
                          onVisibleChange: (v) => {
                            if (v && p.apiKey.trim() === '') void revealProviderKey(p)
                          },
                        }}
                        placeholder={
                          p.hasApiKey
                            ? `已配置 ${p.apiKeyMasked || '••••••••'} · 留空保持不变，粘贴新值可覆盖`
                            : ai.apiKeyFromEnv
                              ? '留空则用环境变量 AI_API_KEY（不落库），粘贴新值可覆盖'
                              : '粘贴该提供商的 API Key（可留空，如用环境变量 AI_API_KEY）'
                        }
                      />
                    </Form.Item>
                    <Collapse
                      ghost
                      size="small"
                      items={[{
                        key: 'custom',
                        label: '自定义设置',
                        children: (
                          <>
                            <Form.Item label="API 地址（Base URL）" style={{ marginBottom: 12 }}>
                              <Input
                                value={p.baseURL}
                                onChange={(e) => patchProvider(p.id, { baseURL: e.target.value })}
                                placeholder="https://api.deepseek.com/v1"
                              />
                            </Form.Item>
                            <Form.Item label="提供商名称（用于列表展示）" style={{ marginBottom: 0 }}>
                              <Input
                                value={p.name}
                                onChange={(e) => patchProvider(p.id, { name: e.target.value })}
                                placeholder="如：DeepSeek / 公司网关 / 本地 Ollama"
                              />
                            </Form.Item>
                          </>
                        ),
                      }]}
                    />
                    {/* ---- 模型目录（对齐 dsh 的模型管理）----
                        一个区块承载「该提供商使用的模型 + 各模型档位」：radio 点一下立即切过去用，
                        行内可改模型 ID 与参数；当前模型不在目录时以「使用模型」行呈现
                        （其参数即提供商级默认档位，供目录内未填参数的模型兜底）。 */}
                    <div style={{ margin: '12px 0 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                        <span
                          style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}
                          title={`目录条目的参数优先生效；未填参数的模型用「目录外」行里的提供商默认档位。内置参数表口径：${MODEL_CAPS_AS_OF} 各家官方文档`}
                        >
                          模型目录
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--text-3)', flex: 1, minWidth: 80 }}>
                          {p.models.length > 0 ? `${p.models.length} 个模型` : '未建目录'}
                        </span>
                        <Popconfirm
                          title="按内置参数表重填档位？"
                          description={
                            <span style={{ display: 'block', maxWidth: 320 }}>
                              把认得出的模型（{MODEL_CAPS_AS_OF} 官方文档口径，网关返回过真实档位时优先采用）
                              的「上下文 / 最大输出」覆盖为当前建议值；手动调过的值也会被覆盖。
                            </span>
                          }
                          okText="重填"
                          onConfirm={() => refillCaps(p.id)}
                        >
                          <Button size="small" title="老配置里存的可能是旧参数表的建议值，点这里按现行参数表重填">
                            重填档位
                          </Button>
                        </Popconfirm>
                        {p.presetKey !== 'custom' && (
                          <Button size="small" onClick={() => resetModelCatalog(p.id)}>
                            恢复默认模型
                          </Button>
                        )}
                        <Button size="small" loading={!!fetchingBy[p.id]} onClick={() => void fetchProviderModels(p)}>
                          获取可用模型
                        </Button>
                      </div>
                      {p.model.trim() !== '' && !p.models.some((m) => m.id === p.model.trim()) && (
                        <div
                          style={{ border: '1px solid var(--line-soft)', borderRadius: 8, padding: '6px 8px', marginBottom: 6, background: 'var(--bg-elevated)' }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Tag
                              color="processing"
                              style={{ marginRight: 0 }}
                              title="该提供商使用的模型（不在模型目录里，可自由输入）；这里的改动要点「保存 AI 配置」才生效"
                            >
                              使用模型
                            </Tag>
                            <AutoComplete
                              value={p.model}
                              onChange={(v) => patchProvider(p.id, { model: v })}
                              onBlur={(e) => autoFillCaps(p.id, (e.target as HTMLInputElement).value)}
                              options={
                                [...new Map([...p.models.filter((m) => m.id).map((m) => [m.id, { value: m.id }] as const), ...(modelOptionsBy[p.id] ?? []).map((o) => [o.value, o] as const)]).values()]
                              }
                              placeholder="模型 ID（目录外自由输入）"
                              style={{ flex: 1 }}
                            />
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, paddingLeft: 4, flexWrap: 'wrap' }}>
                            <div style={{ width: 170 }}>
                              <NumberUnitInput
                                size="small"
                                min={2}
                                max={2048}
                                step={16}
                                unit="K"
                                value={p.contextWindow ? Math.round(p.contextWindow / 1024) : null}
                                onChange={(v) => patchProvider(p.id, { contextWindow: v ? Math.round(v * 1024) : undefined })}
                                placeholder={ai.globalContextWindow ? `上下文 全局${Math.round(ai.globalContextWindow / 1024)}K` : '上下文窗口'}
                              />
                            </div>
                            <div style={{ width: 170 }}>
                              <NumberUnitInput
                                size="small"
                                min={1}
                                max={384}
                                step={1}
                                unit="K"
                                value={p.maxTokens ? Math.round(p.maxTokens / 1024) : null}
                                onChange={(v) => patchProvider(p.id, { maxTokens: v ? Math.round(v * 1024) : undefined })}
                                placeholder={ai.globalMaxTokens ? `输出 全局${Math.round(ai.globalMaxTokens / 1024)}K` : '最大输出'}
                              />
                            </div>
                          </div>
                        </div>
                      )}
                      {p.models.map((m, i) => (
                        <div
                          key={m.uiKey}
                          style={{ border: '1px solid var(--line-soft)', borderRadius: 8, padding: '6px 8px', marginBottom: 6, background: 'var(--bg-elevated)' }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Radio
                              checked={p.model === m.id && m.id !== ''}
                              onChange={() => void activateModel(p.id, m.id)}
                              disabled={m.id === ''}
                              title="立即改用该提供商的这个模型（选完即生效，无需保存）"
                            />
                            <Input
                              size="small"
                              value={m.id}
                              onChange={(e) => patchModelEntry(p.id, i, { id: e.target.value })}
                              onBlur={(e) => autoFillCaps(p.id, e.target.value)}
                              placeholder="模型 ID"
                              style={{ flex: 1 }}
                            />
                            <Popconfirm
                              title={`从目录移除「${m.id || '未命名模型'}」？`}
                              description="仅移出目录，不影响已保存的其他配置。"
                              okText="移除"
                              cancelText="取消"
                              onConfirm={() => removeModelEntry(p.id, i)}
                            >
                              <Tooltip title="移除模型">
                                <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="移除模型" />
                              </Tooltip>
                            </Popconfirm>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, paddingLeft: 30, flexWrap: 'wrap' }}>
                            <div style={{ width: 170 }}>
                              <NumberUnitInput
                                size="small"
                                min={2}
                                max={2048}
                                step={16}
                                unit="K"
                                value={m.contextWindow ? Math.round(m.contextWindow / 1024) : null}
                                onChange={(v) => patchModelEntry(p.id, i, { contextWindow: v ? Math.round(v * 1024) : undefined })}
                                placeholder={p.contextWindow ? `上下文 默认${Math.round(p.contextWindow / 1024)}K` : '上下文窗口'}
                              />
                            </div>
                            <div style={{ width: 170 }}>
                              <NumberUnitInput
                                size="small"
                                min={1}
                                max={384}
                                step={1}
                                unit="K"
                                value={m.maxTokens ? Math.round(m.maxTokens / 1024) : null}
                                onChange={(v) => patchModelEntry(p.id, i, { maxTokens: v ? Math.round(v * 1024) : undefined })}
                                placeholder={p.maxTokens ? `输出 默认${Math.round(p.maxTokens / 1024)}K` : '最大输出'}
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                      <Button
                        size="small"
                        icon={<PlusOutlined />}
                        disabled={p.models.length >= AI_PROVIDER_MODELS_MAX}
                        onClick={() => addModelEntry(p.id)}
                      >
                        添加模型
                      </Button>
                    </div>

                    <Space wrap style={{ marginBottom: 8 }}>
                      <Button icon={<ApiOutlined />} loading={!!testingBy[p.id]} onClick={() => void testProvider(p)}>
                        测试连接
                      </Button>
                    </Space>
                    {testResultBy[p.id] && (
                      <Alert
                        type={testResultBy[p.id]!.ok ? 'success' : 'error'}
                        showIcon
                        closable
                        message={testResultBy[p.id]!.message}
                        onClose={() => setTestResultBy((m) => ({ ...m, [p.id]: undefined }))}
                      />
                    )}
                  </>
                ),
              }))}
            />
          )}
        </div>

        <Form.Item name="timeoutMs" label="对话超时（秒）" tooltip="AI 助手对话的最长等待时间。响应慢的模型可适当调大，默认 120 秒">
          <NumberUnitInput min={30} max={600} step={30} unit="秒" />
        </Form.Item>
        <div style={{ borderTop: '1px solid var(--line)', margin: '12px 0', paddingTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>联网搜索（可选）</div>
          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 8px' }}>
            启用多个引擎后按顺序尝试，失败或额度用尽自动切换；同一引擎可每行填写一个 Key，按序轮换。
            带「抓取」标记的引擎也可读取网页正文。需模型支持工具调用，改动点「保存 AI 配置」生效。
          </p>
          <div style={{ fontSize: 13, fontWeight: 600, margin: '12px 0 8px' }}>已启用引擎（顺序即 fallback 顺序）</div>
          {searchOrder.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>尚未启用引擎，可从下方选择。</div>
          )}
          {searchOrder.map((engine, index) => {
            const meta = searchEngineMeta(engine)
            if (!meta) return null
            const masked = searchKeyStats[engine] ?? []
            const clearing = searchClearDraft.has(engine)
            const noun = meta.keyIsUrl ? '实例地址' : 'Key'
            const placeholder = clearing
              ? `保存后清除已存${noun}；输入新值可取消清除`
              : masked.length > 0
                ? `已存 ${masked.length} 个${noun}（${masked.join('、')}）· 留空保持不变；每行一个${noun}可填多个轮换`
                : meta.keyIsUrl
                  ? '填写 SearXNG 实例地址，如 https://search.example.com；每行一个'
                  : meta.allowsKeyless
                    ? '可留空匿名使用；每行一个 Key，最多 20 个'
                    : '每行一个 Key，最多 20 个；未填 Key 的引擎不会参与搜索'
            return (
              <div key={engine} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10, marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                  <Space.Compact>
                    <Button size="small" aria-label={`上移 ${meta.label}`} disabled={index === 0} onClick={() => moveSearchEngine(index, -1)}>↑</Button>
                    <Button size="small" aria-label={`下移 ${meta.label}`} disabled={index === searchOrder.length - 1} onClick={() => moveSearchEngine(index, 1)}>↓</Button>
                  </Space.Compact>
                  <Tooltip title={meta.quota}><span style={{ fontWeight: 600 }}>{meta.label}</span></Tooltip>
                  <span><Tag>搜索</Tag>{meta.supportsFetch && <Tag color="blue">抓取</Tag>}</span>
                  {clearing && <Tag color="warning">待清除{noun}</Tag>}
                  <Button
                    size="small" type="text" danger style={{ marginLeft: 'auto' }}
                    aria-label={`移除 ${meta.label}`}
                    title="停用引擎，保留已存 Key，再次启用免重填"
                    onClick={() => changeSearchOrder((order) => order.filter((id) => id !== engine))}
                  >移除</Button>
                </div>
                <Input.TextArea
                  aria-label={`${meta.label} ${noun}`}
                  autoSize={{ minRows: 1, maxRows: 3 }}
                  autoComplete="off"
                  spellCheck={false}
                  value={searchKeysDraft[engine] ?? ''}
                  onChange={(e) => patchSearchKeys(engine, e.target.value)}
                  placeholder={placeholder}
                />
                <Space wrap size="small" style={{ marginTop: 4 }}>
                  <Button size="small" type="link" disabled={masked.length === 0} onClick={() => void revealSearchKeys(engine)}>
                    回显已存{noun}
                  </Button>
                  <Popconfirm
                    title={`清除 ${meta.label} 已存的全部${noun}？`}
                    description="点「保存 AI 配置」后生效。"
                    okText="清除" cancelText="取消"
                    onConfirm={() => {
                      setSearchKeysDraft((draft) => ({ ...draft, [engine]: '' }))
                      setSearchClearDraft((cleared) => new Set([...cleared, engine]))
                    }}
                  >
                    <Button size="small" type="link" danger disabled={clearing || masked.length === 0}>清除已存{noun}</Button>
                  </Popconfirm>
                  {clearing && <Button size="small" type="link" onClick={() => patchSearchKeys(engine, '')}>取消清除</Button>}
                </Space>
              </div>
            )
          })}
          <div style={{ fontSize: 13, fontWeight: 600, margin: '12px 0 4px' }}>其他可用引擎</div>
          {SEARCH_ENGINES.filter((meta) => !searchOrder.includes(meta.id)).map((meta) => (
            <div key={meta.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <span style={{ fontWeight: 500 }}>{meta.label}</span>
              <span><Tag>搜索</Tag>{meta.supportsFetch && <Tag color="blue">抓取</Tag>}</span>
              <span style={{ fontSize: 12, color: 'var(--text-3)', flex: 1, minWidth: 160 }}>{meta.quota}</span>
              {meta.registerUrl && <Button size="small" type="link" onClick={() => openExternal(meta.registerUrl!)}>{meta.keyIsUrl ? '部署文档' : '注册 / 获取 Key'} ↗</Button>}
              <Button size="small" aria-label={`启用 ${meta.label}`} onClick={() => changeSearchOrder((order) => order.includes(meta.id) ? order : [...order, meta.id])}>启用</Button>
            </div>
          ))}
        </div>
        <Space wrap>
          <Button type="primary" onClick={onSave}>
            保存 AI 配置
          </Button>
        </Space>
      </Form>

      {/* 「选择要添加的模型」勾选弹窗（对齐 dsh 的 model picker）：
          搜索过滤 + 复选 + 全选/取消全选；默认只勾目录里还没有的模型，
          采纳选择不会改写已调过的条目参数。 */}
      <Modal
        title={`选择要添加的模型 · ${picker?.providerName ?? ''}`}
        open={picker !== null}
        onCancel={() => setPicker(null)}
        width={480}
        okText={pickedIds.size > 0 ? `添加所选（${pickedIds.size}）` : '添加所选'}
        okButtonProps={{ disabled: pickedIds.size === 0 }}
        onOk={adoptPickedModels}
        cancelText="取消"
      >
        <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 8px' }}>
          以下是该提供商的可用模型，勾选要加入模型目录的模型；已带参数档位的会一并填入。
        </p>
        <Space.Compact block style={{ marginBottom: 8 }}>
          <Input
            allowClear
            value={pickerQuery}
            onChange={(e) => setPickerQuery(e.target.value)}
            placeholder="搜索模型"
          />
          <Button
            onClick={() => {
              setPickedIds((cur) => {
                if (allVisiblePicked) {
                  const next = new Set(cur)
                  for (const c of pickerCandidates) next.delete(c.id)
                  return next
                }
                const next = new Set(cur)
                for (const c of pickerCandidates) next.add(c.id)
                return next
              })
            }}
          >
            {allVisiblePicked ? '取消全选' : '全选'}
          </Button>
        </Space.Compact>
        <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8, padding: 4 }}>
          {pickerCandidates.length === 0 ? (
            <div style={{ padding: 8, fontSize: 13, color: 'var(--text-3)' }}>没有匹配的模型</div>
          ) : (
            pickerCandidates.map((c) => (
              <label
                key={c.id}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 6, cursor: 'pointer' }}
              >
                <Checkbox
                  checked={pickedIds.has(c.id)}
                  onChange={() =>
                    setPickedIds((cur) => {
                      const next = new Set(cur)
                      if (!next.delete(c.id)) next.add(c.id)
                      return next
                    })
                  }
                />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.id}</span>
                {(c.caps?.contextWindow !== undefined || c.caps?.maxTokens !== undefined) && (
                  <span style={{ fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}>
                    {c.caps?.contextWindow !== undefined && `上下文 ${Math.round(c.caps.contextWindow / 1024)}K`}
                    {c.caps?.contextWindow !== undefined && c.caps?.maxTokens !== undefined && ' · '}
                    {c.caps?.maxTokens !== undefined && `输出 ${Math.round(c.caps.maxTokens / 1024)}K`}
                  </span>
                )}
              </label>
            ))
          )}
        </div>
      </Modal>

      {/* 「添加模型提供商」弹窗（对齐 dsh 的添加流程）：两种添加方式二选一，
          填写后「保存」才真正创建提供商草稿；取消不留痕。 */}
      <Modal
        title="添加模型提供商"
        open={addModal !== null}
        onCancel={() => setAddModal(null)}
        width={480}
        okText="保存"
        cancelText="取消"
        onOk={saveAddProvider}
      >
        {addModal && (
          <>
            <Segmented
              block
              value={addModal.tab}
              onChange={(v) => setAddModal({ ...addModal, tab: v as 'preset' | 'custom' })}
              options={[
                { label: '第三方模型提供商', value: 'preset' },
                { label: '自定义模型 API', value: 'custom' },
              ]}
              style={{ marginBottom: 12 }}
            />
            {addModal.tab === 'preset' ? (
              <>
                <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 12px' }}>
                  从内置目录中选择 DeepSeek、OpenAI、Kimi 等提供商，填入其 API 密钥即可使用。
                </p>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13, marginBottom: 6 }}>提供商</div>
                  <Select
                    style={{ width: '100%' }}
                    value={addModal.presetKey || undefined}
                    placeholder="请选择提供商"
                    onChange={(k) => applyAddPreset(String(k))}
                    options={AI_PROVIDER_PRESETS.map((x) => ({ value: x.key, label: x.name }))}
                  />
                </div>
                {addModal.presetKey && AI_PROVIDER_PRESETS.find((x) => x.key === addModal.presetKey)?.consoleUrl && (
                  <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 12px' }}>
                    还没有 API Key？前往{' '}
                    <a onClick={() => openExternal(AI_PROVIDER_PRESETS.find((x) => x.key === addModal.presetKey)!.consoleUrl)}>
                      {AI_PROVIDER_PRESETS.find((x) => x.key === addModal.presetKey)!.name} 控制台 ↗
                    </a>{' '}
                    注册获取。
                  </p>
                )}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13, marginBottom: 6 }}>API 密钥</div>
                  <Input.Password
                    value={addModal.apiKey}
                    onChange={(e) => setAddModal({ ...addModal, apiKey: e.target.value })}
                    placeholder="输入 API 密钥（可留空，如用环境变量 AI_API_KEY）"
                    /* 弹窗里必然还没有已存密钥：空着时不挂眼睛，否则就是个点开没反应的死图标 */
                    visibilityToggle={addModal.apiKey.trim() !== ''}
                  />
                </div>
                <Collapse
                  ghost
                  size="small"
                  items={[{
                    key: 'adv',
                    label: '自定义设置',
                    children: (
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 13, marginBottom: 6 }}>API 地址（Base URL）</div>
                        <Input
                          value={addModal.baseURL}
                          onChange={(e) => setAddModal({ ...addModal, baseURL: e.target.value })}
                          placeholder="提供商默认"
                        />
                      </div>
                    ),
                  }]}
                />
              </>
            ) : (
              <>
                <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 12px' }}>
                  接入任意 OpenAI 兼容网关（one-api / new-api / 本地 Ollama 等）。
                </p>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13, marginBottom: 6 }}>提供商名称</div>
                  <Input
                    value={addModal.name}
                    onChange={(e) => setAddModal({ ...addModal, name: e.target.value })}
                    placeholder="如：公司网关 / 本地 Ollama"
                  />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13, marginBottom: 6 }}>API 密钥</div>
                  <Input.Password
                    value={addModal.apiKey}
                    onChange={(e) => setAddModal({ ...addModal, apiKey: e.target.value })}
                    placeholder="输入 API 密钥（可留空）"
                    visibilityToggle={addModal.apiKey.trim() !== ''}
                  />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13, marginBottom: 6 }}>API 地址（Base URL）</div>
                  <Input
                    value={addModal.baseURL}
                    onChange={(e) => setAddModal({ ...addModal, baseURL: e.target.value })}
                    placeholder="http://localhost:11434/v1"
                  />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13, marginBottom: 6 }}>默认模型（可留空）</div>
                  <Input
                    value={addModal.model}
                    onChange={(e) => setAddModal({ ...addModal, model: e.target.value })}
                    placeholder="如：qwen2.5:7b"
                  />
                </div>
              </>
            )}
          </>
        )}
      </Modal>
    </Card>
  )
}
