/**
 * 题目标签可见性偏好（纯 localStorage，无后端）。
 *
 * 背景（issue #68）：做题前看到算法标签很容易顺着标签猜解法，少了自己从题面发现性质的过程；
 * 难度标签也会影响对题目的预判。所以提供两个**独立**开关，且只作用于**尚未 AC 的题**：
 * 已经 AC 的题再看标签不会破坏「先自己发现性质」的过程，反而有助于复盘。
 *
 * 与 editorSettings 同款结构（localStorage + useSyncExternalStore 订阅），
 * 区别是这里存的是两个布尔位而不是枚举，所以统一收在一个 JSON 对象里。
 */
import { useSyncExternalStore } from 'react'
import { readJson, writeJson } from './persistence'

export const PROBLEM_VISIBILITY_KEY = 'problems.visibility'

/** 同标签页内写入后广播的自定义事件（storage 事件不在同标签页触发） */
const CHANGE_EVENT = 'problem-visibility-change'

/** 题目标签可见性偏好：两个开关互相独立 */
export interface ProblemVisibility {
  /** 隐藏「未 AC」题目的算法标签 */
  hideTags: boolean
  /** 隐藏「未 AC」题目的难度 */
  hideDifficulty: boolean
}

export const DEFAULT_VISIBILITY: ProblemVisibility = { hideTags: false, hideDifficulty: false }

/**
 * 把任意输入归一为合法偏好：只认 true，其余（缺字段 / 脏值 / null）一律 false。
 * localStorage 是用户可以手改、也可能残留旧版本的数据，读取时必须过这一层。
 */
export function normalizeVisibility(raw: unknown): ProblemVisibility {
  const v = (raw ?? {}) as Record<string, unknown>
  return {
    hideTags: v.hideTags === true,
    hideDifficulty: v.hideDifficulty === true,
  }
}

/**
 * 当前偏好：localStorage 优先，非法或缺失回退「全部可见」。
 *
 * ⚠ 返回引用必须稳定：它是 useSyncExternalStore 的 getSnapshot（见 useProblemVisibility）。
 * 每次新建对象会让 React 在每次取快照时都判定「状态变了」→ 重渲染 → 再取快照 → 再判变，
 * 一路顶到「Maximum update depth exceeded」（React error #185），整棵树被卸载，页面白屏。
 * 触发条件只需「有组件订阅了这个 hook」：数据概览默认折叠「写题历史」，
 * 用户一旦手动全部展开（localStorage 存下 []），HistoryPanel 就会挂载并订阅 —— 于是白屏。
 * 所以这里按字段值缓存：两项都没变就返回上一次的对象。
 */
let cachedVisibility: ProblemVisibility | null = null
export function getVisibility(): ProblemVisibility {
  const next = normalizeVisibility(readJson<unknown>(PROBLEM_VISIBILITY_KEY))
  if (
    cachedVisibility &&
    cachedVisibility.hideTags === next.hideTags &&
    cachedVisibility.hideDifficulty === next.hideDifficulty
  ) {
    return cachedVisibility
  }
  cachedVisibility = next
  return cachedVisibility
}

/** 写入偏好并广播变更（同标签页立即生效；跨标签页由 storage 事件处理） */
export function setVisibility(next: ProblemVisibility): void {
  writeJson(PROBLEM_VISIBILITY_KEY, normalizeVisibility(next))
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT))
}

/**
 * 某一行是否应当隐藏算法标签 / 难度。
 *
 * 判定口径是「这题有没有 AC 过」——由调用方传入（题目管理页用 ac_count，写题历史用 acCount）。
 * 未知（undefined/null）按「没有 AC」处理：宁可多藏一格，也不要在用户还没做过这道题时泄底。
 */
export function shouldHideTags(vis: ProblemVisibility, acCount: number | null | undefined): boolean {
  return vis.hideTags && !(typeof acCount === 'number' && acCount > 0)
}

export function shouldHideDifficulty(vis: ProblemVisibility, acCount: number | null | undefined): boolean {
  return vis.hideDifficulty && !(typeof acCount === 'number' && acCount > 0)
}

/** 被隐藏的格子显示什么：明确告诉用户「这里原本有东西，是你把它藏起来了」 */
export const HIDDEN_LABEL = '已隐藏'

function subscribe(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onChange = () => cb()
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

/** React hook：订阅偏好变更，返回当前两个开关（getVisibility 返回稳定引用，见其注释） */
export function useProblemVisibility(): ProblemVisibility {
  return useSyncExternalStore(subscribe, getVisibility, () => DEFAULT_VISIBILITY)
}
