import type { PlatformId } from '../../../shared/src/index.ts';

/**
 * 提交详情页地址（issue #69）。
 *
 * 为什么放在适配器层而不是导入层：只有适配器知道自己平台的 externalId 到底「是什么号」
 * （CF 全局提交号 / 洛谷记录号 / VJudge runId …）以及提交页的路由形态。
 * 导入层只拿到一个字符串，猜不出该往哪个模板里填。
 *
 * 设计约束（issue 原文「同步期间不访问提交详情页，不拉取源码」）：
 * - 这里**只做字符串拼装**，绝不发请求；算不出来就返回 null（前端不渲染链接）。
 *   死链比没有链接更糟：用户点开发现 404，会以为整个软件坏了。
 * - 因此拿不到路由依据的平台宁可不给：计蒜客（hashId 与 SPA 路由无对应关系）、
 *   牛客在线编程段（跨前端域名，只有 questionUuid）、PTA（路由未实测）都不生成链接。
 *
 * 两类平台分开处理：
 * - **只需提交号**就能拼路由的（洛谷 / QOJ / VJudge / DashOJ / 代码源 / 牛客竞赛）走
 *   SUBMISSION_URL_BUILDERS，由导入层统一调用 submissionUrlOf；
 * - **还需要 contestId** 的（Codeforces / AtCoder）由适配器在同步时用下面的专用函数算好、
 *   写进 NormalizedSubmission.submissionUrl —— contextId 本来就在它手里。
 */
const CF_GYM_ID_MIN = 100_000;

/** Codeforces 提交详情（需要 contestId；gym 与正式赛路由不同，阈值与 problemUrlFor 同源） */
export function codeforcesSubmissionUrl(contestId: number | string, submissionId: number | string): string | null {
  const cid = Number(contestId);
  const sid = Number(submissionId);
  if (!Number.isSafeInteger(cid) || cid <= 0 || !Number.isSafeInteger(sid) || sid <= 0) return null;
  const base = cid >= CF_GYM_ID_MIN ? `https://codeforces.com/gym/${cid}` : `https://codeforces.com/contest/${cid}`;
  return `${base}/submission/${sid}`;
}

/** AtCoder 提交详情（需要 contestId；该页对未登录用户会跳登录页） */
export function atcoderSubmissionUrl(contestId: string, submissionId: number | string): string | null {
  const cid = String(contestId ?? '').trim();
  const sid = Number(submissionId);
  if (!cid || !/^[\w-]+$/.test(cid) || !Number.isSafeInteger(sid) || sid <= 0) return null;
  return `https://atcoder.jp/contests/${cid}/submissions/${sid}`;
}

/** 牛客竞赛提交详情（练习页/竞赛页都从 submissionId 走同一个 query 路由） */
export function nowcoderSubmissionUrl(submissionId: number | string): string | null {
  const sid = String(submissionId ?? '').trim();
  return /^\d+$/.test(sid) ? `https://ac.nowcoder.com/acm/contest/view-submission?submissionId=${sid}` : null;
}

/**
 * 平台 → 提交详情页（只需提交号的那些）。集中一份：新增平台只加一行 URL 前缀，
 * 不在各处散着写。
 */
const SUBMISSION_URL_BUILDERS: Partial<Record<PlatformId, (externalId: string) => string | null>> = {
  luogu: (id) => (/^\d+$/.test(id) ? `https://www.luogu.com.cn/record/${id}` : null),
  qoj: (id) => (/^\d+$/.test(id) ? `https://qoj.ac/submission/${id}` : null),
  vjudge: (id) => (/^\d+$/.test(id) ? `https://vjudge.net/solution/${id}` : null),
  dashoj: (id) => (/^[0-9a-f]{24}$/i.test(id) ? `https://dashoj.com/record/${id}` : null),
  daimayuan: (id) => (/^[0-9a-f]{24}$/i.test(id) ? `https://bs.daimayuan.top/record/${id}` : null),
  nowcoder: (id) => (id.startsWith('community:') ? null : nowcoderSubmissionUrl(id)),
};

/**
 * 按平台与提交号推导详情页地址。
 * CF / AtCoder 不在这张表里（缺 contestId），由适配器直接调用上面的专用函数。
 * 平台不在表里、或提交号形态不符（如 nowcoder 的 community: 段）→ null。
 */
export function submissionUrlOf(platform: PlatformId, externalId: string): string | null {
  const build = SUBMISSION_URL_BUILDERS[platform];
  if (!build) return null;
  return build(String(externalId ?? '').trim());
}

/**
 * 适配器页面上的现成 href → 绝对地址（有的平台提交链接本来就在 HTML 里，只是以前解析时被丢弃）。
 * 只接受 http(s) 绝对地址或站内相对路径；其它形态（空串、javascript:）一律 null。
 */
export function absolutizeSubmissionUrl(base: string, href: string | null | undefined): string | null {
  if (typeof href !== 'string') return null;
  const value = href.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (!value.startsWith('/')) return null;
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

/**
 * 一次提交最终落库的详情页地址：
 * 适配器自己算的（最准：知道 contestId、也知道是不是转发站）优先，否则回落到平台级模板。
 * externalId 为 manual: 前缀（手动导入）时没有真实提交号，不生成链接。
 */
export function resolveSubmissionUrl(platform: PlatformId, externalId: string, own?: string | null): string | null {
  const key = String(externalId ?? '');
  if (key === '' || key.startsWith('manual:')) return null;
  const trimmed = typeof own === 'string' ? own.trim() : '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return submissionUrlOf(platform, key);
}
