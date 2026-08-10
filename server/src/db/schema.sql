-- ICPC Workbench schema
-- 时间统一存 UTC；submitted_at / completed_at 由应用层写入 ISO8601 字符串，
-- created_at 等默认值用 SQLite datetime('now')。

CREATE TABLE IF NOT EXISTS platforms (
  id              TEXT PRIMARY KEY,            -- codeforces / atcoder / luogu / nowcoder
  name            TEXT NOT NULL,
  has_official_api INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL UNIQUE,             -- 本地昵称，默认 'me'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS platform_accounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  platform     TEXT NOT NULL REFERENCES platforms(id),
  handle       TEXT NOT NULL,                  -- CF handle / AtCoder 用户名 / 洛谷 uid / 牛客 uid
  last_sync_at TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (user_id, platform)
);

CREATE TABLE IF NOT EXISTS problems (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  platform    TEXT NOT NULL REFERENCES platforms(id),
  problem_key TEXT NOT NULL,                   -- 平台内唯一标识，如 1919C / abc321_a
  title       TEXT NOT NULL,
  difficulty  INTEGER,                         -- CF rating；洛谷难度数值；AtCoder 映射分值
  url         TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',      -- JSON 数组字符串
  UNIQUE (platform, problem_key)
);

CREATE TABLE IF NOT EXISTS submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  platform     TEXT NOT NULL REFERENCES platforms(id),
  problem_id   INTEGER NOT NULL REFERENCES problems(id),
  verdict      TEXT NOT NULL,                  -- AC / WA / TLE / RE / MLE / CE / SKIPPED
  language     TEXT,
  submitted_at TEXT NOT NULL,                  -- ISO8601 UTC
  external_id  TEXT,                           -- 平台侧提交号（去重用）
  UNIQUE (user_id, platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_submissions_user_platform ON submissions(user_id, platform);
CREATE INDEX IF NOT EXISTS idx_submissions_problem ON submissions(problem_id);

CREATE TABLE IF NOT EXISTS plans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  goal        TEXT NOT NULL DEFAULT '',
  start_date  TEXT NOT NULL,                   -- YYYY-MM-DD
  end_date    TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'ai',      -- ai / template / manual
  raw_prompt  TEXT,                            -- AI 原始输出（可回溯）
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plan_tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id    INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  task_date  TEXT NOT NULL,                    -- YYYY-MM-DD（挂件按日查询预留）
  title      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'practice', -- practice / review / topic / contest
  problem_id INTEGER REFERENCES problems(id),
  url        TEXT,                             -- 跳转链接（桌面挂件预留）
  note       TEXT,
  UNIQUE (plan_id, task_date, title)
);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_date ON plan_tasks(task_date);

CREATE TABLE IF NOT EXISTS checkins (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  task_id      INTEGER NOT NULL REFERENCES plan_tasks(id) ON DELETE CASCADE,
  task_date    TEXT NOT NULL,                  -- 冗余存日期，便于按日/月查询（挂件预留）
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (task_id)
);
CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins(task_date);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
