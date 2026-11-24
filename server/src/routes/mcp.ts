/**
 * MCP 端点（外部 agent 操控本软件的统一入口）。
 *
 * 形态：Streamable HTTP + 无状态模式（官方 SDK 的 stateless 范式）——每个 POST 新建
 * transport 与 Server，用普通 JSON 响应（非 SSE 流）回包，不维护会话。客户端断线重连、
 * 多客户端并发、进程重启都不需要服务端保活状态，符合「本地单用户应用」的简单性边界。
 *
 * 挂载后外部 agent 以 `http://127.0.0.1:<port>/mcp` 接入（Claude Desktop / Cursor /
 * Claude Code 等），可用工具见 src/mcp/tools.ts。
 *
 * 安全边界（与全站一致，无新增暴露面）：
 * - 工具能力 ⊆ REST API（每个工具只是回环调用某个已存在的 /api/* 端点，且刻意不含
 *   凭据读写、整库下载/恢复、账号删除等敏感操作）；
 * - 沿用全局 hostGuard（绑回环时拒绝非回环 Host，防 DNS rebinding）；
 * - 不加 CORS 头：浏览器恶意页面发不带头部的跨域 POST 会被 content-type 预检挡住，
 *   transport 还强制校验 Content-Type: application/json；
 * - HOST=0.0.0.0（Docker 显式暴露）时与 REST API 同等暴露，属操作者主动选择。
 */
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { asyncHandler } from '../asyncHandler.ts';
import { createMcpServer } from '../mcp/server.ts';

/**
 * 从当前请求推导回环基地址：MCP 端点与 REST API 同进程同端口，socket 的本地端口
 * 就是 REST 服务的端口。不用 Host 头（客户端可控），也不依赖启动期全局变量（SEA
 * 桌面版存在端口漂移，listen 前后取值都容易脱节）。
 */
function loopbackBaseOf(req: express.Request): string {
  const port = req.socket.localPort;
  if (!port) throw new Error('无法确定回环端口（socket 无本地端口）');
  // 绑 ::1 的场景用 IPv6 回环；::ffff:127.0.0.1 这类 IPv4 映射地址仍走 127.0.0.1
  const addr = req.socket.localAddress ?? '';
  const host = addr.includes(':') && !addr.includes('.') ? '[::1]' : '127.0.0.1';
  return `http://${host}:${port}`;
}

/**
 * 同时在飞的 tools/call 上限（issue #66）。
 *
 * 为什么需要：MCP 是无状态端点，外部 agent（Claude Desktop / Cursor）会不受控地并发打进来；
 * 而 Node 是单事件循环 + node:sqlite 全同步 API，两三个「拉题库 / 导出汇总」级的大查询
 * 叠在一起就能把事件循环占满十几秒 —— 桌面壳的健康探测连续超时，会把一个**正常但忙碌**的
 * 核心判成「本地服务未响应」并杀掉（用户看到的就是「一开 Claude Desktop 工作台就掉线」）。
 * 这里对**工具调用**限流而不是对请求限流：initialize / tools/list 是廉价的协议握手，
 * 卡住它们只会让客户端以为服务不存在，反而更糟。
 */
const MAX_CONCURRENT_TOOL_CALLS = 2;
let inflightToolCalls = 0;

/** 该 POST 是不是一次 tools/call（协议握手放行，不做限流） */
function isToolCallBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const method = (body as { method?: unknown }).method;
  return method === 'tools/call';
}

export function mcpRoutes(): express.Router {
  const r = express.Router();

  // MCP 唯一入口：initialize / notifications / tools/list / tools/call 全部走 POST。
  // req.body 已被全局 express.json 解析（transport 对非 JSON Content-Type 会自行 400）。
  r.post(
    '/',
    asyncHandler(async (req, res) => {
      const toolCall = isToolCallBody(req.body);
      if (toolCall) {
        if (inflightToolCalls >= MAX_CONCURRENT_TOOL_CALLS) {
          // 503 + Retry-After：MCP 客户端（及背后的模型）会据此退避重试，
          // 而不是把「服务忙」当成「工具不存在」并把错误写进对话。
          res.setHeader('Retry-After', '2');
          res.status(503).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: '工作台正忙（并发工具调用已达上限），请稍后重试' },
            id: (req.body as { id?: unknown }).id ?? null,
          });
          return;
        }
        inflightToolCalls += 1;
        res.on('close', () => { inflightToolCalls = Math.max(0, inflightToolCalls - 1); });
      }
      const base = loopbackBaseOf(req);
      const transport = new StreamableHTTPServerTransport({
        // undefined = 显式无状态：不生成 Mcp-Session-Id，客户端每次 POST 都是独立请求
        sessionIdGenerator: undefined,
        // 用普通 JSON 响应而不是 SSE 流回包：工具都是一次性调用，流式没有意义，
        // 且能绕开 compression 中间件对 text/event-stream 的特殊处理
        enableJsonResponse: true,
      });
      const server = createMcpServer(base);
      // 连接关闭即释放本请求的两件套（无状态模式下不会有下一个请求复用它们）
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    }),
  );

  // 无状态模式不支持服务端主动推送：GET（SSE 流）按规范回 405
  r.get('/', (_req, res) => {
    res.status(405).json({ error: 'MCP 端点只接受 POST（无状态模式，不支持 SSE 流）' });
  });
  // 会话由客户端概念上持有，服务端无会话可终止：DELETE 也回 405
  r.delete('/', (_req, res) => {
    res.status(405).json({ error: '无状态 MCP 端点不支持会话终止（DELETE）' });
  });

  return r;
}
