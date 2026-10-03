import fs from 'node:fs';
import path from 'node:path';
import type {
  NormalizedSubmission,
  PlatformId,
  Verdict,
} from '../../../shared/src/index.ts';
import { difficultyFields } from '../../../shared/src/difficulty.ts';
import type { FetchOptions, PlatformAdapter } from './types.ts';
import { asHttpClient, sleep, type HttpInit } from './http.ts';

const API = 'https://kenkoooo.com/atcoder';
const RESOURCES_TTL_MS = 24 * 3600 * 1000;
/** 上游单次响应最多返回这么多行（窗口大小），实测确认：请求 `/user/submissions` 恒定最多 500 行 */
const SUBMISSION_PAGE = 500;
// 每次同步的保守页数上限（×1s sleep × 500/页：每次同步最多约 30 分钟），把全量分页拆成多次防封号
const PER_SYNC_MAX_PAGES = 60;
const PAGE_DELAY_MS = 1000; // 官方要求访问间隔 >= 1s

const RESULT_MAP: Record<string, Verdict> = {
  AC: 'AC',
  WA: 'WA',
  TLE: 'TLE',
  MLE: 'MLE',
  RE: 'RE',
  CE: 'CE',
  OLE: 'RE',
  IE: 'RE',
  WJ: 'SKIPPED',
  WR: 'SKIPPED',
  JUDGE: 'SKIPPED',
};

interface KenkoooSubmission {
  id: number;
  epoch_second: number;
  problem_id: string;
  contest_id: string;
  user_id: string;
  language: string;
  result: string;
}

/**
 * AtCoder 适配器：使用社区维护的 kenkoooo/AtCoderProblems 公开 API（v3）。
 * - 用户提交：/atcoder-api/v3/user/submissions?user=xxx&from_second=ts
 *   （指定时间点后最多 500 条；满页续拉即增量同步；官方要求页间 sleep >= 1s）
 * - 题目标题：/resources/problems.json（24h 磁盘缓存）
 * - 题目难度：/resources/problem-models.json（24h 磁盘缓存）
 */
export function createAtcoderAdapter(
  cacheDir?: string,
  fetchFn: HttpInit = fetch,
): PlatformAdapter {
  const http = asHttpClient(fetchFn);
  let problems: Map<string, { title?: string }> | null = null;
  let models: Map<string, { difficulty?: number | null }> | null = null;

  async function cachedJson(
    url: string,
    cacheKey: string,
  ): Promise<unknown> {
    const cachePath = cacheDir ? path.join(cacheDir, `${cacheKey}.json`) : '';
    if (cachePath && fs.existsSync(cachePath)) {
      try {
        const age = Date.now() - fs.statSync(cachePath).mtimeMs;
        if (age < RESOURCES_TTL_MS) {
          return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        }
      } catch {
        // 缓存损坏（进程写入中途被杀留下的半截 JSON）或 stat 竞态（文件刚被删）：
        // 视为未命中重拉——没有这个兜底，一次损坏会让同步在整整一个 TTL（24h）内每次都炸
      }
    }
    const res = await http.fetch(url, {}, { timeoutMs: 20000 });
    if (!res.ok) {
      throw new Error(`AtCoder resources HTTP ${res.status}`);
    }
    const data: unknown = await res.json();
    if (cachePath) {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      // 先写临时文件再 rename：写入中途被杀不会留下半截 JSON 占着 TTL 位置
      const tmpPath = `${cachePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data));
      fs.renameSync(tmpPath, cachePath);
    }
    return data;
  }

  async function ensureMaps(): Promise<void> {
    if (problems && models) return;
    const [probData, modelData] = await Promise.all([
      cachedJson(`${API}/resources/problems.json`, 'atcoder-problems'),
      cachedJson(`${API}/resources/problem-models.json`, 'atcoder-problem-models'),
    ]);
    problems = new Map(
      (probData as { id: string; title?: string }[]).map((p) => [p.id, p]),
    );
    models = new Map(
      Object.entries(modelData as Record<string, { difficulty?: number | null }>),
    );
  }

  return {
    platform: 'atcoder',

    async fetchUserSubmissions(
      handle: string,
      opts?: FetchOptions,
    ): Promise<NormalizedSubmission[]> {
      const since = opts?.since
        ? Math.floor(Date.parse(opts.since) / 1000)
        : 0;
      const maxSubmissions = opts?.maxSubmissions;
      /**
       * 页数预算＝本次同步最多向上游发几次请求（页间 1s sleep ≈ 最多 30 分钟）。
       *
       * 与单次上限（maxSubmissions）解耦：上游是窗口式接口，游标只能按「秒」推进，
       * 一次请求最多 500 行；单次上限只管「返回给同步层多少行」。旧实现按上限折算预算
       * （`ceil(max/500)×2`），上限 300 时只有 3 次请求 —— 越过一段近期历史就可能用光，
       * 扫描被腰斩、更晚的提交永远拉不到，表现为「点了同步，但最新提交一直不进来」。
       */
      const budget = Math.min(
        PER_SYNC_MAX_PAGES,
        Math.max(
          4,
          Math.ceil(((maxSubmissions ?? 0) + SUBMISSION_PAGE) / SUBMISSION_PAGE) * 3,
        ),
      );

      /**
       * 上游 `/user/submissions` 的真实语义（实测确认）：
       * 返回**至多 500 行**的一个窗口 —— 从「第一条 epoch_second >= from_second 的提交」
       * 开始、按 **id 升序**连续截取 500 行。`from_second` 是「从哪一秒开始」的下界，
       * **没有按行数偏移的能力**（同一 from_second 的重复请求返回同一个窗口）。
       *
       * 游标按「本窗末行的秒 + 1」推进（旧实现也是这个思路，方向没错）：窗口是连续 500 行，
       * 末行之后的提交都在更晚的秒上，因此这是唯一能持续前进的推法。
       * 已知边界：若某一秒的提交数本身 ≥ 一整个窗口（>500，需连续刷题脚本才可能出现），
       * 上游对该秒只会反复给出同一窗、无法取回该秒排不进窗口的行。这种极端形态无法在
       * 适配器层解决；同步层的**回看窗口**（见 sync.ts 的 ASCENDING_SYNC_LOOKBACK_MS）
       * 保证它不会连带把更晚的提交一起挡掉。
       */
      const seen = new Set<string>();
      const raws: KenkoooSubmission[] = [];
      let pageFrom = since;
      let naturalEnd = false; // 已到最新一条（空页 / 短页）
      let rowCapped = false; // 触及单次上限

      for (let page = 0; page < budget; page += 1) {
        // 官方要求页间访问间隔 >= 1s：只在「真的还要再发一次请求」前等待
        if (page > 0) await sleep(PAGE_DELAY_MS);
        const url = `${API}/atcoder-api/v3/user/submissions?user=${encodeURIComponent(handle)}&from_second=${pageFrom}`;
        const res = await http.fetch(url, {}, { timeoutMs: 20000 });
        if (!res.ok) {
          throw new Error(`AtCoder API HTTP ${res.status}`);
        }
        const data: unknown = await res.json();
        if (!Array.isArray(data)) {
          const msg = (data as { message?: string }).message ?? 'unknown error';
          throw new Error(`AtCoder API: ${msg}`);
        }
        const rows = data as KenkoooSubmission[];
        if (rows.length === 0) {
          naturalEnd = true;
          break;
        }

        for (const s of rows) {
          if (seen.has(String(s.id))) continue;
          if (maxSubmissions && raws.length >= maxSubmissions) {
            rowCapped = true;
            break;
          }
          seen.add(String(s.id));
          raws.push(s);
        }
        if (rowCapped) break;
        // 短页（含空页）= 上游已给到最新一条：整段历史收工
        if (rows.length < SUBMISSION_PAGE) {
          naturalEnd = true;
          break;
        }
        pageFrom = Math.max(rows[rows.length - 1]!.epoch_second + 1, pageFrom + 1);
      }

      if (raws.length === 0) {
        // 预算耗尽却一无所获（异常上游行为）：不能谎报「已同步到最新」——
        // 必须让同步层把 last_sync_at 留在原处，否则这段时间的提交会被永久跳过。
        if (!naturalEnd && opts) opts.truncated = true;
        return [];
      }

      /**
       * 按提交时间（同秒再按 id）升序输出：AtCoder 的续拉语义要求升序（见 sync.ts 的 isAscendingPlatform）。
       *
       * 被单次上限砍掉时，把「砍点那一秒」的行**全部收下**（允许略微超过上限几十条）：
       * 同步层把续拉光标设为**本批最新一条提交的时刻**，光标因此正好停在砍点那一秒，
       * 下一轮从该秒重拉会补齐它、并靠唯一键去重。切忌只收该秒的前半段就把光标推过去 ——
       * 那会把「上限正好落在某个秒中间」变成永久丢数据。
       */
      let out: KenkoooSubmission[] = raws;
      if (rowCapped && raws.length > (maxSubmissions ?? 0)) {
        const head = raws.slice(0, maxSubmissions);
        const boundarySecond = head[head.length - 1]!.epoch_second;
        out = raws.filter((s) => s.epoch_second <= boundarySecond);
      }
      out.sort((a, b) => a.epoch_second - b.epoch_second || a.id - b.id);
      const truncated = rowCapped || !naturalEnd;
      if (truncated && opts) opts.truncated = true;

      await ensureMaps();
      return out.map((s) =>
        normalize(s, problems ?? new Map(), models ?? new Map()),
      );
    },

    problemUrl({ problemKey }) {
      return `https://atcoder.jp/tasks/${String(problemKey)}`;
    },
  };
}

function normalize(
  s: KenkoooSubmission,
  problems: Map<string, { title?: string }>,
  models: Map<string, { difficulty?: number | null }>,
): NormalizedSubmission {
  const title = problems.get(s.problem_id)?.title ?? s.problem_id;
  const rawDifficulty = models.get(s.problem_id)?.difficulty;
  // kenkoooo 难度模型对极简题（abc A 题）会给出负值（如 -1152）。
  // 钳位与分段映射统一由 shared/src/difficulty.ts 负责（ATCODER_ANCHORS）：
  // 此处只透传 θ 原文，nativeDifficulty 也保留原文，便于平台改档后按标度重算。
  return {
    problem: {
      platform: 'atcoder' as PlatformId,
      problemKey: s.problem_id,
      title,
      ...difficultyFields('atcoder', rawDifficulty ?? null),
      url: `https://atcoder.jp/contests/${s.contest_id}/tasks/${s.problem_id}`,
      tags: [],
    },
    verdict: RESULT_MAP[s.result] ?? 'SKIPPED',
    language: s.language,
    submittedAt: new Date(s.epoch_second * 1000).toISOString(),
    externalId: String(s.id),
  };
}
