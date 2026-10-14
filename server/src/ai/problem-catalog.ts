import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { effectiveAbility } from '../today/ability.ts';
import { problemStatuses, searchProblems, type ProblemIdentity } from '../problems/trainingCatalog.ts';
import { registerTool } from './tools/registry.ts';

export function renderProblemCandidates(db: Db, userId: number, level: number, weakTags: string[]): string {
  const result = searchProblems(db, userId, { difficultyMin: Math.max(0, level - 400), difficultyMax: level + 600, limit: 60 }, { level, weakTags });
  return `## 未 AC 候选题（本地题库，完整同步历史过滤）\n` +
    `当前训练区间匹配 ${result.total} 题，以下展示 ${result.problems.length} 题（优先弱项与生效能力值附近）。这只是候选样本，可用 search_problems 按标签、平台、难度或 offset 继续检索全库；不是题库上限。\n` +
    `未 AC 仅代表同步记录未通过，未同步的数据无法确认；候选不足请扩大筛选条件或提示同步/拉取题库，禁止拿已 AC 题填充新题任务。\n` +
    JSON.stringify(result.problems);
}

registerTool({
  definition: { type: 'function', function: {
    name: 'search_problems',
    description: '检索完整本地题库并分页返回真实题号、标题、难度、标签、链接和 AC 状态。默认排除用户全部历史已 AC 题（含洛谷 CF/AtCoder 镜像），推荐/替换训练计划和题单的新题时优先调用。返回 total 与 nextOffset；数量不足可换筛选条件或翻页，不要靠记忆编题。无需联网密钥。',
    parameters: { type: 'object', properties: {
      platform: { type: 'string', description: '平台 id，可省略' },
      tag: { type: 'string', description: '知识点标签，支持中英文别名，如二分、DP' },
      difficultyMin: { type: 'number', description: 'CF 标尺难度下界（包含）' },
      difficultyMax: { type: 'number', description: 'CF 标尺难度上界（包含）' },
      query: { type: 'string', description: '题号或标题关键词' },
      status: { type: 'string', enum: ['unsolved', 'ac', 'all'], description: '默认 unsolved；复习选题用 ac；核验用 all' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: '每页数量，默认 50，最多 100' },
      offset: { type: 'integer', minimum: 0, description: '分页偏移，默认 0；继续检索传 nextOffset' },
    } },
  } },
  execute: async (args, ctx) => {
    if (!ctx.db) return { content: '本地题库不可用，不能确认题目与 AC 状态' };
    const userId = ctx.userId ?? DEFAULT_USER_ID;
    return { content: JSON.stringify(searchProblems(ctx.db, userId, args, { level: effectiveAbility(ctx.db, userId).effective })) };
  },
});

registerTool({
  definition: { type: 'function', function: {
    name: 'check_problem_status',
    description: '批量核验题目在用户完整同步历史中是否已 AC（含镜像），用于网页找到的题或用户指定题的排重。未收录不等于确认未做；单次最多 100 题。',
    parameters: { type: 'object', properties: { problems: { type: 'array', minItems: 1, maxItems: 100, items: {
      type: 'object', properties: { platform: { type: 'string' }, problemKey: { type: 'string' } }, required: ['platform', 'problemKey'],
    } } }, required: ['problems'] },
  } },
  execute: async (args, ctx) => {
    if (!ctx.db) return { content: '本地题库不可用，不能确认 AC 状态' };
    if (!Array.isArray(args.problems) || !args.problems.length || args.problems.length > 100 ||
      args.problems.some(p => !p || typeof p.platform !== 'string' || !p.platform.trim() || typeof p.problemKey !== 'string' || !p.problemKey.trim())) {
      throw new Error('problems 需为 1-100 个 { platform, problemKey }');
    }
    const problems = args.problems as ProblemIdentity[];
    const statuses = problemStatuses(ctx.db, ctx.userId ?? DEFAULT_USER_ID, problems);
    return { content: JSON.stringify({ problems: problems.map((p, i) => ({ ...p, status: statuses[i] })) }) };
  },
});
