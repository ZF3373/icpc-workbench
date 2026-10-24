/**
 * MCP 工具注册表：把本软件 REST API 的能力映射为外部 agent 可调用的 MCP tools。
 *
 * 每个工具 = 名称 + 中文描述 + JSON Schema 入参 + 一个经回环代理（proxy.ts）调用
 * /api/* 的 handler。刻意**不暴露**的能力（与 REST 面保持差集，属安全收窄）：
 * - 凭据类：Cookie/AI Key 的保存与原文取回（settings/cookies、settings/ai 的写与 reveal）
 * - 整库下载与恢复：备份文件下载、恢复点恢复登记、重启进程
 * - 账号管理写操作：绑定/改名/删除账号、适配器开关
 * AI 对话（SSE 流式）也不代理——MCP tools 是请求/响应模型，流式语义不匹配。
 */
import {
  callApi,
  describeApiError,
  ToolError,
  type ApiCallOptions,
  type QueryParams,
} from './proxy.ts';

/** 工具入参 JSON Schema 的属性描述（只用到 object 顶层属性，足够工具描述用）。 */
export interface ToolProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
  items?: { type: 'string' | 'number' | 'object' };
  default?: string | number | boolean;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolProperty>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

/** 平台标识（与 shared/PLATFORMS 对齐；字符串类型而非硬枚举——新平台接入不需要改这里） */
const PLATFORM_IDS = 'codeforces / atcoder / luogu / nowcoder / leetcode / daimayuan / jisuanke / dashoj / qoj';

// ---------- 工具执行上下文：包一层「非 2xx 即抛 ToolError」的回环客户端 ----------

export interface ToolContext {
  get(path: string, query?: QueryParams, timeoutMs?: number): Promise<unknown>;
  getText(path: string, query?: QueryParams, timeoutMs?: number): Promise<string>;
  post(path: string, body?: unknown, timeoutMs?: number): Promise<unknown>;
  patch(path: string, body?: unknown): Promise<unknown>;
  del(path: string, body?: unknown): Promise<unknown>;
}

/** 长任务超时：平台同步按题量/限速可能跑数分钟；备份受库体积影响 */
const LONG_TASK_TIMEOUT_MS = 10 * 60_000;

function unwrap(result: Awaited<ReturnType<typeof callApi>>): unknown {
  if (!result.ok) throw new ToolError(describeApiError(result), result.status, result.data);
  return result.data;
}

export function createToolContext(base: string): ToolContext {
  const call = (opts: ApiCallOptions) => callApi(base, opts);
  return {
    get: async (path, query, timeoutMs) => unwrap(await call({ method: 'GET', path, query, timeoutMs })),
    getText: async (path, query, timeoutMs) => {
      const r = await call({ method: 'GET', path, query, timeoutMs });
      if (!r.ok) throw new ToolError(describeApiError(r), r.status, r.data);
      return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    },
    post: async (path, body, timeoutMs) => unwrap(await call({ method: 'POST', path, body, timeoutMs })),
    patch: async (path, body) => unwrap(await call({ method: 'PATCH', path, body })),
    del: async (path, body) => unwrap(await call({ method: 'DELETE', path, body })),
  };
}

// ---------- 工具定义的简写助手 ----------

type Args = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const strArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

/** 定义一个工具（保持注册表是纯数据 + 短 handler，长逻辑都在路由层）。 */
function tool(
  name: string,
  description: string,
  properties: Record<string, ToolProperty>,
  handler: (args: Args, ctx: ToolContext) => Promise<unknown>,
  required: string[] = [],
): McpToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required }, handler };
}

/** 通用可选过滤参数（统计/历史类接口共用）。 */
function scopeProps(): Record<string, ToolProperty> {
  return {
    platform: { type: 'string', description: `只看某平台（${PLATFORM_IDS}）` },
    account: {
      type: 'string',
      description: '只看该平台下某账号的提交（必须与 platform 同时给出）',
    },
    from: { type: 'string', description: '起始日期（YYYY-MM-DD 或 ISO8601）' },
    to: { type: 'string', description: '结束日期（YYYY-MM-DD 或 ISO8601）' },
  };
}

// ---------- 工具注册表 ----------

export const MCP_TOOLS: McpToolDef[] = [
  // ===== 系统与状态 =====
  tool(
    'get_app_status',
    '获取软件运行状态：版本号、数据目录、支持的平台清单。适合作为外部 agent 接入后的第一个探活调用。',
    {},
    async (_a, ctx) => ctx.get('/api/health'),
  ),
  tool(
    'get_sync_status',
    '查看各刷题平台的同步健康状态：已绑定账号、凭据是否配置、最近一次同步的成败与摘要、后台续拉状态。',
    {},
    async (_a, ctx) => ctx.get('/api/sync/status'),
  ),
  tool(
    'sync_platform',
    `触发刷题记录同步（拉取平台最新提交入库）。platform 传 'all' 同步全部启用账号，或传单个平台 id（${PLATFORM_IDS}）。` +
      '注意：按题量与平台限速，整个同步可能持续数分钟；可传 days 只同步最近 N 天（1-365）加快首轮返回。同步结果包含拉取数、新增数与失败原因分类。',
    {
      platform: { type: 'string', description: "平台 id 或 'all'（默认 all）" },
      handle: { type: 'string', description: '只同步该平台下的指定账号（可省略）' },
      days: { type: 'number', description: '只同步最近 N 天（1-365，可省略 = 全量窗口）' },
    },
    async (a, ctx) => {
      const platform = str(a.platform) ?? 'all';
      const body: Record<string, unknown> = {};
      if (str(a.handle) !== undefined) body.handle = str(a.handle);
      if (num(a.days) !== undefined) body.days = num(a.days);
      return ctx.post(`/api/sync/${encodeURIComponent(platform)}`, body, LONG_TASK_TIMEOUT_MS);
    },
  ),
  tool(
    'get_settings_overview',
    '查看配置总览：AI 配置状态（密钥已打码）、各平台绑定账号、适配器开关、提醒与同步设置。不会返回任何密钥或 Cookie 原文。',
    {},
    async (_a, ctx) => ctx.get('/api/settings'),
  ),

  // ===== 统计与画像（只读） =====
  tool(
    'get_stats_overview',
    '练习数据总览：总提交/AC 量、去重解题数、平台分布、难度分布等核心指标。可按日期区间/平台/账号过滤。',
    scopeProps(),
    async (a, ctx) =>
      ctx.get('/api/stats', {
        from: str(a.from),
        to: str(a.to),
        platform: str(a.platform),
        account: str(a.account),
      }),
  ),
  tool(
    'get_weakness_analysis',
    '弱项分析：按知识点/标签统计真实 AC 率，结合卡点与最近复习反馈给出补强优先级（原始 AC 率与差值保留）。',
    {
      ...scopeProps(),
      minAttempts: { type: 'number', description: '最少尝试次数门槛（默认 5，低于此不构成弱项证据）' },
      topN: { type: 'number', description: '返回前 N 项（默认 10）' },
    },
    async (a, ctx) =>
      ctx.get('/api/stats/weakness', {
        minAttempts: num(a.minAttempts),
        topN: num(a.topN),
        platform: str(a.platform),
        account: str(a.account),
      }),
  ),
  tool(
    'get_mastery_map',
    '知识点掌握度地图：每个知识点按 未开始→接触→入门→掌握→熟练 五档评估，串联刷题数据、弱项画像与模板课程进度。',
    { minSolved: { type: 'number', description: '过滤掉解题数低于该值的知识点（默认 0）' } },
    async (a, ctx) => ctx.get('/api/stats/mastery', { minSolved: num(a.minSolved) }),
  ),
  tool(
    'get_practice_heatmap',
    '刷题热力图数据：逐日 AC 去重题数（同题重复 AC 只记 1 题），与打卡/日历同一本地日口径。',
    { days: { type: 'number', description: '回溯天数（默认 365）' } },
    async (a, ctx) => ctx.get('/api/stats/heatmap', { days: num(a.days) }),
  ),
  tool(
    'get_practice_summary',
    '完整个人练习画像：总量/平台/难度/知识点/弱项/掌握度/趋势/近期 AC/卡壳题/复习库/课程进度/打卡，一应俱全。适合喂给 agent 做深度分析；体积较大。',
    {},
    async (_a, ctx) => ctx.get('/api/stats/summary', undefined, 60_000),
  ),

  // ===== 题目与提交记录 =====
  tool(
    'search_problems',
    '搜索/筛选题库（含离线内置题库与已入库题目）：按关键词、平台、难度桶或区间、标签、做题状态过滤，分页返回并支持排序。这是给 agent 找题的主要入口。',
    {
      q: { type: 'string', description: '关键词（题号/标题模糊匹配）' },
      platform: { type: 'string', description: `平台（${PLATFORM_IDS}）` },
      difficulty: { type: 'string', description: '难度桶名（如入门/普及-/普及+/提高-/提高+/省选-/省选+/NOI/CTSC，按平台能力渲染）' },
      diffMin: { type: 'number', description: '统一 CF 标尺难度下界（如 800）' },
      diffMax: { type: 'number', description: '统一 CF 标尺难度上界（如 1600）' },
      tag: { type: 'array', items: { type: 'string' }, description: '算法标签（多个为 AND 关系）' },
      status: { type: 'string', description: '做题状态过滤：all / ac / tried / none（未做过）', enum: ['all', 'ac', 'tried', 'none'] },
      page: { type: 'number', description: '页码（默认 1）' },
      pageSize: { type: 'number', description: '每页数量（默认 50，上限 500）' },
      sort: { type: 'string', description: '排序字段：problem_key / difficulty / title / platform / attempts / ac_count / last_ac_at' },
      order: { type: 'string', description: 'asc / desc（默认 asc）' },
    },
    async (a, ctx) =>
      ctx.get('/api/problems/page', {
        q: str(a.q),
        platform: str(a.platform),
        difficulty: str(a.difficulty),
        diffMin: num(a.diffMin),
        diffMax: num(a.diffMax),
        tag: strArray(a.tag) ?? str(a.tag),
        status: str(a.status),
        page: num(a.page),
        pageSize: num(a.pageSize) ?? 50,
        sort: str(a.sort),
        order: str(a.order),
      }),
  ),
  tool(
    'list_submission_history',
    '写题历史（提交记录）：按题目视图或提交视图浏览，可按平台、结果（AC/失败）、日期区间、关键词过滤，分页返回。',
    {
      ...scopeProps(),
      view: { type: 'string', description: 'problem = 按题去重视图（默认），submission = 原始提交流' },
      result: { type: 'string', description: 'all / ac / failed（默认 all）' },
      q: { type: 'string', description: '关键词（题号/标题）' },
      page: { type: 'number', description: '页码（默认 1）' },
      pageSize: { type: 'number', description: '每页数量（默认 50，上限 200）' },
    },
    async (a, ctx) =>
      ctx.get('/api/history/submissions', {
        view: str(a.view),
        platform: str(a.platform),
        result: str(a.result),
        from: str(a.from),
        to: str(a.to),
        q: str(a.q),
        page: num(a.page),
        pageSize: num(a.pageSize),
      }),
  ),
  tool(
    'fetch_problem_bank',
    '从平台拉取公开题库入库（扩充可选题量）。Codeforces 秒级；洛谷/牛客/计蒜客按页拉取，可能需要数分钟。已有题自动去重更新。',
    {
      platform: {
        type: 'string',
        description: '题库来源平台',
        enum: ['codeforces', 'luogu', 'nowcoder', 'leetcode', 'atcoder', 'daimayuan', 'dashoj', 'jisuanke'],
      },
      max: { type: 'number', description: '最多拉取条数（可省略）' },
      luoguMinDifficulty: { type: 'number', description: '洛谷最低难度过滤（可省略）' },
      full: { type: 'boolean', description: '是否全量拉取（洛谷场景，可省略）' },
    },
    async (a, ctx) =>
      ctx.post(
        '/api/problems/bank',
        {
          platform: str(a.platform),
          max: num(a.max),
          luoguMinDifficulty: num(a.luoguMinDifficulty),
          full: bool(a.full),
        },
        LONG_TASK_TIMEOUT_MS,
      ),
    ['platform'],
  ),

  // ===== 今日训练与训练计划 =====
  tool(
    'get_today_training',
    '获取今日训练：按估算能力值分三档（巩固/核心/挑战）的推荐题、到期复习、当日计划任务与完成进度。注意该接口有写副作用（推荐题写入冷却记录，供次日轮换）。',
    {
      consolidation: { type: 'number', description: '巩固档数量 0-6（可省略）' },
      core: { type: 'number', description: '核心档数量 0-6（可省略）' },
      challenge: { type: 'number', description: '挑战档数量 0-6（可省略）' },
      rotate: { type: 'number', description: '跳过前 N 个冷却位强制换题（0-500，可省略）' },
    },
    async (a, ctx) =>
      ctx.get('/api/today', {
        consolidation: num(a.consolidation),
        core: num(a.core),
        challenge: num(a.challenge),
        rotate: num(a.rotate),
      }),
  ),
  tool('list_plans', '训练计划列表（含每个计划的任务数与打卡进度）。', {}, async (_a, ctx) => ctx.get('/api/plans')),
  tool(
    'get_plan',
    '训练计划详情：计划元信息 + 全部任务（日期/标题/类型/链接/打卡状态）。',
    { id: { type: 'number', description: '计划 id（见 list_plans）' } },
    async (a, ctx) => {
      const id = num(a.id);
      if (id === undefined) throw new ToolError('缺少必填参数 id');
      return ctx.get(`/api/plans/${id}`);
    },
    ['id'],
  ),
  tool(
    'import_ai_plan',
    '导入训练计划：把（任意 AI 生成的）计划 JSON 文本入库，自动清洗代码围栏与解释文字。配合 export_plan_package 使用可完成「本地生成数据包 → 外部 AI 编排 → 导回」的闭环。',
    {
      raw: { type: 'string', description: 'AI 返回的计划 JSON 文本（可带 markdown 围栏或解释文字）' },
      startDate: { type: 'string', description: '计划起始日 YYYY-MM-DD（可省略）' },
      days: { type: 'number', description: '计划天数（可省略）' },
    },
    async (a, ctx) =>
      ctx.post('/api/plans/import', { raw: str(a.raw), startDate: str(a.startDate), days: num(a.days) }),
    ['raw'],
  ),
  tool(
    'export_plan_package',
    '导出 AI 计划数据包：完整练习画像 + 提示词（可让外部 agent 据此编排训练计划，再用 import_ai_plan 导回）。',
    {
      days: { type: 'number', description: '计划天数 1-90（默认 14）' },
      startDate: { type: 'string', description: '起始日 YYYY-MM-DD（可省略）' },
      dailyTasks: { type: 'number', description: '每日任务上限 1-6（可省略）' },
    },
    async (a, ctx) =>
      ctx.get('/api/export/plan-package', {
        days: num(a.days),
        startDate: str(a.startDate),
        dailyTasks: num(a.dailyTasks),
      }),
  ),
  tool(
    'shift_plan',
    '整体顺延训练计划：未完成的练习/专题任务后移 N 天，可避开周末、限制每日任务上限；已完成任务、比赛和复习保持原日期。',
    {
      id: { type: 'number', description: '计划 id' },
      days: { type: 'number', description: '顺延天数 0-30' },
      skipWeekends: { type: 'boolean', description: '是否避开周末' },
      dailyLimit: { type: 'number', description: '顺延后每日任务上限（可省略）' },
    },
    async (a, ctx) => {
      const id = num(a.id);
      const days = num(a.days);
      if (id === undefined || days === undefined) throw new ToolError('缺少必填参数 id / days');
      return ctx.post(`/api/plans/${id}/shift`, {
        days,
        skipWeekends: bool(a.skipWeekends),
        dailyLimit: num(a.dailyLimit),
      });
    },
    ['id', 'days'],
  ),
  tool(
    'update_plan_task',
    '修改单条计划任务：日期/标题/类型/链接/备注均可改（至少给一个字段）。',
    {
      taskId: { type: 'number', description: '任务 id（见 get_plan 的 tasks[].id）' },
      taskDate: { type: 'string', description: '任务日期 YYYY-MM-DD' },
      title: { type: 'string', description: '任务标题' },
      kind: { type: 'string', description: '任务类型', enum: ['practice', 'review', 'topic', 'contest'] },
      url: { type: 'string', description: '题目/比赛链接（传空串清除）' },
      note: { type: 'string', description: '备注（传空串清除）' },
    },
    async (a, ctx) => {
      const taskId = num(a.taskId);
      if (taskId === undefined) throw new ToolError('缺少必填参数 taskId');
      const body: Record<string, unknown> = {};
      if (str(a.taskDate) !== undefined) body.taskDate = str(a.taskDate);
      if (str(a.title) !== undefined) body.title = str(a.title);
      if (str(a.kind) !== undefined) body.kind = str(a.kind);
      if (typeof a.url === 'string') body.url = a.url; // 空串合法：清链接
      if (typeof a.note === 'string') body.note = a.note;
      return ctx.patch(`/api/plans/tasks/${taskId}`, body);
    },
    ['taskId'],
  ),
  tool(
    'delete_plan_task',
    '删除单条计划任务（不可恢复，删整个计划请用 delete_plan）。',
    { taskId: { type: 'number', description: '任务 id' } },
    async (a, ctx) => {
      const taskId = num(a.taskId);
      if (taskId === undefined) throw new ToolError('缺少必填参数 taskId');
      return ctx.del(`/api/plans/tasks/${taskId}`);
    },
    ['taskId'],
  ),
  tool(
    'delete_plan',
    '删除整个训练计划（含全部任务，级联不可恢复；删前可先用 create_backup 留恢复点）。',
    { id: { type: 'number', description: '计划 id' } },
    async (a, ctx) => {
      const id = num(a.id);
      if (id === undefined) throw new ToolError('缺少必填参数 id');
      return ctx.del(`/api/plans/${id}`);
    },
    ['id'],
  ),

  // ===== 题单 =====
  tool('list_problem_lists', '题单列表（含每个题单的题目数/分类数/已完成数）。', {}, async (_a, ctx) => ctx.get('/api/lists')),
  tool(
    'get_problem_list',
    '题单详情：全部条目（题目、分类、完成状态）与 AI 建议（如有缓存）。',
    { id: { type: 'number', description: '题单 id（见 list_problem_lists）' } },
    async (a, ctx) => {
      const id = num(a.id);
      if (id === undefined) throw new ToolError('缺少必填参数 id');
      return ctx.get(`/api/lists/${id}`);
    },
    ['id'],
  ),
  tool(
    'import_problem_list',
    '新建题单：粘贴题单原文（每行一题：题号或链接），自动解析识别题目入库；识别不了的会明确列出。',
    {
      title: { type: 'string', description: '题单标题（≤60 字）' },
      raw: { type: 'string', description: '题单原文（每行一题：题号/链接）' },
      sourceUrl: { type: 'string', description: '题单来源链接（可省略）' },
    },
    async (a, ctx) =>
      ctx.post('/api/lists', { title: str(a.title), raw: str(a.raw), sourceUrl: str(a.sourceUrl) }),
    ['title', 'raw'],
  ),
  tool(
    'add_problems_to_list',
    '向已有题单追加题目（粘贴题号/链接文本，自动解析；重复与无法识别的会分别列出）。',
    {
      id: { type: 'number', description: '题单 id' },
      raw: { type: 'string', description: '追加的题目文本（每行一题）' },
    },
    async (a, ctx) => {
      const id = num(a.id);
      if (id === undefined) throw new ToolError('缺少必填参数 id');
      return ctx.post(`/api/lists/${id}/items`, { raw: str(a.raw) }, undefined);
    },
    ['id', 'raw'],
  ),
  tool(
    'classify_problem_list',
    '按规则给题单条目分类（本地规则匹配，不调 AI、幂等可重跑）。',
    { id: { type: 'number', description: '题单 id' } },
    async (a, ctx) => {
      const id = num(a.id);
      if (id === undefined) throw new ToolError('缺少必填参数 id');
      return ctx.post(`/api/lists/${id}/classify`);
    },
    ['id'],
  ),

  // ===== 打卡 =====
  tool(
    'get_checkin_calendar',
    '打卡日历：某月每日任务量/打卡数，外加当前连续打卡、历史最长与累计打卡天数。',
    { month: { type: 'string', description: "月份 YYYY-MM（默认本月）" } },
    async (a, ctx) => {
      // month 是必填查询参数：默认值在这里算（本地时区当月，与打卡的本地日口径一致）
      const now = new Date();
      const month =
        str(a.month) ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      // 两次回环合并成一个结果：日历格子和连续天数前端也是分开拉的，agent 一次拿全
      const [days, streak] = await Promise.all([
        ctx.get('/api/checkins', { month }),
        ctx.get('/api/checkins/streak'),
      ]);
      return { month, days, streak };
    },
  ),
  tool(
    'checkin_task',
    '给某条当日计划任务打卡（taskId 见 get_today_training 的 planTasks 或 get_plan 的 tasks）。',
    { taskId: { type: 'number', description: '任务 id' } },
    async (a, ctx) => {
      const taskId = num(a.taskId);
      if (taskId === undefined) throw new ToolError('缺少必填参数 taskId');
      return ctx.post('/api/checkins', { taskId });
    },
    ['taskId'],
  ),
  tool(
    'cancel_checkin',
    '取消某条任务的打卡（幂等）。',
    { taskId: { type: 'number', description: '任务 id' } },
    async (a, ctx) => {
      const taskId = num(a.taskId);
      if (taskId === undefined) throw new ToolError('缺少必填参数 taskId');
      return ctx.del(`/api/checkins/${taskId}`);
    },
    ['taskId'],
  ),
  tool(
    'auto_checkin_today',
    '自动打卡今天已 AC 的计划练习任务。不传 taskIds = 只预览（列出可打卡项，不写库）；传入 taskIds（先预览拿到的）= 确认写库。旧 AC、回顾和模拟赛不会被自动打卡。',
    { taskIds: { type: 'array', items: { type: 'number' }, description: '预览返回的任务 id 列表；省略 = 仅预览' } },
    async (a, ctx) => {
      const ids = Array.isArray(a.taskIds) ? a.taskIds.map(Number).filter(Number.isInteger) : undefined;
      return ctx.post('/api/checkins/auto-today', ids ? { taskIds: ids } : undefined);
    },
  ),

  // ===== 复习队列 =====
  tool(
    'list_review_queue',
    '复习队列：间隔重复排期的全部条目；due=1 只看到期的，date 看某天到期的。',
    {
      due: { type: 'boolean', description: 'true = 只看到期未复习的条目' },
      date: { type: 'string', description: '只看某天（YYYY-MM-DD）到期的' },
    },
    async (a, ctx) => ctx.get('/api/reviews', { due: a.due === true ? '1' : undefined, date: str(a.date) }),
  ),
  tool(
    'add_to_review_queue',
    '把一道题加入复习队列（间隔重复排期，已在队列则幂等返回当前到期日）。题目需已在题库（先同步或 search_problems 确认）。',
    {
      platform: { type: 'string', description: `平台 id（${PLATFORM_IDS}）` },
      problemKey: { type: 'string', description: '平台内题目标识（如 1900F / P1001 / abc321_a）' },
    },
    async (a, ctx) =>
      ctx.post('/api/reviews', { platform: str(a.platform), problemKey: str(a.problemKey) }),
    ['platform', 'problemKey'],
  ),
  tool(
    'review_feedback',
    '提交一次复习反馈并自动重排下次到期日（hard/ok/easy 三档影响间隔倍率）。',
    {
      id: { type: 'number', description: '复习条目 id（见 list_review_queue）' },
      feedback: { type: 'string', description: '复习感受', enum: ['hard', 'ok', 'easy'] },
    },
    async (a, ctx) => {
      const id = num(a.id);
      const feedback = str(a.feedback);
      if (id === undefined || !feedback) throw new ToolError('缺少必填参数 id / feedback');
      return ctx.post(`/api/reviews/${id}/feedback`, { feedback });
    },
    ['id', 'feedback'],
  ),
  tool(
    'remove_from_review_queue',
    '把条目移出复习队列（连带复习事件记录）。',
    { id: { type: 'number', description: '复习条目 id' } },
    async (a, ctx) => {
      const id = num(a.id);
      if (id === undefined) throw new ToolError('缺少必填参数 id');
      return ctx.del(`/api/reviews/${id}`);
    },
    ['id'],
  ),

  // ===== 比赛 =====
  tool(
    'list_contests',
    '赛事日历：聚合各平台公开比赛（Codeforces/AtCoder/洛谷/牛客/DashOJ 等），按 upcoming/running/finished 过滤，支持关键词搜索。',
    {
      type: { type: 'string', description: 'upcoming（默认）/ running / finished' },
      platform: { type: 'string', description: '只看某平台' },
      q: { type: 'string', description: '关键词' },
      limit: { type: 'number', description: '返回条数上限' },
      offset: { type: 'number', description: '分页偏移' },
    },
    async (a, ctx) =>
      ctx.get('/api/contests', {
        type: str(a.type),
        platform: str(a.platform),
        q: str(a.q),
        limit: num(a.limit),
        offset: num(a.offset),
      }),
  ),
  tool(
    'list_participated_contests',
    '我参加过的比赛（本地提交推导 + 平台参赛记录双通道，含排名与 Rating 变化）。首次查询会触发后台增量刷新。',
    {},
    async (_a, ctx) => ctx.get('/api/contests/participated', undefined, 60_000),
  ),

  // ===== 模板课程 =====
  tool(
    'list_templates',
    '模板课程库全量：内置 + 自建模板的分类、学习状态（todo/learning/mastered）、例题完成情况与学习进度。',
    {},
    async (_a, ctx) => ctx.get('/api/templates'),
  ),

  // ===== 备份与导入导出 =====
  tool(
    'create_backup',
    '手动创建一个数据库恢复点（VACUUM INTO 一致快照）。在做批量修改（导入/删计划）前调用可保底回滚。',
    {},
    async (_a, ctx) => ctx.post('/api/backups', undefined, 300_000),
  ),
  tool(
    'export_summary_markdown',
    '导出完整练习数据汇总为 Markdown 文本（与「练习数据汇总」页下载的内容一致），适合直接贴给外部 AI 复盘。',
    {},
    async (_a, ctx) => ctx.getText('/api/export/summary.md', undefined, 60_000),
  ),
  tool(
    'import_submissions',
    '手动导入提交记录（无需平台凭据的场景）。每行一题：problemKey 必填，verdict 取 AC/WA/TLE/RE/MLE/CE/SKIPPED（缺省 SKIPPED），submittedAt 缺省为当前时刻。批量 ≥20 行会自动先建备份。',
    {
      platform: { type: 'string', description: `提交所属平台 id（${PLATFORM_IDS}）` },
      rows: {
        type: 'array',
        description: '提交行数组',
        items: { type: 'object' },
      },
    },
    async (a, ctx) => {
      const platform = str(a.platform);
      if (!platform) throw new ToolError('缺少必填参数 platform');
      const rows = Array.isArray(a.rows) ? a.rows : undefined;
      if (!rows || rows.length === 0) throw new ToolError('缺少必填参数 rows（至少一条提交）');
      return ctx.post('/api/import/manual', { platform, rows }, LONG_TASK_TIMEOUT_MS);
    },
    ['platform', 'rows'],
  ),
];
