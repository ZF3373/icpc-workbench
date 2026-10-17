# 赛时题分析 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an isolated analysis view for contest-time problems, separate post-contest upsolves, support per-contest user tags, and classify participated contests by rating changes.

**Architecture:** Reuse the existing participated-contest resolver and submission store as read-only input. Add a separate user-scoped contest tag table and analysis API, then expose the result in a dedicated page; expose Rated, non-rated, and pending classification in the participated-contest view.

**Tech Stack:** TypeScript, React, Ant Design, Express, SQLite (`node:sqlite`), shared TypeScript DTOs.

**Spec:** `docs/superpowers/specs/2026-10-17-contest-time-analysis-design.md`

## Global Constraints

- 赛时分析纳入官方比赛、虚拟赛和自我模拟比赛。
- 首版只纳入能可靠匹配到平台比赛和比赛窗口的提交。无法可靠匹配的提交不猜测归属、不纳入赛时统计。
- 按比赛窗口计算赛时状态。比赛期间至少提交过且窗口结束前没有通过的题目为“赛时未通过”。若该题在比赛结束后通过，显示为“赛后通过”，但赛时未通过状态不被覆盖。
- 赛时手动标签按用户、比赛、平台和题目编号隔离保存，仅用于赛时分析，不修改 `problems.tags`、知识点标注或现有日常分析。
- 比赛分类遵循平台提供的 Rating 变化记录：有比赛级 Rating 变化记录为 **Rated 正式参赛**；平台已确认比赛结束且无 Rating 变化为 **非正式参赛**；缺少或未同步到充分证据时为 **待确认**，不得把数据缺失解释为没有变化。

## File Map

- `shared/src/index.ts` — shared rating-status and contest-analysis API types.
- `server/src/db/schema.sql` — isolated per-user contest tag storage.
- `server/src/contests/participated.ts` — expose a one-pass review-group resolver for aggregate analysis.
- `server/src/contests/contestAnalysis.ts` — read-only contest attribution projection and rating-status derivation.
- `server/src/routes/contests.ts` — analysis read endpoint and validated tag write/delete endpoints.
- The client page lives at `client/src/pages/ContestAnalysis.tsx` with `client/src/pages/ContestAnalysis.css`.
- `client/src/App.tsx` — route registration.
- `client/src/menuConfig.tsx` — “赛时分析” entry in the existing “赛事” group.
- `client/src/pages/Contests.tsx` and `client/src/pages/contestsView.ts` — show and filter the rating status in participated contests.

## Implementation Tasks

### Task 1: Define analysis DTOs and isolated tag storage

**Files:**
- Modify: `shared/src/index.ts`
- Modify: `server/src/db/schema.sql`

**Interfaces:**
- Produce `ContestRatingStatus = 'rated' | 'unrated' | 'pending'`.
- Produce `ContestAnalysisProblem` with `platform`, `problemKey`, `title`, `url`, `contestKey`, `attemptCount`, `postContestAttemptCount`, `contestAccepted`, `postContestAccepted`, and `tags`.
- Produce `ContestAnalysisContest` with `contest: ParticipatedContest`, `ratingStatus`, and `problems: ContestAnalysisProblem[]`.
- Produce `ContestAnalysisResponse` with `contests: ContestAnalysisContest[]`.
- Store one row per `(user_id, contest_key, platform, problem_key, tag)` in `contest_analysis_tags`; reference `users(id)` and add an index beginning with `user_id, contest_key`.

- [x] Add the three analysis interfaces and the status union next to the existing `ParticipatedContest` shared type.
- [x] Add `contest_analysis_tags` with a composite primary key, a foreign key to `users(id) ON DELETE CASCADE`, and a lookup index. Do not add triggers or writes to `problems` or `problem_keypoints`.
- [x] Confirm that the table is created for existing databases through the existing `createDb` schema execution path; no column migration is required because this is a new table.

### Task 2: Derive contest-time problem states without changing submission data

**Files:**
- Create: `server/src/contests/contestAnalysis.ts`
- Modify: `server/src/contests/participated.ts`
- Modify: `shared/src/index.ts` only if the result type needs a field clarified while implementing the agreed spec.

**Interfaces:**
- Export `deriveContestAnalysis(db: Db, contests: ParticipatedContest[], opts?: { calendar?: ContestInfo[]; sources?: ParticipationSources['byPlatform'] }): ContestAnalysisContest[]`.
- Export `contestRatingStatus(contest: ParticipatedContest): ContestRatingStatus`.
- Export `resolveAllContestGroups(db, opts)` from `server/src/contests/participated.ts` and pass through the same calendar and participation-source snapshot used to derive the contest list. Existing single-contest resolution remains unchanged.

- [x] Build the review-group index once for the aggregate page through `resolveAllContestGroups`; retain only reliable evidence: platform `contest`/`virtual` context, `joined-list`, `key-pattern`, or a confirmed calendar-window match. Exclude `heuristic` and `gym` evidence. Codeforces explicit `contest`/`virtual` context remains reliable even when the official event window is unavailable.
- [x] Build the problem set from confirmed contest problems plus the group's submitted problems. Normalize identities as `(platform, problemKey)` and never join records by problem key alone.
- [x] For each problem, count contest-mode attempts and Accepted results separately from practice/upsolve attempts and later Accepted results. Codeforces uses its explicit `contest`/`virtual` versus `practice` context; other platforms use the exact event window. Never let a later Accepted change `contestAccepted`.
- [x] Classify a contest as `rated` when a platform supplies any numeric `ratingChange` record, including zero; classify an explicitly identified Codeforces virtual contest as `unrated`; use `pending` when no rating change or explicit non-rated evidence is available.
- [x] Load tags for the default user from `contest_analysis_tags` and attach them to each problem. This service only reads submissions and problem metadata.

### Task 3: Expose analysis and isolated tag endpoints

**Files:**
- Modify: `server/src/routes/contests.ts`
- Modify: `server/src/db/schema.sql` only if Task 1 schema review requires a constraint adjustment.

**Interfaces:**
- Add `GET /api/contests/analysis`, returning `ContestAnalysisResponse`.
- Add `PUT /api/contests/analysis/tags` with JSON `{ contestKey: string; platform: PlatformId; problemKey: string; tag: string }` and an idempotent upsert.
- Add `DELETE /api/contests/analysis/tags` with the same JSON identity and an idempotent delete.

- [x] Reuse `calendarCache`, `readParticipationSnapshot`, and `deriveParticipatedContests` as the read path already does; do not start a second participation sync or add external API calls to the analysis request.
- [x] Validate contest key, known platform, non-empty trimmed tag, and bounded tag length before writing. Return `400` for invalid input and `404` if a tag is added for a problem outside a reliably attributable analysis result.
- [x] Scope every tag query and mutation to `DEFAULT_USER_ID`; use the composite identity from Task 1 for upsert and delete.
- [x] Return the latest tags after each write so the client can update one problem row without refreshing the entire page.

### Task 4: Surface Rated classification in participated contests

**Files:**
- Modify: `client/src/pages/Contests.tsx`
- Modify: `client/src/pages/contestsView.ts`
- Modify: `shared/src/index.ts` if `ParticipatedContest` needs the derived `ratingStatus` field.

**Interfaces:**
- Reuse `ContestRatingStatus` for badges, filters, and URL-backed view state.
- Add a `ratingStatus` filter value of `'all' | ContestRatingStatus` to the participated-contest view state.

- [x] Add one badge to each participated contest card for Rated 正式参赛, 非正式参赛, or 待确认, based on the shared server-derived status.
- [x] Add a rating-status filter to the participated view and preserve it in `contestsView` query parameters alongside existing filters.
- [x] Keep `evidence` and official/virtual participation context visible and independent from the rating badge; do not label all virtual contests as rated.

### Task 5: Add the dedicated contest analysis page

**Files:**
- Create: `client/src/pages/ContestAnalysis.tsx`
- Create: `client/src/pages/ContestAnalysis.css`
- Modify: `client/src/App.tsx`
- Modify: `client/src/menuConfig.tsx`

**Interfaces:**
- The page consumes `GET /api/contests/analysis` and the tag endpoints from Task 3.
- Register route `/contest-analysis` and menu label `赛时分析` under `MENU_GROUPS.contest`.

- [x] Render platform, contest, rating status, and contest-time problem rows from `ContestAnalysisResponse`; provide platform, contest, and rating-status filters.
- [x] Show separate counts for contest accepted, contest attempted without acceptance, post-contest upsolve attempts, and contest attempted without acceptance but accepted after contest.
- [x] Show platform ID, title/link, contest attribution, attempt count, in-contest outcome, post-contest outcome, and user tags on each row.
- [x] Allow adding and removing multiple tags inline. Trim input, reject empty values, handle API errors, and update tags from the write response.
- [x] Show a count of untagged contest-stuck problems; only user-entered contest tags contribute to tag aggregation. Do not read global `problems.tags` as a fallback.
- [x] Follow existing page loading, error, and empty-state patterns. Add compact responsive styles in `ContestAnalysis.css` and import them from the page.

## Constraint Notes

- Do not add or run automated tests unless the user explicitly asks for tests or verification.
- Do not modify the existing global weakness calculation, `problems.tags`, `problem_keypoints`, or daily practice scoring.
- Do not include unsupported or heuristic-only contest matches in this first version.
- Do not infer “unrated” from a missing source, missing `ratingChange`, or failed synchronization.

## Completion Checklist

- [x] Database startup creates the new tag table without altering existing global-tag data.
- [x] Analysis only includes reliable contest matches and uses platform context or an exact event window for contest outcomes.
- [x] Contest-time Accepted and post-contest Accepted remain independent.
- [x] Per-contest tags can be added and removed and are keyed by user, contest, platform, and problem.
- [x] Participated contest cards and filters expose Rated / non-rated / pending status.
- [x] A dedicated navigation route shows contest analysis and manual tag summaries.
- [x] Existing global analytics and tags remain untouched.
