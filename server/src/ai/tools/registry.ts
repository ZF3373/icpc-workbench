import type { AiConfig } from '../../config.ts';
import type { ToolDefinition } from '../provider.ts';
import type { Db } from '../../db/index.ts';

/**
 * 工具注册表：参考 opencode 的 BaseTool 接口设计，将工具定义与执行逻辑集中管理。
 * 路由层通过 getToolDefinitions / executeToolCall 统一获取和执行工具，
 * 添加新工具只需调用 registerTool，无需修改路由代码。
 */

/** 工具执行结果 */
export interface ToolResult {
  /** 返回给 AI 的文本内容（作为 tool 角色消息注入对话） */
  content: string;
  /** 附带给前端的元数据（如搜索来源链接），不注入对话 */
  metadata?: unknown;
}

/** 平台 Cookie 映射（key = 平台 id 如 'luogu'，value = { cookie, csrf? }） */
export interface PlatformCookies {
  [platform: string]: { cookie?: string; csrf?: string };
}

/**
 * 工具执行上下文：在 AiConfig 基础上扩展运行时数据（如平台 Cookie）。
 * 工具按需读取 ctx.cookies 等，不关心则忽略。
 */
export interface ToolContext {
  /** 请求所属题库与用户；本地选题工具只读取该用户的提交记录。 */
  db?: Db;
  userId?: number;
  /** AI 配置（baseURL/apiKey/model/searchApiKey 等） */
  cfg: AiConfig;
  /** 用户已保存的平台 Cookie（来自 settings 表），fetch_url 等工具用于认证抓取 */
  cookies?: PlatformCookies;
  /**
   * 可选传输层注入（测试/自定义用）。生产缺省走**全局按域名节流**的 throttledFetch，
   * 保证 AI 工具抓取与同步管道共享同一份平台节奏，不会绕过风控限速。
   */
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

/** 工具接口：定义 + 执行函数 */
export interface AiTool {
  definition: ToolDefinition;
  /** 执行工具，args 为 AI 传入的参数对象，ctx 提供配置与运行时上下文 */
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

// ---------- 注册表 ----------

const registry = new Map<string, AiTool>();

/** 注册一个工具（按 definition.function.name 去重，后注册覆盖先注册） */
export function registerTool(tool: AiTool): void {
  registry.set(tool.definition.function.name, tool);
}

/** 获取已注册的工具名列表 */
export function getRegisteredToolNames(): string[] {
  return Array.from(registry.keys());
}

/**
 * 根据当前配置获取可用工具定义列表。
 * 工具可自行判断是否启用（如 web_search 需配置 searchApiKey）。
 */
export function getToolDefinitions(cfg: AiConfig): ToolDefinition[] {
  const result: ToolDefinition[] = [];
  for (const tool of registry.values()) {
    // 工具的 definition 始终收集，由 execute 内部判断密钥可用性
    // 这样 AI 知道有这个工具可用，但执行时若未配置密钥会返回提示
    result.push(tool.definition);
  }
  void cfg;
  return result;
}

/** 按名称查找已注册的工具 */
export function getTool(name: string): AiTool | undefined {
  return registry.get(name);
}

/**
 * 执行工具调用。
 * 返回 ToolResult（含 content 注入对话 + metadata 给前端）。
 * 未注册的工具返回错误提示，AI 可自行处理。
 */
export async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool) {
    return {
      content:
        `工具 ${name} 不可用（未注册）。可用工具：${getRegisteredToolNames().join(' / ') || '（无）'}。` +
        '不要臆造工具名；直接用文字回答，或改用上面列出的工具。',
    };
  }
  // 参数严格校验：AI 传错 key / 少必填 / 类型不对时，直接把「错在哪 + 正确结构」回给它，
  // 让模型在下一轮自行纠正。旧实现直接把 args 丢给 execute，工具内部再报各种莫名其妙的
  // 错误（例如 web_search 空 query 去搜一个空串），用户看到的是「工具失败」而不是格式问题。
  const issues = validateToolArgs(tool.definition.function.parameters, args);
  if (issues.length > 0) {
    return {
      content:
        `工具 ${name} 的参数不符合接口约定：\n` +
        issues.map((s) => `- ${s}`).join('\n') +
        `\n正确参数结构（JSON Schema）：${JSON.stringify(tool.definition.function.parameters)}\n` +
        '请严格按该结构重新调用；参数不合法时不要编造工具结果。',
    };
  }
  return tool.execute(args, ctx);
}

/* ---------------- 工具参数校验（JSON Schema 子集） ---------------- */

/** 工具 parameters 支持的 JSON Schema 子集（各工具定义只用到这些字段） */
interface ArgSchema {
  type?: string;
  properties?: Record<string, ArgSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ArgSchema;
  enum?: unknown[];
  minItems?: number;
  maxItems?: number;
  minLength?: number;
}

/** 运行时类型名：null/数组与 object 分开，整数值额外识别为 integer */
function jsonTypeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

/** 单个值是否符合某个 schema 节点（递归） */
function checkValue(schema: ArgSchema, value: unknown, path: string, issues: string[]): void {
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    issues.push(`${path} 必须是 ${schema.enum.map((e) => JSON.stringify(e)).join(' / ')} 之一，收到 ${JSON.stringify(value)}`);
    return;
  }
  if (schema.type) {
    const actual = jsonTypeOf(value);
    const expected = schema.type;
    // integer 允许 number? 不允许：接口写 integer 就是整数值；number 反过来接受 integer。
    const ok = expected === actual || (expected === 'number' && actual === 'integer');
    if (!ok) {
      issues.push(`${path} 类型应为 ${expected}，收到 ${actual}（${JSON.stringify(value)?.slice(0, 80)}）`);
      return;
    }
  }
  if (schema.type === 'string' && typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    issues.push(`${path} 至少 ${schema.minLength} 个字符（收到 ${value.length} 个）`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push(`${path} 至少 ${schema.minItems} 项（收到 ${value.length} 项）`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push(`${path} 最多 ${schema.maxItems} 项（收到 ${value.length} 项）`);
    }
    if (schema.items) {
      value.forEach((item, i) => checkValue(schema.items!, item, `${path}[${i}]`, issues));
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined || obj[key] === null || obj[key] === '') {
        issues.push(`缺少必填参数 ${path}.${key}`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (obj[key] !== undefined && obj[key] !== null) checkValue(sub, obj[key], `${path}.${key}`, issues);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in schema.properties)) issues.push(`不认识的参数 ${path}.${key}（接口不接受，请删掉）`);
      }
    }
  }
}

/**
 * 校验工具参数，返回人类可读的问题列表（空数组 = 通过）。
 * 只覆盖各工具定义实际用到的 schema 子集，够用且行为可预期。
 */
export function validateToolArgs(parameters: unknown, args: Record<string, unknown>): string[] {
  const schema = parameters as ArgSchema | undefined;
  if (!schema || schema.type !== 'object') return [];
  const issues: string[] = [];
  checkValue(schema, args, 'arguments', issues);
  return issues;
}

/** 重置注册表（测试用） */
export function resetToolRegistry(): void {
  registry.clear();
}
