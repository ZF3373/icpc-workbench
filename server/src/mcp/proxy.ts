/**
 * MCP 工具层 → 本机 REST API 的回环代理。
 *
 * 设计取舍：MCP 工具不直接复用各路由的内部函数，而是经 `http://127.0.0.1:<port>`
 * 回环调用已挂载的 /api/* 路由——业务校验、权限语义、备份触发等逻辑全在路由层，
 * 代理过去就不会出现「MCP 通道绕过校验」或「两处实现漂移」的问题；新增路由能力
 * MCP 侧只改映射表。回环开销（本机 TCP + 同一事件循环）毫秒级，相对 MCP 客户端
 * 的模型推理成本可忽略。
 *
 * 安全：回环地址取自当前请求 socket 的实际本地端口（见 routes/mcp.ts），不是客户端
 * 可控的 Host 头——MCP 端点与 REST API 同进程同端口，agent 能连上 /mcp 就意味着
 * 服务本身在跑，回环调用必然可达。
 */

/** 单值查询参数（undefined / null / 空串在拼 URL 时剔除，保持 REST 端点的默认值语义）。 */
export type QueryValue = string | number | boolean | undefined | null;
export type QueryParams = Record<string, QueryValue | QueryValue[]>;

export interface ApiCallOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** 以 / 开头的 API 路径（如 /api/stats） */
  path: string;
  query?: QueryParams;
  /** JSON 请求体（GET/DELETE 省略） */
  body?: unknown;
  /** 回环请求超时；默认 30 秒，同步/拉题库等长任务由工具层显式调大 */
  timeoutMs?: number;
}

export interface ApiResult {
  ok: boolean;
  status: number;
  /** 解析后的 JSON；响应不是 JSON 时为原始文本 */
  data: unknown;
}

/** 默认回环超时：绝大多数接口毫秒级返回，30 秒只兜底慢查询 */
export const DEFAULT_API_TIMEOUT_MS = 30_000;

/**
 * 工具执行失败（上游非 2xx / 回环不可达 / 参数缺失）。
 * 用异常而不是返回值承载，工具 handler 里就不必层层判 ok——server.ts 统一捕获后
 * 以 isError 的 CallToolResult 回给 MCP 客户端（协议内错误，模型可见可自纠）。
 */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/** 拼查询串：剔除空值；数组展开为同名多值（如 tag=a&tag=b，题库筛选依赖该形态）。 */
function buildSearch(query?: QueryParams): string {
  if (!query) return '';
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== '') sp.append(key, String(item));
      }
    } else {
      sp.append(key, String(value));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** 发起一次回环 API 调用。HTTP 非 2xx 不抛异常（交给调用方决定如何呈现），网络层失败才抛。 */
export async function callApi(base: string, opts: ApiCallOptions): Promise<ApiResult> {
  const url = `${base}${opts.path}${buildSearch(opts.query)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method,
      headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS),
    });
  } catch (e) {
    // 回环打不通基本只可能是超时（长同步被截断）——把原因带出去，别让 agent 猜
    throw new ToolError(
      `回环请求失败：${opts.method} ${opts.path}（${(e as Error).message}）`,
    );
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

/** 从上游错误响应中提炼可读文案（各路由统一返回 { error: '...' }，兜底原始 JSON）。 */
export function describeApiError(result: ApiResult): string {
  const d = result.data as { error?: unknown } | null | undefined;
  const reason =
    d && typeof d === 'object' && typeof d.error === 'string' ? d.error : JSON.stringify(result.data);
  return `上游接口返回 HTTP ${result.status}: ${reason}`;
}
