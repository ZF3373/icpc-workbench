import type { AiConfig } from '../../config.ts';
import type { ToolDefinition } from '../provider.ts';

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
  /** AI 配置（baseURL/apiKey/model/searchApiKey 等） */
  cfg: AiConfig;
  /** 用户已保存的平台 Cookie（来自 settings 表），fetch_url 等工具用于认证抓取 */
  cookies?: PlatformCookies;
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
    return { content: `工具 ${name} 不可用` };
  }
  return tool.execute(args, ctx);
}

/** 重置注册表（测试用） */
export function resetToolRegistry(): void {
  registry.clear();
}
