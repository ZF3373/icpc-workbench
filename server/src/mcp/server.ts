/**
 * MCP Server 实例工厂（低层 Server，非 McpServer 高层封装）。
 *
 * 无状态 Streamable HTTP 模式下每个 POST 都新建 transport + Server（见 routes/mcp.ts），
 * 因此这里必须便宜且无共享可变状态：工具注册表是模块级常量，请求上下文（回环基地址）
 * 通过闭包注入。低层 Server 自动应答 initialize（协议协商），这里只需挂 tools/list 与
 * tools/call 两个 handler。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { APP_VERSION } from '../routes/update.ts';
import { MCP_TOOLS, createToolContext, type ToolContext } from './tools.ts';
import { ToolError } from './proxy.ts';

/** 单个工具结果文本的长度上限：外部 agent 的上下文有限，超大响应必须截断而不是硬塞 */
const MAX_RESULT_CHARS = 80_000;

/**
 * 把工具返回值渲染成 CallToolResult 的文本内容。
 * JSON 紧凑序列化（省 token）；超限时从尾部截掉并附明确提示，引导 agent 用分页/过滤参数重取。
 */
function renderToolResult(value: unknown): string {
  const text =
    typeof value === 'string' ? value : JSON.stringify(value, (_k, v) => (v === undefined ? null : v));
  if (text === undefined) return 'null';
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n…[结果超过 ${MAX_RESULT_CHARS} 字符已截断：请用分页/过滤参数缩小查询范围后重试]`;
}

/** 工具执行异常 → isError 的 CallToolResult（协议内错误，模型可见并自行纠正参数重试）。 */
function errorResult(e: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const detail = e instanceof ToolError ? `${e.message}` : `${(e as Error)?.message ?? String(e)}`;
  return { content: [{ type: 'text', text: `工具执行失败：${detail}` }], isError: true };
}

/**
 * 创建一个绑定到指定回环基地址的 MCP Server。
 * @param apiBase 形如 http://127.0.0.1:3001 的基地址，工具经它回环调用 /api/*
 */
export function createMcpServer(apiBase: string): Server {
  const server = new Server({ name: 'icpc-workbench', version: APP_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    const def = MCP_TOOLS.find((t) => t.name === name);
    if (!def) return errorResult(new ToolError(`未知工具 ${name}（可用工具见 tools/list）`));
    let ctx: ToolContext | null = null;
    try {
      ctx = createToolContext(apiBase);
      const value = await def.handler(args, ctx);
      return { content: [{ type: 'text', text: renderToolResult(value) }] };
    } catch (e) {
      return errorResult(e);
    }
  });

  return server;
}
