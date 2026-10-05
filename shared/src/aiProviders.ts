/**
 * AI 模型提供商（多提供商）的共享类型与内置预设（跨端共享真相）。
 *
 * 为什么放在 shared：提供商的增删改表单渲染在 client（Settings 页），而
 * 「提供商列表持久化 + 活跃提供商解析 + 密钥留空合并」在 server（config.ts 与
 * settings 路由）——两端必须用同一份类型与预设表，客户端预设改名/换地址而
 * 服务端不认，会静默写出错误配置。
 *
 * 所有预设都是 OpenAI 兼容接口（本应用唯一接入口径）；「自定义」= 用户手填
 * Base URL 的任意兼容网关（one-api / new-api / 本地 Ollama 等）。
 */

/**
 * 模型目录条目（对齐 deepseek-harness 的模型管理）：一个提供商可登记多个可用模型，
 * 每条可带参数档位；目录来自「获取可用模型」勾选添加或手工添加。
 * 参数缺省 = 回退提供商级档位（AiProviderConfig.maxTokens/contextWindow）。
 */
export interface AiProviderModelEntry {
  /** 模型 ID（同提供商目录内唯一） */
  id: string;
  /** 上下文窗口（token，含输入+输出）；缺省 = 提供商级 */
  contextWindow?: number;
  /** 单次回复最大 token；缺省 = 提供商级 */
  maxTokens?: number;
}

/** 单个已保存的提供商（服务端存储与解析口径；apiKey 原文只在服务端流转，绝不回传前端） */
export interface AiProviderConfig {
  /** 稳定标识（客户端生成，如 p_xxx）；活跃提供商按 id 记忆，改名不影响指向 */
  id: string;
  /** 展示名（如「DeepSeek」「公司网关」），允许重复 */
  name: string;
  /** OpenAI 兼容 Base URL（如 https://api.deepseek.com/v1） */
  baseURL: string;
  /** API Key 原文（DB settings 表内与旧版 ai.apiKey 同等明文级别，接口层一律打码回传） */
  apiKey: string;
  /** 该提供商下使用的默认模型（激活该提供商时 AI 请求所用模型） */
  model: string;
  /** 该提供商的 AI 单次回复最大 token 数；缺省 = 回退全局默认（旧数据/未知模型不强制填） */
  maxTokens?: number;
  /** 该提供商的模型上下文窗口（token 数）；缺省 = 回退全局默认 */
  contextWindow?: number;
  /** 模型目录；缺省/空 = 未建目录（模型仍可自由输入），仅作为候选清单与条目级参数来源 */
  models?: AiProviderModelEntry[];
}

/** 设置页回传给前端的提供商视图（apiKey 已剥离，只带打码版供回显） */
export interface AiProviderView {
  id: string;
  name: string;
  baseURL: string;
  model: string;
  /** 是否已配置密钥（前端据此显示「已配置 xxx · 留空保持不变」占位） */
  hasApiKey: boolean;
  /** 打码后的密钥回显（如 sk-1••••••cdef；未配置为空串） */
  apiKeyMasked: string;
  maxTokens?: number;
  contextWindow?: number;
  models?: AiProviderModelEntry[];
}

/** 内置提供商预设：选预设自动填名称与 Base URL，用户只需填 API Key */
export interface AiProviderPreset {
  /** 预设键（自定义 = custom，不落库，仅表单初值用） */
  key: string;
  /** 展示名（同时作为新增提供商的默认 name） */
  name: string;
  /** 默认 Base URL */
  baseURL: string;
  /** 默认模型（可留空，用户再改） */
  defaultModel: string;
  /** 默认模型目录（「恢复默认模型」用；参数由 guessModelCaps 按模型名补齐） */
  defaultModels: string[];
  /** 「去获取 API Key」的官网地址（设置页可点击跳转） */
  consoleUrl: string;
}

/**
 * 内置提供商预设的模型清单（`defaultModel` / `defaultModels`）。
 *
 * ⚠️ 与 `MODEL_CAPS_AS_OF` 同期核实（2026-10）：这里写的是**厂商 API 认的模型 ID**，
 * 填了已下线的型号，新用户保存后第一次对话就 404（如 DeepSeek 的 deepseek-chat/reasoner
 * 已于 2026-07-24 停服，换成 V4 代际命名）。每轮更新参数表时要顺带核对。
 * 硅基流动 / OpenRouter 是聚合网关，条目按其 `/models` 实际返回的 id 写。
 */
export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    key: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-flash',
    defaultModels: ['deepseek-flash', 'deepseek-v4-pro'],
    consoleUrl: 'https://platform.deepseek.com',
  },
  {
    key: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-6.1-sol',
    defaultModels: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.4-mini'],
    consoleUrl: 'https://platform.openai.com',
  },
  {
    key: 'moonshot',
    name: 'Kimi（月之暗面）',
    baseURL: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k3',
    defaultModels: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    consoleUrl: 'https://platform.moonshot.cn',
  },
  {
    key: 'zhipu',
    name: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.3',
    defaultModels: ['glm-5.3', 'glm-5.2', 'glm-4.7'],
    consoleUrl: 'https://open.bigmodel.cn',
  },
  {
    key: 'qwen',
    name: '通义千问 Qwen',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    defaultModels: ['qwen-plus', 'qwen-flash', 'qwen3.8-max'],
    consoleUrl: 'https://bailian.console.aliyun.com',
  },
  {
    key: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseURL: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    defaultModels: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen3-32B'],
    consoleUrl: 'https://cloud.siliconflow.cn',
  },
  {
    key: 'openrouter',
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-6.1-sol',
    defaultModels: ['openai/gpt-6.1-sol', 'anthropic/claude-sonnet-5.5', 'deepseek/deepseek-v4.1-flash'],
    consoleUrl: 'https://openrouter.ai/keys',
  },
];

/** 「自定义」选项（跟在预设后面渲染）：Base URL / 模型由用户手填 */
export const AI_PROVIDER_CUSTOM_PRESET: AiProviderPreset = {
  key: 'custom',
  name: '自定义（OpenAI 兼容）',
  baseURL: '',
  defaultModel: '',
  defaultModels: [],
  consoleUrl: '',
};

/** 提供商数量上限：设置页防误操作批量粘贴（正常个人使用远用不到 20 个） */
export const AI_PROVIDERS_MAX = 20;

/** 单提供商模型目录条目上限：/models 一次可能返回上百条，目录只留用户勾选的（防误全存） */
export const AI_PROVIDER_MODELS_MAX = 50;

// ---------- 模型参数识别（「最大输出 / 上下文长度」的自动智能填写） ----------

/** 内置参数表的联网核实时间（官方文档口径）；设置页展示，便于判断档位是否该更新了 */
export const MODEL_CAPS_AS_OF = '2026-10';

/** 模型参数档位（token 数）：maxTokens = 单次回复上限；contextWindow = 上下文窗口（含输入+输出） */
export interface ModelCaps {
  maxTokens?: number;
  contextWindow?: number;
}

/**
 * 常见模型参数表（按模型名小写子串匹配，**先专后泛**，第一个命中即用）。
 *
 * ⚠️ 数据口径：`MODEL_CAPS_AS_OF` 标注这批数字的核实时间，全部取**各家官方文档**的现役档位，
 * 2026-10 一轮按 platform 文档 + 聚合网关 /models 实测重新核对过（旧表里 DeepSeek 128K、
 * GLM 200K、qwen-plus 128K 都是 2025 年的档位，现役模型已普遍升到 1M）。
 * 定位仍是「智能建议」而非保证——不同部署/版本可能缩水，界面提示按模型实际参数微调；
 * 网关能返回真实档位时（DeepSeek / DashScope / OpenRouter / Kimi 都带）优先用真实值。
 *
 * 命中不到的模型（本地 Ollama、小众网关）返回 null，两个输入框留空 = 运行时回退全局默认。
 */
const MODEL_CAP_PATTERNS: Array<{ pattern: RegExp; caps: ModelCaps }> = [
  // DeepSeek（官方 2026-10 文档：现役 deepseek-flash / deepseek-v4-pro 均 1M 上下文、单次输出上限 384K；
  // deepseek-chat|reasoner 已于 2026-07-24 停服，仍在列只为让存过这两个名字的老配置按 V4 档位走，
  // 不被老的 128K/8K 建议值压住；开源权重版（deepseek-ai/DeepSeek-V3|R1 之类自部署）窗口按部署普遍只有 128K-160K）
  { pattern: /deepseek-(flash|pro|v4)|deepseek-chat|deepseek-reasoner/, caps: { maxTokens: 393216, contextWindow: 1048576 } },
  { pattern: /deepseek-v3\.2/, caps: { maxTokens: 65536, contextWindow: 163840 } },
  { pattern: /deepseek/, caps: { maxTokens: 65536, contextWindow: 131072 } },
  // Kimi / 月之暗面（kimi-k3 = 1M；k2.5/k2.6/k2.7 系 256K；
  // 官方文档只公布上下文、未公布单次输出上限，输出取 64K 稳妥档，需要更长回复可自行调大；
  // moonshot-v1-* 把上下文写在名字里，仍在列（老配置还能认出））
  { pattern: /moonshot-v1-8k/, caps: { maxTokens: 4096, contextWindow: 8192 } },
  { pattern: /moonshot-v1-32k/, caps: { maxTokens: 8192, contextWindow: 32768 } },
  { pattern: /moonshot-v1-128k/, caps: { maxTokens: 8192, contextWindow: 131072 } },
  { pattern: /kimi-k3|kimi-latest/, caps: { maxTokens: 65536, contextWindow: 1048576 } },
  { pattern: /kimi|moonshot/, caps: { maxTokens: 65536, contextWindow: 262144 } },
  // 智谱 GLM（官方 model-overview 2026-10：glm-5.2/5.3 系 1M 上下文 / 128K 输出；
  // glm-5、glm-4.7、glm-4.6 等 4.x-5.1 代 200K / 128K；glm-4.5 系 128K / 96K；glm-4-long 1M / 4K）
  { pattern: /chatglm/, caps: { maxTokens: 8192, contextWindow: 32768 } },
  { pattern: /glm-4-long/, caps: { maxTokens: 4096, contextWindow: 1048576 } },
  { pattern: /glm-4\.5/, caps: { maxTokens: 98304, contextWindow: 131072 } },
  { pattern: /glm-5\.[23]|glm-latest|glm-flash/, caps: { maxTokens: 131072, contextWindow: 1048576 } },
  { pattern: /glm/, caps: { maxTokens: 131072, contextWindow: 204800 } },
  // 通义千问（百炼 2026-10：qwen-plus / qwen-flash / qwen3.8-max 基础版已是 1M 上下文，
  // 分档计价（≤128K / 128-256K / 256K-1M），输出上限 32K（qwen3.8 系 128K）；
  // 老式 qwen-max（2.5 代）仍只有 32K 上下文——按代际分开匹配，泛匹配会误抬老模型）
  { pattern: /qwen3\.[78]|qwen-max-latest/, caps: { maxTokens: 131072, contextWindow: 1000000 } },
  { pattern: /qwen3-max/, caps: { maxTokens: 65536, contextWindow: 262144 } },
  { pattern: /qwen[\w.]*-(?:plus|flash|turbo)/, caps: { maxTokens: 32768, contextWindow: 1000000 } },
  { pattern: /qwen-max/, caps: { maxTokens: 8192, contextWindow: 32768 } },
  { pattern: /qwq/, caps: { maxTokens: 16384, contextWindow: 32768 } },
  { pattern: /qwen/, caps: { maxTokens: 16384, contextWindow: 131072 } },
  // 豆包 / 火山方舟（Seed 2.1 系 1024K 上下文 / 256K 输出；2.0-mini 256K / 128K；
  // 方舟文档用小写带点型号，控制台里也接受连字符写法，两种都归到同一档）
  { pattern: /doubao-seed-2[.-]?[01][.-]?(?:mini|turbo)/, caps: { maxTokens: 131072, contextWindow: 262144 } },
  { pattern: /doubao-(?:pro|lite|1-[45]|vision)/, caps: { maxTokens: 16384, contextWindow: 131072 } },
  { pattern: /doubao-seed-1-/, caps: { maxTokens: 65536, contextWindow: 262144 } },
  { pattern: /doubao/, caps: { maxTokens: 262144, contextWindow: 1048576 } },
  // MiniMax（M3 系 1M；M2 系 200K；官方未公布单次输出上限，取 64K 稳妥档）
  { pattern: /minimax-m[3-9]/, caps: { maxTokens: 65536, contextWindow: 1000000 } },
  { pattern: /minimax/, caps: { maxTokens: 65536, contextWindow: 204800 } },

  // OpenAI（2026-10 口径：窗口大小跟「档位名」走而非代数——旗舰系（gpt-6*、gpt-5.4~5.9，
  // 含 -sol/-luna/-astra/-terra/-pro 变体）1050K 上下文 / 128K 输出；-mini/-nano/-codex 与
  // gpt-5~5.3 系 400K / 128K；带 -chat 的历史命名 128K / 16K 且已在退役窗口内。
  // 注：platform.openai.com 文档站对本机 403，数字取 Azure Foundry 的 OpenAI 目录镜像
  // （2026-09-21 更新）与聚合网关 /models 实测交叉核对）
  { pattern: /gpt-oss/, caps: { maxTokens: 32768, contextWindow: 131072 } },
  { pattern: /gpt-3\.5/, caps: { maxTokens: 4096, contextWindow: 16385 } },
  { pattern: /gpt-4\.1/, caps: { maxTokens: 32768, contextWindow: 1047576 } },
  { pattern: /gpt-4o|gpt-4-|chatgpt-4o/, caps: { maxTokens: 16384, contextWindow: 128000 } },
  { pattern: /gpt-(5[.-][1-9]|6)-(mini|nano)/, caps: { maxTokens: 128000, contextWindow: 400000 } },
  { pattern: /gpt-(6|5[.-][4-9])/, caps: { maxTokens: 128000, contextWindow: 1050000 } },
  // 认不出的 gpt-*（含还没进表的新一代）按当代最低档 400K 建议，不再退回上代的 128K
  { pattern: /gpt-/, caps: { maxTokens: 128000, contextWindow: 400000 } },
  { pattern: /(^|\/)o[34](-mini|-preview)?($|-)/, caps: { maxTokens: 100000, contextWindow: 200000 } },
  // Claude（Anthropic 文档站对本机区域封禁，档位取 AWS Bedrock 官方 model card 核对：
  // 4.6 起含 5 系（sonnet/opus/fable/mythos）已 GA 到 1M 上下文 / 128K 输出，
  // 4 与 4.5 系仍是 200K / 64K（当年的 1M beta 已停），3 系兜底 8K 输出）
  { pattern: /claude-(sonnet|opus|fable|mythos)-(4[.-][678]|5([.-]\d+)?)/, caps: { maxTokens: 128000, contextWindow: 1000000 } },
  { pattern: /claude-(sonnet|opus|haiku)-4([.-]\d+)?/, caps: { maxTokens: 64000, contextWindow: 200000 } },
  { pattern: /claude/, caps: { maxTokens: 8192, contextWindow: 200000 } },
  // Gemini（2.5 起 pro/flash 全系 1M 上下文 / 64K 输出；-image 系列是独立小窗口档位。
  // 注意思考（thinking）token 也从这 64K 输出额度里扣，长回复场景可能要手动调大）
  { pattern: /gemini-[\w.-]*-image/, caps: { maxTokens: 32768, contextWindow: 131072 } },
  { pattern: /gemini/, caps: { maxTokens: 65536, contextWindow: 1048576 } },
  // Grok（xAI 一手档位与 Azure/Bedrock 渠道档位不一致，按一手文档取：4.5~4.7 = 500K/128K，
  // 4.3 = 1M，4-fast 系 2M，4 基础款 256K；名字里的「4-20」是 2025-06 发布日期不是窗口大小）
  { pattern: /grok-4(\.\d)?-fast/, caps: { maxTokens: 128000, contextWindow: 2000000 } },
  { pattern: /grok-4\.[5-9]/, caps: { maxTokens: 128000, contextWindow: 500000 } },
  { pattern: /grok-4\.3/, caps: { maxTokens: 128000, contextWindow: 1048576 } },
  { pattern: /grok/, caps: { maxTokens: 65536, contextWindow: 262144 } },
  // 其他开源权重：Llama 4 系原生 1M+（本地部署实际受 num_ctx 限制，这里只按官方标称建议），
  // 3.x 系 128K；Mistral 的 large/codestral 256K，其余 128K（-2512/-2603 之类是版本月份，不是窗口）
  { pattern: /llama[.-]?4|llama4/, caps: { maxTokens: 16384, contextWindow: 1048576 } },
  { pattern: /llama/, caps: { maxTokens: 8192, contextWindow: 131072 } },
  { pattern: /mistral-large|codestral|devstral/, caps: { maxTokens: 32768, contextWindow: 262144 } },
  { pattern: /mistral|mixtral|pixtral|ministral/, caps: { maxTokens: 16384, contextWindow: 131072 } },
  // 混元 / 文心 / 阶跃（各家文档未逐条核对，按聚合网关实测档位给建议值）
  { pattern: /hunyuan|hy3|hy4/, caps: { maxTokens: 128000, contextWindow: 262144 } },
  { pattern: /step-[3-9]/, caps: { maxTokens: 65536, contextWindow: 262144 } },
  { pattern: /ernie/, caps: { maxTokens: 16384, contextWindow: 131072 } },
];

/**
 * 模型名里的「窗口标记」→ 上下文窗口（token）：`moonshot-v1-128k`、`qwen3-32b-instruct-1m`、
 * `glm-4.6-200k` 这类把上下文写进名字的命名，档位不依赖参数表也能读出来。
 *
 * 只认「以 Nk / Nm 结尾（后面可再跟 instruct/chat/preview 之类角色词）」的整段：
 * 参数量写法（`-7b`、`-223b-a22b`）里没有 k/m 结尾的段，不会被误读成窗口。
 * 倍率按 1024 计（128k = 131072），与参数表里其余档位同一口径。
 */
const CONTEXT_HINT_RE =
  /(?:^|[-./_])(\d+(?:\.\d+)?)([km])(?:[-./_](?:instruct|chat|preview|thinking|turbo|fast|code|reasoner|it|vl))?(?:[-.][\d.]+)*$/i;

/** 从模型名后缀读上下文窗口；读不出返回 null（不编造数字，交给运行时全局兜底） */
export function capsFromModelNameHint(model: string): ModelCaps | null {
  const m = CONTEXT_HINT_RE.exec(model.trim().toLowerCase());
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const contextWindow = Math.round(value * (m[2].toLowerCase() === 'm' ? 1024 * 1024 : 1024));
  // 32K 以下的「窗口」多半是把别的数字（步数/版本号）当成了标记，宁可不填
  if (contextWindow < 32768) return null;
  return { contextWindow };
}

/** 按模型名猜测参数档位（智能填写的静态来源；网关若能返回真实参数则优先用真实值） */
export function guessModelCaps(model: string): ModelCaps | null {
  const name = model.trim().toLowerCase();
  if (!name) return null;
  for (const { pattern, caps } of MODEL_CAP_PATTERNS) {
    if (pattern.test(name)) return caps;
  }
  return capsFromModelNameHint(name);
}
