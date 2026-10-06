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
import { fetchOwnContestSubmissions, isAtcoderLoginPage, type KenkoooSubmission } from './atcoderDirect.ts';
import { atcoderContestPrefix } from './problemKey.ts';

const API = 'https://kenkoooo.com/atcoder';
const SITE = 'https://atcoder.jp';
const RESOURCES_TTL_MS = 24 * 3600 * 1000;
/** 上游单次响应最多返回这么多行（窗口大小），实测确认：请求 `/user/submissions` 恒定最多 500 行 */
const SUBMISSION_PAGE = 500;
// 每次同步的保守页数上限（×1s sleep × 500/页：每次同步最多约 30 分钟），把全量分页拆成多次防封号
const PER_SYNC_MAX_PAGES = 60;
const PAGE_DELAY_MS = 1000; // 官方要求访问间隔 >= 1s
/** 直连补充扫描单次最多覆盖的比赛数（每场 1 次请求起；补题只发生在提交过的比赛里，取最近即可） */
const DIRECT_SCAN_MAX_CONTESTS = 8;

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
    // 同步层据此注入 knownExternalIds：升序平台回看窗口重扫的已入库行据此跳过、
    // 不占单次上限预算（见 fetchUserSubmissions 行循环）；不做「整页已知提前终止」
    knownIdsFilter: true,

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
       * 游标按「本窗末行的秒 + 1」推进：窗口是连续 500 行，但末行之后**可能仍有同秒行**——
       * 因此触及单次上限砍批时，必须把「砍点那一秒」的行**整秒收下**（见下方行循环）；
       * 页边界（窗口恰好切在同一秒中间）则靠「退回该秒重拉一次」补齐（见页尾推进逻辑）。
       * 唯一无法在适配器层解决的形态：**某一秒自身的提交数 ≥ 一整个窗口（≥500 行）**时，
       * 上游对同一 from_second 只会反复给出同一窗，该秒排不进窗口的行取不回来（此时如实置
       * truncated）。这种形态需要连续刷题脚本才可能出现；同步层的**回看窗口**
       * （见 sync.ts 的 ASCENDING_SYNC_LOOKBACK_MS）保证它不会连带把更晚的提交一起挡掉。
       */
      const seen = new Set<string>();
      // 同步层注入的「库中已有提交号」（knownIdsFilter 声明后由 sync.ts 注入）：
      // 回看窗口重扫到的已入库行据此跳过，且**不占单次上限预算**——旧行若计入预算，
      // 回看窗口内提交较多时（比赛周末 ≥300 条/12h）预算被吃满，砍批后游标停在原处
      // 甚至倒退，新提交永远同步不进来（2026-10 排查到的「增量同步又拉不到最新提交」）。
      // 注意不做「整页已知即提前终止」：升序扫描必须走到头才能发现新行。
      // 例外（改判/改题号必须重发）见下方 isResend。
      const known = opts?.knownExternalIds;
      const knownVerdicts = opts?.knownVerdicts;
      const knownProblemKeys = opts?.knownProblemKeys;
      /**
       * 已入库行是否需要**重发**（镜像行与直连行共用同一判定，见 types.ts 的 FetchOptions 契约）：
       * 平台侧**改判**（WJ/WR → 终态）或改题号的行必须重发，否则 importService 的 refreshVerdict
       * 无法刷新库里冻结的旧判定——「评测中」入库的行会永久停在 SKIPPED 且无自愈路径。
       * 改判行数量极少，照常计入上限预算：判定没被刷新前它每轮都满足重发条件，不会被静默丢掉。
       */
      const isResend = (s: KenkoooSubmission): boolean => {
        if (!known?.has(String(s.id))) return false;
        const storedVerdict = knownVerdicts?.get(String(s.id));
        const verdictChanged =
          storedVerdict !== undefined && storedVerdict !== (RESULT_MAP[s.result] ?? 'SKIPPED');
        const storedKey = knownProblemKeys?.get(String(s.id));
        const keyChanged = storedKey !== undefined && storedKey !== s.problem_id;
        return verdictChanged || keyChanged;
      };
      const raws: KenkoooSubmission[] = [];
      let pageFrom = since;
      let naturalEnd = false; // 已到最新一条（空页 / 短页）
      let rowCapped = false; // 触及单次上限
      let lastScannedSecond: number | undefined; // 本批已扫描到的最后一行时刻（秒）
      let retriedSecond: number | undefined; // 已按「页边界同秒」退回重拉过的秒

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
        lastScannedSecond = rows[rows.length - 1]!.epoch_second;

        for (const s of rows) {
          const id = String(s.id);
          if (seen.has(id)) continue;
          if (known?.has(id) && !isResend(s)) continue;
          if (maxSubmissions && raws.length >= maxSubmissions) {
            // 上限落在某一秒中间：该秒剩下的行继续收下（略微超过上限也在所不惜）再砍——
            // 游标按「本窗末行秒 + 1」推进，只收半秒就会把同秒后半段永久跳过
            if (s.epoch_second > raws[raws.length - 1]!.epoch_second) {
              rowCapped = true;
              break;
            }
          }
          seen.add(id);
          raws.push(s);
        }
        if (rowCapped) break;
        // 短页（含空页）= 上游已给到最新一条：整段历史收工
        if (rows.length < SUBMISSION_PAGE) {
          naturalEnd = true;
          break;
        }
        /**
         * 页边界推进：上游无「按行偏移」能力，游标只能按秒前进（末行秒 + 1）。若末行所在的
         * **同一秒**还有行排在窗口外（该秒被 500 行窗口切开），直接 +1 续拉会把它们永久跳过，
         * 且 truncated 不置位（同步中心仍显示成功）。先退回该秒重拉一次：窗口会从该秒的**首行**
         * 开始，之前落在窗外的同秒行这次就在窗内（重复行由 seen 去重，已入库行由 known 跳过）。
         */
        const lastRow = rows[rows.length - 1]!;
        if (rows[rows.length - 2]?.epoch_second === lastRow.epoch_second) {
          if (retriedSecond !== lastRow.epoch_second) {
            retriedSecond = lastRow.epoch_second;
            pageFrom = lastRow.epoch_second;
            continue;
          }
          // 该秒自身就有 ≥500 行：同一 from_second 只会反复给出同一窗，剩余行取不回来。
          // 适配器层无法解决，但必须如实上报截断（不能让同步层谎报「已同步到最新」）
          if (opts) opts.truncated = true;
        }
        pageFrom = Math.max(lastRow.epoch_second + 1, pageFrom + 1);
      }

      /**
       * 直连补充扫描（可选，仅当账号配置了 Cookie）：AtCoder 已把提交列表页全部加上登录墙，
       * kenkoooo 对赛后补题/练习提交的收录延迟不可控（实测 abc478 补题 3 天未收录，而其爬虫
       * 对其他比赛的轮转是分钟级），镜像「没收录」期间提交就一直进不来。库里有登录态时直接抓
       * own-submissions 页补齐增量；提交号与镜像同源（AtCoder 全局提交号），按 id 合并无缝衔接。
       *
       * 候选比赛 = 本轮镜像扫到的比赛 ∪ 库中已提交的比赛（补题只会发生在提交过的比赛里；
       * 库行按导入先后入表，倒序取前缀即「最近活跃」的比赛）。命中不了的形态：练习赛
       * （practice/ADT）里从无库记录的比赛——这类新比赛的发现仍靠镜像（比赛当天通常即收录）。
       *
       * 刻意**不占用/不触发** maxSubmissions 与 truncated 语义：直连的请求次数由
       * 「比赛数 × 封顶页数」约束（与新增行数无关），风控面在请求侧而非行侧。
       * 失败只降级不失败：镜像仍是主通道，异常原因经 directScanNote 回传同步中心展示。
       */
      if (opts?.cookie) {
        let directAdded = 0;
        const directContests: string[] = [];
        const pushContest = (c: string | null): void => {
          if (c && !directContests.includes(c)) directContests.push(c);
        };
        for (const r of raws) pushContest(r.contest_id);
        const knownKeys = opts.knownProblemKeys ? [...opts.knownProblemKeys.values()].reverse() : [];
        for (const key of knownKeys) pushContest(atcoderContestPrefix(key));
        try {
          const direct = await fetchOwnContestSubmissions({
            http,
            cookie: opts.cookie,
            handle,
            ...(opts.ua ? { ua: opts.ua } : {}),
            contests: directContests.slice(0, DIRECT_SCAN_MAX_CONTESTS),
            knownIds: known,
            ...(opts.pageDelayMs !== undefined ? { pageDelayMs: opts.pageDelayMs } : {}),
          });
          if (direct.droppedOtherUser > 0) {
            opts.directScanNote =
              `直连扫描丢弃了 ${direct.droppedOtherUser} 条归属不符的提交：Cookie 的登录账号与该账号（${handle}）不一致，请检查设置里的 Cookie 是否贴对了账号`;
          }
          for (const s of direct.rows) {
            const id = String(s.id);
            if (seen.has(id) || (known?.has(id) && !isResend(s))) continue;
            seen.add(id);
            raws.push(s);
            directAdded += 1;
          }
          if (directAdded > 0) opts.directScanAdded = directAdded;
        } catch (e) {
          opts.directScanNote = (e as Error).message;
        }
      }

      if (raws.length === 0) {
        // 预算耗尽却一无所获（异常上游行为）：不能谎报「已同步到最新」——
        // 必须让同步层把 last_sync_at 留在原处，否则这段时间的提交会被永久跳过。
        // 同时回报「已扫到的位置」：增量模式下扫描区间内可能**全是已入库行**（回看窗口的
        // 常规形态），此时同步层若把 last_sync_at 推到当前时刻，(扫描点, now) 之间还没扫到的
        // 提交就会被下一次的 12h 回看窗口漏掉 —— 停在扫描点则下轮从扫描点前 12h 重扫，不会丢。
        if (!naturalEnd && opts) {
          opts.truncated = true;
          if (lastScannedSecond !== undefined) {
            opts.scannedUntil = new Date(lastScannedSecond * 1000).toISOString();
          }
        }
        return [];
      }

      /**
       * 按提交时间（同秒再按 id）升序输出：AtCoder 的续拉语义要求升序（见 sync.ts 的 isAscendingPlatform）。
       *
       * 「砍点那一秒整秒收下」已在行循环内完成（触及上限时同秒行继续收下，允许略超上限）：
       * 同步层把续拉光标设为**本批最新一条提交的时刻**，光标因此正好停在砍点那一秒，
       * 下一轮从该秒重拉会补齐缺口——重拉行由 knownExternalIds 跳过（不占上限预算），
       * 唯一键去重兜底。切忌只收该秒的前半段就把光标推过去——
       * 那会把「上限正好落在某个秒中间」变成永久丢数据。
       */
      raws.sort((a, b) => a.epoch_second - b.epoch_second || a.id - b.id);
      const truncated = rowCapped || !naturalEnd;
      if (truncated && opts) opts.truncated = true;

      await ensureMaps();
      return raws.map((s) =>
        normalize(s, problems ?? new Map(), models ?? new Map()),
      );
    },

    problemUrl({ problemKey }) {
      return `https://atcoder.jp/tasks/${String(problemKey)}`;
    },

    /**
     * 校验登录态（直连补充同步用）：访问需登录的设置页，落在登录页即 Cookie 失效。
     * 普通同步不依赖 Cookie（镜像路径），故失效只提示、不影响主通道。
     */
    async checkAuth({ cookie, ua }) {
      const res = await http.fetch(
        `${SITE}/settings`,
        {
          headers: {
            ...(cookie ? { cookie } : {}),
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            ...(ua ? { 'user-agent': ua } : {}),
          },
        },
        { timeoutMs: 20000 },
      );
      const html = res.ok ? await res.text() : '';
      if (isAtcoderLoginPage(res, html)) {
        return { ok: false, message: 'Cookie 已失效（访问登录页受限内容被重定向），请重新粘贴' };
      }
      if (!res.ok) {
        return { ok: false, message: `AtCoder HTTP ${res.status}` };
      }
      return { ok: true, message: '登录态有效：直连补充同步可用' };
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
