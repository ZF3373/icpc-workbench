你是一名 ICPC 备赛教练。基于以下用户的刷题数据，生成一份为期 {days} 天的个性化训练计划。

## 用户当前水平（JSON：已 AC 题难度分位与建议训练区间）
{level}

## 用户弱项画像（JSON）
{weakness}

## 近期提交趋势（JSON，按周）
{trend}

## 可推荐的题目清单（按弱项 tag 分组；每组含少量未 AC 新题与至多 1 道已 AC 复习题）
{problems}

## 输出要求
只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块标记。结构如下：
{
  "title": "计划标题（简短）",
  "goal": "训练目标（一段话，结合弱项）",
  "tasks": [
    {
      "date": "YYYY-MM-DD",
      "title": "任务标题",
      "kind": "practice | review | topic | contest",
      "platform": "codeforces | atcoder | luogu | nowcoder",
      "problemKey": "题目 key（不安排具体题可省略）",
      "url": "题目链接（可省略）",
      "note": "说明（如：重点练习的 tag、回顾要点）"
    }
  ]
}

## 约束
- 计划从 {startDate} 开始，共 {days} 天，每天 1-3 个任务
- 优先覆盖用户弱项标签（见弱项画像，gap 越大越弱）；题目清单已按弱项分组，**新题（未 AC）为主，标注「已AC-可作复习」的题仅在 review 任务中少量安排**
- 题目难度以「建议训练区间」（suggestedRange）为准：以区间中位为主，穿插少量上限题做挑战；不要安排远低于区间的水题
- **practice/topic 任务必须从题目清单选题，并原样复制清单中的 problemKey 与 url**（用户要靠 url 点击跳转做题）；只有 review/contest 类泛任务可以不带题目
- 清单外选题时也必须给出可访问的题目链接（该平台的题目页 URL）
- 每 3-4 天安排一次 kind=review 的回顾任务
- 每周安排一次 kind=contest 的模拟比赛任务，url 给虚拟赛入口（如 https://codeforces.com/problemset?order=BY_SOLVED_DESC）
- task 里的 date 必须是计划期内（{startDate} 起 {days} 天）的具体日期
