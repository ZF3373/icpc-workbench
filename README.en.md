# ICPC Workbench · ICPC Contest Prep Workbench

[中文](./README.md) | **English**

A **local web app** that analyzes your competitive programming weaknesses from submission history (Codeforces / AtCoder / Luogu / Nowcoder / Daimayuan / LeetCode), generates personalized training plans via AI, and provides calendar-based check-ins.

## Features

- **Multi-Platform Submission Import**: Codeforces / AtCoder auto-sync (official/community public API, incremental dedup); Luogu / Daimayuan / LeetCode auto-sync after configuring cookies; all platforms support manual import (JSON / CSV / form)
- **Built-in Problem Bank**: Ships with ~13,000 offline problems (full Codeforces + Luogu popularizer/advanced- and above, with difficulty and algorithm tags); auto-loaded on first launch for immediate use in training plans and problem lists; expandable per-platform via "Problem Management → Fetch Problem Bank" (CF in seconds, Luogu/Nowcoder paginated)
- **Weakness Analysis**: AC rate statistics by tag / difficulty range / platform, outputting a weakness profile relative to your own average; 12-week trend
- **Mastery Map**: Five-level mastery assessment per knowledge point (Not Started → Touched → Intro → Grasped → Proficient), linking submission data, weakness profile, and template curriculum; each knowledge point links directly to relevant practice problems (including unsolved ones from the bank, sorted by difficulty) and courses; English tags from CF etc. auto-merge with Chinese knowledge points (binary search ↔ 二分), keeping the same topic unified; Grasped/Proficient levels show ⭐/🏆 badges, promotion progress bars, and new-achievement 🎉 markers
- **Practice Data Summary**: One-click generation of a complete personal profile (totals/platform/difficulty/knowledge/weakness/mastery/trends/recent ACs/stuck problems/review bank/course progress/check-ins), downloadable as `.md` for archival and review
- **Today's Training**: Smart problem selection based on weaknesses + planned tasks—one actionable daily goal; each problem supports one-click sync of the platform's latest submissions (instant AC status refresh after solving)
- **AI Training Plans (Dual Channel)**:
  - Built-in generator: Configure an OpenAI-compatible API Key for one-click generation (DeepSeek / OpenAI / Zhipu / Ollama, etc.)
  - Export channel: Without a Key, download a data package + prompt `.md`, feed it to any AI, and paste/upload the returned JSON via Settings → "Import AI Plan" (auto-cleans fences and explanatory text)
  - Prompts include the complete practice data summary: the AI sees weak knowledge points, curriculum gaps, recent problems, stuck problems, review bank due items, and check-in cadence, then schedules redo/template-fill/review tasks accordingly
  - **Custom training requirements**: When generating a plan, you can write additional requirements (e.g., "focus on DP and graph theory," "no more than 3 problems per day," "skip weekends"), injected into the AI prompt and prioritized—balanced with data profile conflicts when possible
  - All tasks include clickable problem links: practice tasks jump to the problem page; review/contest tasks jump to CF submission records or problem set entries; auto-fallback to problem bank links when AI output is missing them
- **AI Assistant (Global)**: A standalone AI chat window in the left sidebar "AI Assistant"—answers algorithm questions, debugs pasted code (markdown code blocks + math formula rendering), interprets practice data and problem distribution statistics (auto-injects practice data summary + weakness profile + upcoming contest calendar); can link to a training plan for AI to directly modify it (plan-modify block → applied in-place after frontend confirmation; tasks with matching "date + title" retain check-in records); also supports generating entirely new training plans from scratch (plan-create block → confirmed and saved as a new plan; differs from plan-modify in that no existing plan linkage is needed); after AI assessment, you can one-click update the estimated ability level (ability-update block; today's training tiers re-adjust accordingly, with restore-to-computed option); during AI discussions, ideas can be distilled into templates and written to the template library (template-add block, saved after user confirmation); contest scheduling auto-aligns with real contest times in the next 14 days
  - **Web Search**: Configure a search engine (Tavily / Brave, both with free tiers) + API Key in "Settings → AI Config"; the AI will automatically search the web when needed (recent contests, latest docs, etc.), with source links appended to replies; leave blank to disable
  - **Tool Calling (function calling)**: The AI can fetch URL content (fetch-url) and parse PDF files (pdf-parse), enabling scenarios like "import the problems from this problem set link into Problem Lists"; requires a model that supports function calling (DeepSeek / GPT / Zhipu, etc.)
  - **Multi-Format Document Attachments**: In addition to images, messages can include PDF / Word / Excel / PPT / HTML / CSV / JSON / XML / EPub documents (PDF ≤10 MiB, others ≤20 MiB); the server extracts text locally and injects it into the conversation (no Files API dependency, compatible with all models); attachment content is cached per-session, so the AI can reference uploaded files in any subsequent turn (won't "forget")
  - **Parallel Multi-Session**: Each session has independent generation status; switch from session A (replying) to session B and type/send normally—both sessions stream output in parallel without blocking; the send button turns red "Stop" during generation (partial output is retained and marked "Generation stopped")
  - Multi-session management: sidebar session list with create / switch / delete / pin / double-click-rename / drag-to-reorder; sessions are saved in browser localStorage
  - Switching modules and coming back won't lose sessions; if you switch away mid-generation, the reply appears automatically when you return
  - **Message Copy / Re-edit**: Assistant messages can be copied in full; user messages support "re-edit" to resend (failed turns are auto-excluded from model context)
  - **Enhanced Math Formula Rendering**: Bare math expressions in AI output (subscripts/superscripts/LaTeX commands without `$` delimiters) are auto-detected and wrapped for rendering; `\(...\)` / `\[...\]` delimiters are normalized to `$` / `$$`; Unicode math symbols (≤ ≥ ≠ ⊕ ⊗ ℓ, etc.) are auto-converted to LaTeX commands; parse failures fall back to plain text rather than jarring red errors
  - **Configurable Output Limits**: "Settings → AI Config" lets you adjust max output tokens (default 384K, increase for long-output scenarios) and model context length (default 1000K, auto-trims oldest messages with a notice when exceeded); replies truncated due to the limit show a notice at the end
  - Image attachments: messages can include problem statements / judge screenshots (JPEG/PNG/GIF/WebP, ≤64 MiB), uploaded via OpenAI-compatible Files API and referenced as file content blocks
- **Problem Lists**: Paste platform problem set entries (Luogu / Codeforces / AtCoder / Daimayuan / Nowcoder / LeetCode problem IDs or links, one per line) for auto-recognition and list creation; classify by knowledge point (synced problem bank tag rules + AI classification + manual adjustment); look up difficulty and AC status from the bank; CF/AtCoder mirrored problems in Luogu lists auto-fallback to native platform for tags; rule-based classification only updates problems with bank tags—those without tags retain their existing category (won't be wiped to "Other"); AI reads list content and gives practice suggestions based on your weakness profile
- **Review Bank**: Problem re-evaluation with forgetting-curve scheduling (due-count reminders, positive/negative feedback adjusts review intervals)
- **Template Library**: 114 built-in algorithm template lessons (10 major categories), with study status/notes/progress tracking; custom templates support Tab-indent code editors (Tab indent, Shift+Tab outdent, Enter auto-indent, undo stack preserved); idea notes support full Markdown rendering (GFM tables/strikethrough/code blocks + math formulas, inline `$...$` and block `$$...$$`, Obsidian-compatible syntax); header toggles indent width (2/4 spaces, locally persisted)
- **Contest Center**: Aggregates contests from Codeforces / AtCoder / Luogu / Nowcoder (upcoming / finished, auto-degrades on single-source failure); pre-contest selection, post-contest upsolving
- **Calendar Check-ins**: Monthly calendar with daily training tasks, problem links, per-task check-ins; check-in data syncs with the Plans page; consecutive check-in streak tracking
- **Check-in Reminders**: Configure a daily reminder time in Settings; while the app is open, if there are unchecked tasks for the day at the reminder time, a browser system notification + in-page notification appears—click to jump to the calendar; pre-contest reminders configurable N minutes before start (once per contest, click to jump to Contest Center)
- **Software Update**: Dual-channel detection (stable release + GitHub latest commit build) + in-app one-click self-update (update driver is on a global Provider; switching modules after initiating an update won't interrupt download/replacement; refreshing the page auto-resumes update progress)
- **Web Widget**: `http://localhost:3001/widget` is a zero-dependency single page (served directly by Express) for a always-on mini-window showing today's tasks, streak badge, with direct check-in/problem-jump

## Tech Stack

```
icpc-workbench/
├── server/          # Node.js + Express + node:sqlite (built-in SQLite, zero native deps)
│   ├── adapters/    # Platform adapters (CF/AtCoder auto; Luogu/Nowcoder/Daimayuan/LeetCode limited) + incremental sync
│   ├── analysis/    # Aggregate stats / weakness profile / weekly trends
│   ├── ai/          # OpenAI-compatible provider + plan-prompt.md / assistant-prompt.md templates + function calling tools (fetch-url / pdf-parse / web search) + document converters (Word/Excel/PPT/HTML/CSV/JSON/XML/EPub → Markdown)
│   ├── contests/    # Four-platform contest aggregation (CF/AtCoder/Luogu/Nowcoder, auto-degrade on source failure)
│   ├── plans/       # Plan generation (AI-first, fallback to template on failure/no config) + persistence
│   ├── import/      # Manual import (JSON/CSV/form) + transactional persistence
│   ├── updater.ts   # One-click self-update (download/SHA256 verify/in-place replace)
│   └── routes/      # REST API (stats/problems/plans/ai/lists/reviews/today/templates/contests/checkins/settings/export/sync/import/update)
├── client/          # React + Vite + Ant Design (dashboard/today/AI assistant/templates/problem lists/plans/reviews/problem management/mastery map/calendar/contests/settings)
├── desktop/         # Tauri desktop shell (app: main native window + Node service sidecar)
└── shared/          # Cross-platform shared types and platform metadata
```

## Quick Start

Requirements: Node.js ≥ 22.5 (uses built-in `node:sqlite`), npm.

```bash
npm install     # Install all workspace dependencies
npm run dev     # Start both server (:3001) and client (:5173)
```

Open http://localhost:5173 to use. Data is stored in `server/data/icpc.db` (auto-created on first launch).

Common scripts:

```bash
npm run dev          # Dev mode (both server + client)
npm run build        # Build frontend (dist/)
npm run typecheck    # Type check (server + client)
npm test             # Server unit tests (node:test)
npm run dev:server   # Backend only
npm run dev:client   # Frontend only
```

## Desktop App (Native Window, No Browser Required)

```bash
node server/scripts/build-desktop.mjs   # Desktop app (shell + core + NSIS installer)
```

Requires a local Rust toolchain (`cargo`); first build downloads Tauri/NSIS components. Artifacts in `server/release/`:

- `icpc-workbench_<version>_x64-setup.exe`: NSIS installer (Chinese wizard, no admin required, auto-creates Start Menu/desktop shortcuts; backs up practice data to `%APPDATA%\icpc-workbench` before uninstall)
- `icpc-workbench.exe` + `icpc-core.exe`: Portable edition (two exes in the same folder, extract and run—no installation)
- Optional code signing: set env var `CODESIGN_PFX_PASSWORD` and place the pfx certificate in `server/certs/`; the build auto-signs all three exes

The shell auto-launches the core and probes for an available port (3001–3020); the window loads the app page directly; if the core crashes, it auto-restarts and recovers; closing the window exits everything (services cleaned up). External links (problem links, download pages, etc.) open in the system default browser.

End-user experience for non-technical users:

- Its own native window, no browser dependency; first-launch initialization takes a few seconds
- Data is stored next to the exe in `data/icpc.db`; the exe and data folder can be moved together
- Upgrades: in-app "one-click update" handles everything; or download the new installer and overwrite; or replace the old files with the two portable exes—data is untouched

### macOS (Apple Silicon, available in nightly)

```bash
node server/scripts/build-desktop-mac.mjs   # Run on macOS only
```

The CI nightly pre-release publishes a `.dmg` alongside the Windows set (Apple Silicon M-series; Node SEA core is architecture-specific, no Intel Mac build for now):

- `icpc-workbench_<version>_aarch64.dmg`: drag to "Applications" to install; data stored in app's `data/`
- No Apple Developer certificate purchased: on first launch, when prompted "cannot verify developer," right-click → "Open," or run `xattr -cr /Applications/icpc-workbench.app` in Terminal
- macOS does not support in-app one-click update (Windows only); to update, manually download from the Releases page and overwrite

## Browser-Mode Single-File EXE Packaging (Legacy, Retained)

```bash
node server/scripts/build-exe.mjs
```

Artifacts in `server/release/`: `icpc-workbench.exe` (~90MB, Node SEA single file) + `使用说明.txt` (usage instructions). Copy the entire folder to the user. End-user experience:

- Double-click exe → automatically opens the default browser to the app page (listens on 127.0.0.1 only, no firewall popup)
- Auto-increments port if occupied (default 3001 → 3002…); double-clicking again reuses the running instance and opens the page
- On startup failure, the window stays open showing the error—no flash-exit
- Database stored next to the exe in `data/icpc.db`; exe and data folder can be moved together

### Software Update (Dual Channel + One-Click Self-Update)

Version number and build commit are injected by the packaging script (shown in `/api/health`, sidebar, and Settings page). The app auto-checks silently on launch (once per 24 hours); a dismissable banner appears at the top when an update is available; the Settings page "Software Update" card supports manual checking.

- **Stable channel**: GitHub Releases stable versions, compared by semantic version
- **Commit channel**: The pre-release tagged `nightly`—CI (`.github/workflows/nightly-desktop.yml`) auto-builds the Windows set and macOS (Apple Silicon) dmg on every push to master and publishes; the app compares the build commit with the nightly's commit, so new untagged commits are also detected
- **One-click self-update** (Windows desktop): downloads both exes to `data/update-staging` → SHA256 verification against the Release's `checksums.sha256` (aborts on mismatch) → in-place replacement (running exe renamed `.old`, new file copied in); `data` is unaffected; close and reopen the app to apply
- **Network fallback**: checking and downloading use native fetch first, falling back to PowerShell on Windows (system certificate store) on failure—works in enterprise network/security software TLS interception environments; silent degradation on network failure
- Browser mode or non-Windows environments auto-fallback to "go to download page" for manual updates

## Configuration

- `server/config.json` (optional, see `server/config.example.json`): port, database path, AI defaults
- Runtime AI config can be modified in the "Settings" page and persisted to the database; API Key can also be provided via the `AI_API_KEY` environment variable

## AI Configuration (Built-in Generator)

1. "Settings" → Enable AI generation, fill in Base URL / API Key / Model
2. Common setups:
   - DeepSeek: `https://api.deepseek.com/v1` + `deepseek-chat`
   - OpenAI: `https://api.openai.com/v1` + `gpt-4o-mini`
   - Ollama (local): `http://localhost:11434/v1` + a pulled model name
3. "Training Plans" → Generate a new plan (auto-falls back to template plan if AI fails or is unconfigured)

Advanced settings (all in "Settings → AI Config"):

- **Conversation timeout**: Max wait time for AI assistant responses; increase for slower models (default 120 seconds)
- **Max output tokens**: Token limit per response; increase for long-output scenarios like batch template compilation; truncated replies show a notice at the end
- **Model context length**: When conversation history exceeds this, the oldest messages are auto-trimmed with a notice, preventing API limit errors
- **Web search**: Select a search engine (Tavily / Brave, both with free tiers) and enter an API Key to enable; the AI auto-calls search when needed with source links; requires a model that supports function calling

> The AI assistant uses a user-configured OpenAI-compatible interface; response speed and token costs depend on the chosen model and API. If a model is slow or frequently times out, switch to a faster model in "Settings → AI Config."

## No-AI-Key Usage (Export Channel)

1. "Settings" → Download the prompt `.md` (or `GET /api/export/plan-package` for the full data package)
2. Paste the content to any AI and have it output a JSON plan per the template
3. Import the returned JSON via "Problem Management → Manual Entry / Upload File" as a plan

## Platform Integration Status

| Platform | Auto-Sync | Method | Notes |
|----------|-----------|--------|-------|
| Codeforces | ✅ | Official public API `user.status` | No login required; paginated newest-first, stops early when an entire page of submission IDs is already known (incremental) |
| AtCoder | ✅ | Community API `kenkoooo.com` v3 | Supports incremental (from_second); problem resources cached on disk for 24h; official requirement: ≥1s between page requests |
| Luogu | ✅ (Cookie required) | `record/list` unofficial API | Configure `_uid` / `__client_id` cookies in Settings to auto-sync; difficulty levels (0–8) auto-mapped to CF rating; tags fetched via `x-lentille-request` header + `/_lfe/tags` dictionary |
| Nowcoder | ✅ | Public HTML `acm/contest/profile/{uid}/practice-coding` | No login/cookie required (Nowcoder deprecated its JSON API); parses submission table, supports incremental and pagination; problems have no difficulty/tag fields (data source limitation) |
| Daimayuan | ✅ (Cookie required) | Hydro JSON API `/record?uidOrName=` (`Accept: application/json`) | Configure `sid` session cookie in Settings to auto-sync (100 per page, incremental early termination); uses Hydro native JSON content negotiation to directly fetch rdocs array—no HTML template parsing, so Hydro frontend template changes won't break the adapter; status mapped to unified Verdict via Hydro STATUS enum; non-contest submissions only; problem bank page `/p/{id}` is public |
| LeetCode | ✅ (Cookie required) | leetcode.cn GraphQL `submissionList` | Configure cookies in Settings to auto-sync (40 per page, up to 250 pages); LeetCode China (leetcode.cn) only—international edition has a different API structure; problem bank is anonymously accessible |

> Luogu uses a community-maintained unofficial API whose structure may change with platform updates. If sync fails, update your cookies and retry. Cookies are stored only in the local database—do not leak them.

## Cookie Configuration (Required for Luogu / Daimayuan / LeetCode)

1. After logging into Luogu in your browser: F12 → Application → Cookies → `https://www.luogu.com.cn`
2. Copy the values of `_uid` and `__client_id`, paste them into the two input fields under "Settings → Luogu" and save (the app assembles the Cookie header; C3VK and other cookies auto-renew—no need to enter them)
3. Daimayuan: after logging into bs.daimayuan.top: F12 → Application → Cookies, copy the `sid` entry (session cookie), paste into "Settings → Daimayuan" and save (supports pasting the entire Cookie header—auto-extracts fields; re-copy when expired)
4. LeetCode: after logging into leetcode.cn: F12 → Application → Cookies, copy `LEETCODE_SESSION` and `csrftoken`, paste into "Settings → LeetCode" and save
5. Go to "Problem Management" → Platform Sync → enter username/uid → Sync
6. When rebinding accounts, the new sync automatically clears the old account's submission data for that platform

## API Overview

```
GET  /api/health
POST /api/sync/all               # One-click sync all bound accounts (incremental per platform; single-platform failure doesn't affect others)
POST /api/sync/:platform          # Sync a single platform account (body: handle)
POST /api/import/manual           # Manual import (body: platform, rows[])
POST /api/import/csv              # CSV import (body: platform, csv)
GET  /api/stats                   # Overall stats (from/to/platform filter)
GET  /api/stats/weakness          # Weakness profile (minAttempts/topN)
GET  /api/stats/trend             # Weekly trend (weeks)
GET  /api/stats/mastery           # Knowledge mastery map (submission data × template curriculum)
GET  /api/stats/summary           # Complete practice data summary (JSON: totals/platform/difficulty/tags/weakness/mastery/trends/recent ACs/stuck problems/review bank/course progress/check-ins)
GET  /api/problems                # Problem list (platform/difficulty/tag/q filter; tag includes synonymous English aliases)
GET  /api/today                   # Today's training recommendation (problems selected by weakness + planned tasks)
GET  /api/templates               # Full built-in template curriculum + personal progress (total/mastered/learning/next)
GET  /api/templates/next          # "Next lesson" recommendation (learning-first, then first unlearned in outline)
POST /api/templates/custom        # Create custom template | PATCH/DELETE /api/templates/custom/:id
PUT  /api/templates/:id/content   # "Write my template" for a lesson (idea/code/complexity/reference link)
POST /api/templates/:id/status    # Study status (body: { status: todo|learning|mastered })
PATCH /api/templates/:id/note     # Study note (body: { note })
GET  /api/reviews                 # Review queue | POST /api/reviews create new review
GET  /api/reviews/due-count       # Due review count
POST /api/reviews/:id/feedback    # Review feedback (remembered/forgotten → schedules next review)
GET  /api/contests                # Four-platform contest aggregation (?type=upcoming|finished&platform=&limit=)
GET  /api/plans | POST /api/plans/generate | POST /api/plans/import | GET /api/plans/:id | DELETE /api/plans/:id
                                   # generate body: { days?, startDate?, dailyTasks?, requirements? } ← requirements = user-written training requirements, injected into AI prompt and prioritized
                                   # import body: { raw, startDate?, days? } ← any AI-returned plan JSON text
PATCH /api/plans/tasks/:taskId    # Edit single task (taskDate/title/kind/url/note, only updates submitted fields)
DELETE /api/plans/tasks/:taskId   # Delete single task (check-in records cascade-deleted)
POST /api/plans/:id/apply         # Apply AI plan modification (body: { raw }; preserves check-ins by matching "date + title")
POST /api/ai/chat                # Global AI assistant chat (body: { messages, planId? }; injects practice summary/weakness profile/ability level/contest calendar; planId enables plan modification; user messages can include attachments: [{ fileId, filename? }], ≤8; supports function calling tools: web search / fetch-url / pdf-parse)
POST /api/ai/extract-text         # Local document text extraction (raw byte stream, header: content-type + x-file-name; PDF via unpdf ≤10MiB, Word/Excel/PPT/HTML/CSV/JSON/XML/EPub via docConverter ≤20MiB; returns { text, pages?, warning? })
POST /api/ai/files               # Upload file to AI Files API (raw byte stream, header: x-file-name / x-expires-seconds?; server forwards as multipart to upstream, purpose=user_data, ≤64MiB)
GET  /api/ai/files               # List files (?after=&limit=1-1000&order=asc|desc, cursor pagination)
GET  /api/ai/files/:fileId       # Query file metadata
DELETE /api/ai/files/:fileId     # Delete file
GET  /api/ai/ability             # Estimated ability level (computed/override/effective)
POST /api/ai/ability             # Apply AI ability adjustment (body: { level, reason } or { reset: true })
GET  /api/lists                  # Problem list index | POST /api/lists import (body: { title, raw, sourceUrl? })
GET  /api/lists/:id              # List details (items include difficulty/AC status)
POST /api/lists/:id/classify     # Classify by problem bank tag rules | POST /:id/ai-classify AI classification
POST /api/lists/:id/ai-suggest   # AI reads list content for practice suggestions (returns markdown)
PATCH /api/lists/items/:itemId   # Manually change category (body: { category }) | DELETE same path removes item
GET  /api/checkins?month=YYYY-MM  # Monthly check-in view
GET  /api/checkins/date/:date     # Tasks for a given date (reused by Web widget)
GET  /api/checkins/streak         # Consecutive check-in stats (current/longest/totalDays)
POST /api/checkins { taskId }     # Check in | DELETE /api/checkins/:taskId cancel
GET  /api/settings                # Settings (AI/accounts/adapter toggles/check-in reminders)
POST /api/settings/reminder       # Check-in reminder config (body: enabled?, time? "HH:MM")
POST /api/settings/cookies/check  # Verify cookie login state (same data page as sync: Luogu record/list self-check, Daimayuan by bound account)
GET  /api/export/plan-package     # Data package (weakness + trends + problems + prompt)
GET  /api/export/plan-prompt.md   # Rendered prompt download (with embedded practice data summary)
GET  /api/export/summary.md       # Complete practice data summary .md download (for review / feeding to any AI)
GET  /api/update/check            # Update check (stable + nightly commit build dual channel)
GET  /api/update/progress         # One-click update download progress (phase/received/total)
POST /api/update/download         # Start download and SHA256 verify | POST /api/update/apply in-place replace
GET  /widget                      # Web widget single page (today's tasks + check-in)
```

## Testing

```bash
npm test            # Server unit tests (schema/config/adapters/import/sync/analysis/plans)
npm run typecheck   # Type check (server + client)
```

Test coverage: database schema and constraints, config validation, CF/AtCoder/Nowcoder contest adapter normalization (mock + real network verification), CSV parsing, import dedup, incremental sync, stats/weakness/trends consistency with manual calculation, AI generation three paths (success/failure/unconfigured), update dual-channel logic and SHA256 verification parsing, document converters (Word/Excel/PPT/HTML/CSV/JSON/XML/EPub), Markdown math formula preprocessing pipeline, session-level attachment content caching.

## License

This project's code is released under the [MIT License](./LICENSE).
Third-party dependencies and their licenses are listed in [CREDITS.md](./CREDITS.md); please report security issues through the private channel described in [SECURITY.md](./SECURITY.md)—do not file public Issues.
