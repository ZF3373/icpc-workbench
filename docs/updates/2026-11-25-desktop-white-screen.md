# 桌面版打开后白屏：「已展开全部模块」的用户 100% 复现

## 现象

用户反馈：**最新版桌面版打开后白屏**——窗口正常出现、标题栏是「ICPC 备赛工作台」，
但内容区一片纯色（浅灰），没有任何侧边栏、没有任何报错文字。

关键线索：**同一台机器上用浏览器打开 `http://localhost:3001` 却完全正常**，
换机器、清 WebView2 缓存、删 `icpc-dashboard-module-collapsed-v1` 之外的偏好都不解决。

## 根因

`client/src/problemVisibility.ts` 的 `getVisibility()` 被当作
`useSyncExternalStore` 的 **getSnapshot** 使用，但它每次调用都 `return normalizeVisibility(...)`
—— **每次都是新对象**。

React 用 `Object.is` 比较快照引用：

```
subscribe 的 onChange → React 取快照 → 引用不同，判定"状态变了" → 重渲染
   → 渲染期间再取快照 → 又不同 → ……
   → React error #185「Maximum update depth exceeded」→ 整棵树卸载
```

整棵树被卸载，`#root` 变成空的 —— 于是白屏。**不是加载失败，是渲染循环把树拆了。**

## 为什么只在桌面版、只对部分用户炸

关键在于「有没有组件真的订阅这个 hook」：

- 数据概览的「写题历史」**默认折叠**。折叠态下 `HistoryPanel` 根本不挂载，
  不调用 `useProblemVisibility()`，因此**永不触发**；
- 一旦用户手动把模块全部展开（折叠集合存成 `[]`），`HistoryPanel` 挂载并订阅
  → 立刻进入死循环 → 白屏。

这也解释了为什么 CI 全绿、开发者本机正常：默认状态下没人订阅它。

## 复现（可复制的判定方法）

在任意浏览器打开应用后执行：

```js
localStorage.clear()
localStorage.setItem('icpc-dashboard-module-collapsed-v1', '[]')
location.reload()
```

修复前：白屏 + 控制台 `Minified React error #185`。
修复后：正常渲染，「写题历史」可见。

## 修复

让 `getVisibility()` 返回**稳定引用**：按字段值缓存，两项都没变就复用上一次的对象。
与仓库里 `menuConfig.tsx` 的 `getOrderSnapshot`、`useRecentPages` 同款模式
（那两处早就有同样的注释警告）。

```ts
let cachedVisibility: ProblemVisibility | null = null
export function getVisibility(): ProblemVisibility {
  const next = normalizeVisibility(readJson<unknown>(PROBLEM_VISIBILITY_KEY))
  if (cachedVisibility
    && cachedVisibility.hideTags === next.hideTags
    && cachedVisibility.hideDifficulty === next.hideDifficulty) {
    return cachedVisibility
  }
  cachedVisibility = next
  return cachedVisibility
}
```

## 防回归

新增 `client/test/storeSnapshotStability.test.ts`：把仓库里**全部** `getSnapshot`
拉一张表，逐个断言「连续调用必须引用相等」。这类 bug 的特征是纯函数单测全绿、
typecheck 全绿、打包也成功，只有真有人订阅时才炸 —— 所以只能靠这种针对性守卫。

已验证该守卫有效：把修复临时回滚，守卫立刻失败并报出
`problemVisibility.getVisibility 第二次调用换了引用`。

**以后新增 store，请把它的 getSnapshot 加进这张表。**
