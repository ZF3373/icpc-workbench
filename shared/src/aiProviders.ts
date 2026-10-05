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

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    key: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultModels: ['deepseek-chat', 'deepseek-reasoner'],
    consoleUrl: 'https://platform.deepseek.com',
  },
  {
    key: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    defaultModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1'],
    consoleUrl: 'https://platform.openai.com',
  },
  {
    key: 'moonshot',
    name: 'Kimi（月之暗面）',
    baseURL: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    defaultModels: ['kimi-k2-0905-preview', 'moonshot-v1-8k', 'moonshot-v1-128k'],
    consoleUrl: 'https://platform.moonshot.cn',
  },
  {
    key: 'zhipu',
    name: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.7',
    defaultModels: ['glm-4.7', 'glm-4.6', 'glm-4.5-air'],
    consoleUrl: 'https://open.bigmodel.cn',
  },
  {
    key: 'qwen',
    name: '通义千问 Qwen',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    defaultModels: ['qwen-plus', 'qwen-max', 'qwen3-max'],
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
    defaultModel: 'openai/gpt-4o-mini',
    defaultModels: ['openai/gpt-4o-mini', 'deepseek/deepseek-chat-v3-0324', 'anthropic/claude-sonnet-4.5'],
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

/** 模型参数档位（token 数）：maxTokens = 单次回复上限；contextWindow = 上下文窗口（含输入+输出） */
export interface ModelCaps {
  maxTokens?: number;
  contextWindow?: number;
}

/**
 * 常见模型参数表（按模型名小写子串匹配，**先专后泛**，第一个命中即用）。
 *
 * 数字取官方文档/公开资料的常用档位，定位是「智能建议」而非保证——不同部署/版本可能
 * 缩水，界面 tooltip 始终提示按模型实际参数微调。命中不到的模型（本地 Ollama、小众网关）
 * 返回 null，两个输入框留空 = 运行时回退全局默认。
 */
const MODEL_CAP_PATTERNS: Array<{ pattern: RegExp; caps: ModelCaps }> = [
  // DeepSeek（V3.2 起官方口径：chat 128K 上下文 / 8K 输出，reasoner 128K / 64K）
  { pattern: /deepseek-reasoner|deepseek-r1/, caps: { maxTokens: 65536, contextWindow: 131072 } },
  { pattern: /deepseek-chat|deepseek-v3/, caps: { maxTokens: 8192, contextWindow: 131072 } },
  { pattern: /deepseek/, caps: { maxTokens: 8192, contextWindow: 65536 } },
  // OpenAI
  { pattern: /gpt-5/, caps: { maxTokens: 128000, contextWindow: 400000 } },
  { pattern: /gpt-4\.1/, caps: { maxTokens: 32768, contextWindow: 1047576 } },
  { pattern: /gpt-4o|chatgpt-4o/, caps: { maxTokens: 16384, contextWindow: 131072 } },
  { pattern: /(^|\/)o[134](-mini|-preview)?($|-)/, caps: { maxTokens: 100000, contextWindow: 200000 } },
  { pattern: /gpt-3\.5/, caps: { maxTokens: 4096, contextWindow: 16385 } },
  // Kimi / 月之暗面（moonshot-v1-* 的上下文写在名字里）
  { pattern: /moonshot-v1-8k/, caps: { maxTokens: 4096, contextWindow: 8192 } },
  { pattern: /moonshot-v1-32k/, caps: { maxTokens: 8192, contextWindow: 32768 } },
  { pattern: /moonshot-v1-128k/, caps: { maxTokens: 8192, contextWindow: 131072 } },
  { pattern: /kimi/, caps: { maxTokens: 16384, contextWindow: 262144 } },
  // 智谱 GLM（4.6：200K 上下文 / 128K 输出）
  { pattern: /glm-4\.[67]/, caps: { maxTokens: 131072, contextWindow: 204800 } },
  { pattern: /glm-4\.5/, caps: { maxTokens: 98304, contextWindow: 131072 } },
  { pattern: /glm/, caps: { maxTokens: 8192, contextWindow: 131072 } },
  // 通义千问（商用版 128K 档）
  { pattern: /qwen3-max/, caps: { maxTokens: 32768, contextWindow: 262144 } },
  { pattern: /qwen/, caps: { maxTokens: 16384, contextWindow: 131072 } },
  // Claude（4 系输出 64K，3 系及兜底 8K）
  { pattern: /claude-(sonnet|opus|haiku)-4|claude-4/, caps: { maxTokens: 64000, contextWindow: 200000 } },
  { pattern: /claude/, caps: { maxTokens: 8192, contextWindow: 200000 } },
  // Gemini（2.5 系 1M 上下文 / 64K 输出）
  { pattern: /gemini/, caps: { maxTokens: 65536, contextWindow: 1048576 } },
  // Grok / 豆包 / 其他
  { pattern: /grok-4/, caps: { maxTokens: 32768, contextWindow: 262144 } },
  { pattern: /grok/, caps: { maxTokens: 16384, contextWindow: 131072 } },
  { pattern: /doubao/, caps: { maxTokens: 16384, contextWindow: 131072 } },
  { pattern: /llama|meta-llama/, caps: { maxTokens: 8192, contextWindow: 131072 } },
  { pattern: /mistral|mixtral/, caps: { maxTokens: 8192, contextWindow: 131072 } },
];

/** 按模型名猜测参数档位（智能填写的静态来源；网关若能返回真实参数则优先用真实值） */
export function guessModelCaps(model: string): ModelCaps | null {
  const name = model.trim().toLowerCase();
  if (!name) return null;
  for (const { pattern, caps } of MODEL_CAP_PATTERNS) {
    if (pattern.test(name)) return caps;
  }
  return null;
}
