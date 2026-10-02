# ICPC Workbench · ICPC Contest Prep Workbench

[中文](./README.md) | **English**

A **local web app** that analyzes your competitive programming weaknesses from submission history (Codeforces / AtCoder / Luogu / Nowcoder / Daimayuan / LeetCode / Jisuanke), generates personalized training plans via AI, and provides calendar-based check-ins.

## Features

- **Multi-Platform Submission Import**: Codeforces / AtCoder auto-sync (official/community public API, incremental dedup); Luogu / Daimayuan / LeetCode / Jisuanke auto-sync after configuring cookies; all platforms support manual import (JSON / CSV / form)
- **Sync Observability**: every platform sync (success or failure) is recorded into task history—pull counts, dedup counts, rate-limit waits, duration, and explainable failure taxonomy (invalid credentials / rate limiting / page structure changes / manual import required); `GET /api/sync/diagnostics` exports a plain-text diagnostic report (no secrets); `POST /api/sync/:platform` accepts a `days` param to sync only the recent N days; pull speed is user-adjustable with safe per-host floors (risk-control protection), oversized submission sets auto-batch with duplicate-free resume on the next sync; the dashboard keeps a permanent sync status card (per-platform progress while running, last-sync results drawer when idle)
- **Data Protection**: automatic SQLite recovery points (`VACUUM INTO` consistent snapshots, tiered retention by type) on first launch of each day, before app upgrades, before bulk imports, and before account resets; manual backup and one-click restore under "Settings → Backup & Recovery Points" (applies on restart); manual JSON/CSV imports show a change preview (added / skipped / invalid rows) for confirmation before writing
- **Multi-Account Binding**: bind multiple accounts on the same platform (e.g., a main account plus a practice alt) and delete accounts you no longer use; unneeded backups / recovery points can also be deleted manually to free disk space
- **Account Scope for Statistics**: once a platform has more than one bound account, the Dashboard and Mastery pages grow a "All accounts / this account" picker (hidden for single-account users). Picking an account scopes AC rate, difficulty and tag distributions, the weakness profile, the 12-week trend, the activity heatmap and the mastery map to that account's submissions — and the **weakness baseline (relative to your own average AC rate) narrows with it**, otherwise a knowledge point the main account keeps failing gets diluted into "mastered" by the alt account's water problems. The choice is stored locally and survives navigation and restarts. Ability estimation deliberately stays across all accounts: it estimates *your* level and carries a slow calibration trajectory that would corrupt itself if it followed the scope.
- **Local Security Boundary**: the server binds to 127.0.0.1 by default, never exposed to the LAN (the Docker image sets `HOST=0.0.0.0` for port mapping; external deployments should add their own reverse proxy + authentication — see Docker Deployment); settings endpoints only return "configured or not", never raw API keys / search keys / cookies; AI web fetching has built-in SSRF protection—blocks localhost / private / link-local targets (with DNS resolution and per-hop redirect checks), and redirects never leak platform cookies
- **Built-in Problem Bank**: Ships with ~13,000 offline problems (full Codeforces + Luogu popularizer/advanced- and above, with difficulty and algorithm tags); auto-loaded on first launch for immediate use in training plans and problem lists; expandable per-platform via "Problem Management → Fetch Problem Bank" (CF in seconds, Luogu/Nowcoder/Jisuanke paginated)
- **Difficulty System**: each problem can carry a dual scale—native platform difficulty plus a unified CF-rating scale—shown side by side in the bank, with tabs rendered per platform capability; "One-click Backfill" batch-fills difficulties and tags from the platforms—gap-ordered, platforms run cheapest-first, **interruptible anytime** (persisted rows survive; safe to re-run), and it also repairs outdated difficulty values left by old mappings; problems the upstream confirms as "no difficulty available" get a 30-day negative cache, and the list distinguishes "No official difficulty" from "Unknown"—values are never fabricated (CF gym / officially unrated problems are honestly labeled with their source limits); difficulties that can't be looked up support **manual entry** as a fallback
- **Self-built Knowledge Pipeline**: At import time, L1 rules (title patterns + source-tag mapping) produce structured knowledge annotations (knowledge point, confidence, method, evidence, pipeline version); stats and recommendations prefer annotations, falling back to source tags for uncovered problems; manual corrections always take precedence
- **Problem Management**: duplicate problems are auto-deduped (platform + title + normalized key, merged during tag cleanup); duplicate or obsolete problems can be deleted into a trash bin (tombstones matched by normalized key, so old submissions coming back from sync won't "resurrect" them; accidental deletes are restorable); the page-top overview strip shows bank statistics and can be collapsed
- **Weakness Analysis**: AC rate statistics by tag / difficulty range / platform, outputting a weakness profile relative to your own average; 12-week trend
- **Mastery Map**: Five-level mastery assessment per knowledge point (Not Started → Touched → Intro → Grasped → Proficient), linking submission data, weakness profile, and template curriculum; each knowledge point links directly to relevant practice problems (including unsolved ones from the bank, sorted by difficulty) and courses; English tags from CF etc. auto-merge with Chinese knowledge points (binary search ↔ 二分), keeping the same topic unified; Grasped/Proficient levels show ⭐/🏆 badges, promotion progress bars, and new-achievement 🎉 markers
- **Practice Heatmap**: GitHub-contribution-style yearly calendar on the dashboard; cell shading = the day's deduplicated AC count (repeated ACs on one problem count once), with level thresholds computed from quartiles of active days—concentrated distributions like "1–3 problems a day" still spread across shades; GitHub-palette greens auto-adapt to dark/light theme, and cell size scales to fill the card width; switch between last 3 / 6 / 12 months, hover for the day's "N AC / M submissions"; shares the same local-day boundary as check-ins and the calendar (late-night solves count for that day, no day-shift), auto-refreshes after sync
- **Draggable Dashboard Modules**: the six dashboard cards (heatmap / platforms / difficulty / weakness / 12-week trend / history) reorder by dragging their title bar—live swap on hover, persisted to localStorage (kept across refresh and restart); drags start only from the title bar, so chart tooltips, the history table, and the heatmap range switch stay interactive; same hand-rolled mouse-event approach as the platform cards—zero drag libraries, works in the WebView2 desktop shell too
- **Practice Data Summary**: One-click generation of a complete personal profile (totals/platform/difficulty/knowledge/weakness/mastery/trends/recent ACs/stuck problems/review bank/course progress/check-ins), downloadable as `.md` for archival and review
- **Estimated Ability**: weighted solve-evidence rating (difficulty, AC evidence volume, new-problem completion) with slow recalibration to damp single-day swings; after AI assessment you can one-click override the value (today's training tiers re-adjust accordingly) and restore the computed value anytime
- **Today's Training**: Smart problem selection based on weaknesses + planned tasks—one actionable daily goal; each problem supports one-click sync of the platform's latest submissions (instant AC status refresh after solving); a recommendation cooldown puts recently recommended/solved problems on hold so the daily set genuinely rotates instead of repeating
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
  - **Post-Contest Review**: In the left "Conversation Context" panel, link a contest you participated in—the list combines local submission derivation with authoritative platform participation records: Codeforces/AtCoder official APIs (user.rating / history) fill in rated contests with rank and rating changes; Luogu fetches your joined contests (including team contests and replays, attributing T-prefixed contest-problem submissions by official time window); Nowcoder fetches the joined history (with rank/AC counts; in-contest submissions are already captured by the practice sync and attributed to each contest by its official window); local derivation as fallback (CF participation signals and ≥3-problem gym sittings, AtCoder calendar time windows, Jisuanke/QOJ contest-keyed problem IDs); Daimayuan/LeetCode unsupported. Participation records are **persisted to the DB and fetched incrementally**: first run does a full pass (30-page-per-run cap, truncated runs resume next time), afterwards they expire every 30 minutes and the background silently fetches only what's new (usually 1 page) while the tab opens instantly from the DB; Nowcoder ratings still being computed (or unrated) no longer show the platform's placeholder value. Selecting a contest prefills a review request; sending then injects the contest link, every submission (timeline relative to contest start, in-contest/upsolving labels, difficulty and tags), the list of **problems never submitted during the contest** (problem sets from the Nowcoder problem-list / CF contest.standings / AtCoder `/contests/{slug}/tasks` endpoints, fetched on demand at review time and persistently cached), and the **problem statements themselves**: statements for *every* problem of the contest — including problems you solved and problems you never opened — are fetched in the background per contest and cached permanently, then injected into the system prompt to anchor the analysis (AtCoder, together with its authoritative problem titles, which also repairs titles garbled by community data; and Luogu, anonymously via its C3VK anti-bot challenge). Problems whose statements could not be retrieved are **listed by name with an explicit instruction forbidding the AI from guessing the statement from the title** (AtCoder / Luogu / Nowcoder contest problem pages are readable — a few Nowcoder pages require login; Codeforces HTML pages are blocked by Cloudflare and Jisuanke/QOJ have no public source — paste those statements into the chat instead). Structured AI review follows: overall performance → per-problem sticking points and unattempted-problem attribution → weakness-profile cross-check → upsolving advice
  - **Parallel Multi-Session**: Each session has independent generation status; switch from session A (replying) to session B and type/send normally—both sessions stream output in parallel without blocking; the send button turns red "Stop" during generation (partial output is retained and marked "Generation stopped")
  - Multi-session management: sidebar session list with create / switch / delete / pin / double-click-rename / drag-to-reorder; sessions are saved in browser localStorage
  - Switching modules and coming back won't lose sessions; if you switch away mid-generation, the reply appears automatically when you return
  - **Message Copy / Re-edit**: Assistant messages can be copied in full; user messages support "re-edit" to resend (failed turns are auto-excluded from model context)
  - **Enhanced Math Formula Rendering**: Bare math expressions in AI output (subscripts/superscripts/LaTeX commands without `$` delimiters) are auto-detected and wrapped for rendering; `\(...\)` / `\[...\]` delimiters are normalized to `$` / `$$`; Unicode math symbols (≤ ≥ ≠ ⊕ ⊗ ℓ, etc.) are auto-converted to LaTeX commands; parse failures fall back to plain text rather than jarring red errors
  - **Configurable Output Limits**: "Settings → AI Config" lets you adjust max output tokens (default 384K, increase for long-output scenarios) and model context length (default 1000K, auto-trims oldest messages with a notice when exceeded); replies truncated due to the limit show a notice at the end
  - Image attachments: messages can include problem statements / judge screenshots (JPEG/PNG/GIF/WebP, ≤64 MiB), uploaded via OpenAI-compatible Files API and referenced as file content blocks
- **Problem Lists**: Paste platform problem set entries (Luogu / Codeforces / AtCoder / Daimayuan / Nowcoder / LeetCode / Jisuanke problem IDs or links, one per line) for auto-recognition and list creation; classify by knowledge point (synced problem bank tag rules + AI classification + manual adjustment); look up difficulty and AC status from the bank; CF/AtCoder mirrored problems in Luogu lists auto-fallback to native platform for tags; rule-based classification only updates problems with bank tags—those without tags retain their existing category (won't be wiped to "Other"); existing lists accept **appended problems**; AI reads list content and gives practice suggestions based on your weakness profile
- **Review Bank**: Problem re-evaluation with forgetting-curve scheduling. The interval ladder is 1/3/7/14/30/60/**120/240** days — a correct recall moves one step up, "easy" jumps two, and a lapse now **steps back only two stages** instead of slamming a 60-day item back to "tomorrow" (which only taught users to stop reporting lapses honestly). Climbing to 240 days is what makes the queue **converge**: capped at 60 days, a long-solved problem came back every 60 days forever and the workload only grew. Within a stage the interval is then multiplied by a **retention factor** (0.5–1.6): how many times this item has lapsed before, whether its knowledge concept reads as "touched" or "proficient" on the mastery map, and whether the problem was originally solved only after reading an editorial — all pull the next review closer or push it further, so two items at the same stage no longer land on the same day. The factor only rewrites the day count, never the stage, so "stage N" stays explainable in the UI. Every feedback answer appends a **review event** (`review_events`: stage before/after, the due date it was reviewed against, the actual interval, the factor applied), which is what makes "how many times have I slipped on this one, and why was it scheduled so far out" answerable — and what any future true adaptive scheduler will need as training data. Newly added items are **staggered over the next 4 days** by problem id, so bulk-adding dozens from a list or submission history no longer dumps them all on one day, and the success toast reads out the date it will come due. Due counts also surface in Today's training and the widget.
- **Template Library**: 114 built-in algorithm template lessons (10 major categories), with study status/notes/progress tracking; create custom categories for your own organization (custom tags are deletable), and export the whole library to Markdown / PDF for archival or sharing; templates distilled from AI discussions can be written to a tag of your choice; custom templates support Tab-indent code editors (Tab indent, Shift+Tab outdent, Enter auto-indent, undo stack preserved); idea notes get a full Markdown editor (formatting toolbar, image paste, live preview) with complete rendering (GFM tables/strikethrough/code blocks + math formulas, inline `$...$` and block `$$...$$`, Obsidian-compatible syntax); header toggles indent width (2/4 spaces, locally persisted)
- **Solving History**: query "which problems have I attempted on which platform" right from the dashboard—grouped by problem (submission/AC counts) or per-submission views, with platform filter and all-AC / not-AC filter, linking to the original problems
- **Contest Center**: Aggregates contests from Codeforces / AtCoder / Luogu / Nowcoder / Jisuanke (upcoming / running / finished, auto-degrades on single-source failure); pre-contest selection, post-contest upsolving; a "My Contests" tab aggregates your participation records across platforms (local submission derivation + CF/AtCoder/Luogu/Nowcoder participation history, with rank and rating changes) with one-click jump to the AI assistant for a review of that contest. Participation is now fetched **per account**: every bound account on a platform has its own incremental cursor and its own status, so one account failing (an expired cookie on the alt) no longer masks the data another account just pulled. When several accounts entered the same contest, the list still shows one card — the score comes from the account with more local submissions and the card is labelled "multiple accounts", while the AI review timeline annotates each submission with its account (so the alt's warm-up attempts are not read as the main account's in-contest performance)
- **Calendar Check-ins**: Monthly calendar with daily training tasks, problem links, per-task check-ins; check-in data syncs with the Plans page; consecutive check-in streak tracking
- **Check-in Reminders**: Configure a daily reminder time in Settings; while the app is open, if there are unchecked tasks for the day at the reminder time, a browser system notification + in-page notification appears—click to jump to the calendar; pre-contest reminders configurable N minutes before start (once per contest, click to jump to Contest Center)
- **Software Update**: Dual-channel detection (stable release + GitHub latest commit build) + in-app one-click self-update (update driver is on a global Provider; switching modules after initiating an update won't interrupt download/replacement; refreshing the page auto-resumes update progress)
- **Web Widget**: `http://localhost:3001/widget` is a zero-dependency single page (served directly by Express) for a always-on mini-window showing today's tasks, streak badge, with direct check-in/problem-jump

## Tech Stack

```
icpc-workbench/
├── server/          # Node.js + Express + node:sqlite (built-in SQLite, zero native deps)
│   ├── adapters/    # Platform adapters (CF/AtCoder auto; Luogu/Nowcoder/Daimayuan/LeetCode/Jisuanke limited) + incremental sync
│   ├── analysis/    # Aggregate stats / weakness profile / weekly trends
│   ├── ai/          # OpenAI-compatible provider + plan-prompt.md / assistant-prompt.md templates + function calling tools (fetch-url / pdf-parse / web search) + document converters (Word/Excel/PPT/HTML/CSV/JSON/XML/EPub → Markdown)
│   ├── contests/    # Five-platform contest aggregation (CF/AtCoder/Luogu/Nowcoder/Jisuanke, auto-degrade on source failure)
│   ├── plans/       # Plan generation (AI-first, fallback to template on failure/no config) + persistence
│   ├── import/      # Manual import (JSON/CSV/form) + transactional persistence
│   ├── knowledge/   # Self-built knowledge pipeline (L1 title rules + source-tag mapping + JSONL source of truth / SQLite index)
│   ├── updater.ts   # One-click self-update (download/SHA256 verify/in-place replace)
│   └── routes/      # REST API (stats/problems/plans/ai/lists/reviews/today/templates/contests/checkins/settings/export/sync/import/update/knowledge/backups)
├── client/          # React + Vite + Ant Design (dashboard/today/AI assistant/templates/problem lists/plans/reviews/problem management/mastery map/calendar/contests/settings)
├── desktop/         # Tauri desktop shell (app: main native window + Node service sidecar)
└── shared/          # Cross-platform shared types and platform metadata
```

## Quick Start

Requirements: Node.js ≥ 22.16 (uses built-in `node:sqlite`; the knowledge pipeline relies on `DatabaseSync.isTransaction`, available since 22.16), npm.

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

- `icpc-workbench_<version>_aarch64.dmg`: drag to "Applications" to install
- **The build ad-hoc signs and verifies the bundle** (`codesign --force --deep --sign -` plus `codesign --verify --deep --strict`): Apple Silicon requires a valid signature on every executable in the bundle, and an unsigned or invalidated bundle shows up as "is damaged and can't be opened" (issue #14). A failed verification fails CI instead of publishing a broken package. Hardened runtime is deliberately off (without allow-jit the Node core's JIT cannot start)
- Still not notarized (no paid Apple Developer certificate), so the first launch may warn that the developer cannot be verified. Any of these clears it: right-click → "Open"; System Settings → "Privacy & Security" → "Open Anyway"; or `xattr -cr /Applications/icpc-workbench.app` in Terminal
- User data lives in `~/Library/Application Support/icpc-workbench/data`, **outside the app bundle** (writing inside the bundle invalidates the signature, and reinstalling would discard the data). Data written inside the bundle by older nightlies is migrated out automatically on first launch
- macOS does not support in-app one-click update (Windows only); to update, manually download from the Releases page and overwrite

## Docker Deployment (Web Server / NAS)

Run the workbench as a containerized service on a Linux server or NAS. Single container, single process: the API, the static frontend, and the widget page are all served on one port.

**Option A: build locally (a `Dockerfile` and `docker-compose.yml` ship with the repo)**

```bash
git clone <this-repo> && cd icpc-workbench
docker compose up -d      # build the image and start
```

**Option B: prebuilt image (published by CI, amd64 + arm64)**

```bash
docker run -d --name icpc-workbench \
  -p 127.0.0.1:3080:3001 \
  -v icpc-data:/app/server/data \
  ghcr.io/ZF3373/icpc-workbench:latest
```

Either way, open `http://127.0.0.1:3080` afterwards.

- **Data persistence**: the database (WAL), uploaded images, knowledge data, and daily backups all live under `/app/server/data` — the `icpc-data` volume in compose. Upgrading the image keeps the data (schema migrations are idempotent; the same volume works across versions)
- **Configuration**: `PORT`/`TZ` have sensible defaults; `AI_API_KEY` and `SEARCH_API_KEY` can be injected as environment variables or configured in the Settings page (stored in the DB, persisted with the volume); optionally mount a custom `server/config.json`
- **Upgrades**: `docker compose pull && docker compose up -d` (or pull a new image and recreate the container). The in-app "Software Update" does not apply to containers — the container build reports version `dev` and never prompts for updates; upgrade by switching images
- **Health check**: the image ships with a `HEALTHCHECK` probing `/api/health`; `docker ps` shows a healthy status
- **Security (read this)**: the app has no authentication at all, and `-p 127.0.0.1:3080:3001` binds the host loopback only. For LAN/public access, switch to `-p 3080:3001` and put your own reverse proxy with authentication and TLS in front — exposing it directly is equivalent to publishing your practice data and AI API key

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

| Platform | Auto-Sync | Method | Difficulty Scale (mapped to CF rating, 800–3500) | Notes |
|----------|-----------|--------|------|-------|
| Codeforces | ✅ | Official public API `user.status` | `rating` 800–3500 (the reference scale, used as-is; Gym/Unrated have no value) | No login required; paginated newest-first, stops early when an entire page of submission IDs is already known (incremental) |
| AtCoder | ✅ | Community API `kenkoooo.com` v3 | kenkoooo IRT `difficulty` (−10000…4383, a community model, not official) → piecewise-linear mapping over measured anchors | Supports incremental (from_second); problem resources cached on disk for 24h; official requirement: ≥1s between page requests; an "enrich tags from Luogu mirrors" switch in the Fetch-bank tab (off by default, limited coverage, match counts returned with the result) |
| Luogu | ✅ (Cookie required) | `record/list` unofficial API | `difficulty` **0–8, 9 tiers** (0 = not rated → unknown) → 800/1000/1500/1800/2200/2400/2600/3400 | Configure `_uid` / `__client_id` cookies in Settings to auto-sync; tags fetched via `x-lentille-request` header + `/_lfe/tags` dictionary |
| Nowcoder | ✅ | Public HTML `acm/contest/profile/{uid}/practice-coding` | "Difficulty score" **any integer in 200–4000** (same units as CF; clamped into 800–3500 and used directly; **not always a multiple of 100**—older problems measure 1049/623/726/972; ~20% of problems have none → unknown) | No login/cookie required (Nowcoder deprecated its JSON API); parses submission table, supports incremental and pagination; algorithm tags parsed from the bank page |
| Daimayuan | ✅ (Cookie required) | Hydro JSON API `/record?uidOrName=` (`Accept: application/json`) | Site's 1–10 tiers (admin-set, otherwise recomputed with Hydro's `round(10 − 13·s·acRate)`) → 800/900/1000/1200/1400/1600/1800/2000/2200/2400 | Configure `sid` session cookie in Settings to auto-sync (100 per page, incremental early termination); uses Hydro native JSON content negotiation to directly fetch rdocs array—no HTML template parsing, so Hydro frontend template changes won't break the adapter; status mapped to unified Verdict via Hydro STATUS enum; non-contest submissions only; problem bank page `/p/{id}` is public |
| LeetCode | ✅ (Cookie required) | leetcode.cn GraphQL `submissionList` | easy/medium/hard, 3 tiers → 1000/1500/2100 (interview-oriented, heuristic) | Configure cookies in Settings to auto-sync (40 per page, up to 250 pages); LeetCode China (leetcode.cn) only—international edition has a different API structure; problem bank is anonymously accessible and fetched with Chinese tags (`nameTranslated`) |
| Jisuanke | ✅ (Cookie required) | `/api/contests?hasParticipated=true` + per-contest `/api/contest/submissions`; plus practice (problem bank) submissions | `difficultyType` = level1…level8, 8 tiers (入门/普及−/普及/普及+/提高−/提高/提高+/省选/国赛) → same table as Luogu: 800/1000/1500/1800/2200/2400/2600/3400 | Paste the entire logged-in Cookie header in Settings to auto-sync (the site issues a guest `s` session even to logged-out visitors—confirm login first, then copy from a Network request header); no unified record page—submissions are fetched contest by contest from participated contests (up to 2 requests per contest, 30 contests per sync batch); contest index is used as the backfill cursor; **practice (free-practice / problem bank) submissions sync by default** (prescan `/api/problems` filtering with `status=passed` and `status=attempted`, then per-problem `/api/problem/submissions`), can be disabled in Settings, and is skipped in the "last N days only" window mode |
| QOJ | ✅ (Cookie required) | UOJ-family endpoints (behind Cloudflare challenge; requires full cookies and a browser UA) | **The platform itself has no difficulty field** (UOJ data model); difficulty is derived by the one-click backfill from **ICPC/CCPC public scoreboards** as gold/silver/bronze/iron (`icpc-tier`, see below) → approximate CF 1000/1500/2000/2600 | Submissions sync; **problem bank fetching is not supported** (the problem list sits behind the Cloudflare challenge); three mapping sources (the `xcpcrating` rating catalog, that dataset's problem-type keys — 1100 QOJ ids — and the **QOJ contest page**, whose problem labels are read over HTTP/1.1 with the stored credentials), boards matched by contest-name facets; unmatched problems stay unknown and **do not enter the training-plan candidate pool** |

> **Unified difficulty scale**: every platform's native difficulty above is mapped to the Codeforces rating scale (800–3500). There is exactly **one** mapping table, in `shared/src/difficulty.ts`; the native value is stored alongside it (`problems.native_difficulty` + `problems.difficulty_scale`), so a platform re-tiering only requires editing that single file. The mappings are **approximations (±100–200)** intended for training recommendations and weakness bucketing—not precise ratings.

> **Difficulty backfill is processed in ascending order of measured cost** (QOJ ≈18s → AtCoder ≈3s → Daimayuan ≈8s → CF ≈10s → LeetCode ≈53s → Jisuanke ≈276s → Luogu per-problem ≥4s each → Nowcoder whole-table up to 200 pages ≈400s). With the earlier alphabetical order QOJ came last: a click took over ten minutes to reach it, and **if you gave up or the service restarted (during development `tsx watch` restarts on every file change) the platforms later in the queue wrote nothing at all** — which showed up as "I ran the backfill and QOJ still has no difficulty". With cost-ascending order, an interrupted run still leaves you with qoj/atcoder/CF and most other platforms filled.
>
> **Request pacing has two layers**: (1) the global per-domain throttle (`net/hostThrottle.ts`: Luogu 4s, Nowcoder 2s, AtCoder 2.5s, CF 2s, LeetCode/Jisuanke/Daimayuan 1.5s) is the effective online cadence and can be slowed further via Settings → fetch speed (1×–5×, where 1× is already the safety floor); (2) each adapter's own page/per-problem sleep has also been raised to that **same safety floor** (it used to be 0.3s per Luogu problem / 0.5s per Nowcoder page). The two take the larger value, so nothing gets slower online — but **no path that bypasses the throttle (local scripts, unit tests, a future refactor that forgets to wire it) can hammer upstream at a risk-control-triggering rate**.

> Luogu uses a community-maintained unofficial API whose structure may change with platform updates. If sync fails, update your cookies and retry. Cookies are stored only in the local database—do not leak them.

## Known Limitations

- **Luogu's difficulty definition is officially temporary**: Luogu's own difficulty documentation marks it as a temporary definition, the tier system was already adjusted once in 2026-06 (a new cyan "提高" tier), and splitting the black tier (NOI / NOI+/CTS) is planned — the Luogu mapping here was measured at the time of writing and needs re-verification once the definition is final (table-driven code plus `difficulty_scale` keeps that cheap).
- **Nowcoder difficulty has two shapes, and a batch of real values used to be discarded by our own validator**: the site's difficulty column is **not guaranteed to be a multiple of 100** (older problems measure NC16640 = 1049, NC22014 = 623, NC22158 = 726, NC24739 = 972); the old validator demanded multiples of 100 and turned those real values into "unknown" (fixed 2026-09-27 with a range check plus column-structure validation, and that batch has been restored). Some problems still have a genuinely **empty difficulty cell** (mostly "pass-the-level / language" problems—30 of the 41 unknown-difficulty problems measured) → they show as "no official difficulty" and are recorded in the negative cache, so they are not re-queried for a month (see below).
- **QOJ difficulty comes from public scoreboards (three sources as of 2026-09-28; coverage now works end to end)**: QOJ has no difficulty field of its own (UOJ data model), so difficulty can only be derived from the **accepted-team ratio on ICPC/CCPC public scoreboards** (gold/silver/bronze/iron → CF 2600/2000/1500/1000). The chain is "problem id → contest + problem label → that problem's ratio on the board → tier", and its first link now has three sources: ① `xcpcrating`'s `problem-catalog.json` (a *rating* dataset; measured coverage: 987 QOJ ids); ② **the keys of that dataset's `problem-types/*.json`** (`contest-key:label`; measured 1100 ids) — the old implementation read only their `detailTags` and discarded the keys, so local problems `2513-14301/2/3` (2025 ICPC Asia East Continent Online Contest I, A/B/C) were judged "not in the catalog" although the mapping was right there (the symptom was exactly "tags but no difficulty"); ③ the **QOJ contest page** (`https://qoj.ac/contest/{contestId}`, and the contest id is part of the stored key, e.g. `2513-14301`), which yields the contest name plus the full label↔problem-id table for anything the two datasets miss (the same approach as OJ_Insight's `parse_category`). For the second link, source ① matches boards by contest key while source ③ matches by **contest-name facets** (year / series / stage / site / round; `analysis/xcpcFacets.ts`; a nationwide online round I scores 5+8+4+4 = 21, the threshold is ≥10 with a unique best, and the sibling rounds "I"/"II" are told apart by round). QOJ sits behind Cloudflare: contest pages are requested over HTTP/1.1 with the stored `cookie.qoj`/`ua.qoj` (the same credentials and the same per-host throttle bucket as submission sync) and degrade honestly to "unknown" when unavailable; contest pages are cached on disk per contest id for 7 days and at most 6 are read per run. The datasets are fetched through a jsDelivr CDN mirror (direct GitHub access is blackholed on some networks) with ghproxy as fallback; if unavailable the whole derivation degrades to "unknown" without blocking the backfill. Problems still unmatched stay unknown and **do not enter the training-plan candidate pool**.
- **Codeforces gym and officially unrated contests have no public difficulty** (measured 492 problems → 466 left after a backfill run): `problemset.problems` contains **no gym problems at all** (0 of 11,425 have contestId ≥ 100000), the gym standings API requires authentication, the problem HTML is behind a Cloudflare 403, and Luogu does not mirror gym problems (`CF100153A`) — so the 115 local gym problems genuinely have no source. The other 351 are **officially unrated** regular-contest problems (e.g. the Q# quantum problems of contest 1116) which the API does list but without a `rating` field → the backfill reports them honestly as "official difficulty missing" rather than inventing one.
- **The mappings are approximations**: native difficulties are not strictly isomorphic to CF rating (AtCoder's kenkoooo difficulty is a community IRT model; LeetCode and Daimayuan are heuristics; QOJ's ICPC tier has only 4 buckets), with roughly ±100–200 error (±300–400 for QOJ tiers); they serve training recommendations and weakness bucketing, and may need re-measuring when a platform re-tiers or changes its definition.
- **AtCoder's "enrich tags from Luogu mirrors" has limited coverage**: the tags come from a third party (Luogu mirror attribution) and the option is off by default (the switch lives in the "Fetch bank" tab and appears when AtCoder is selected); in a measured sample of 250 rows, 139 matched a problem id and only 68 of those actually carried tags—so it is not a complete tag source.
- **Difficulty backfill batches per platform**: one click walks every platform, but the **per-problem cap of 400 Luogu problems** truncates it; the skipped count comes back in the response (`capped`) and clicking again continues. Whole-table platforms (CF / AtCoder / LeetCode / Jisuanke / **Nowcoder / Daimayuan**) use a cap of 20000 so historical rows converge in one run. Luogu rows that only lack the native text are skipped by default and counted as `deferred` (no upstream request); tick the **force re-check** checkbox in the Fetch-bank tab (`includeNativeOnly: true`, which also bypasses the negative cache) to force a per-problem re-query. Problems that genuinely have no upstream difficulty (empty Nowcoder cells, Luogu "not rated", CF gym) are no longer re-queried every run: they are counted in `cached` and covered by the negative cache below; problems the upstream explicitly refuses (401/403) are counted separately as `denied`.
- **Missing-difficulty negative cache** (`problems.gap_state` + `gap_checked_at`, 30-day TTL): dimensions the backfill asked about and the upstream explicitly could not provide (`difficulty` / `tags`) are recorded on the row, so within the TTL those rows **stop being backfill targets**; the count is reported as `cached`, and the problem list shows "no official difficulty" instead of a dash (a dash means "not looked up yet"). Three boundaries: ① only platforms whose single response *is* the complete bank (CF / AtCoder) may treat "this row wasn't there" as a verdict — paginated scans (Nowcoder / Daimayuan / LeetCode / Jisuanke) reaching their page cap is not evidence of absence; ② request failures, risk-control pages and Luogu per-problem 404s are never recorded (one rate-limit would lock the problems for 30 days); ③ QOJ records nothing (its null cannot distinguish "absent from the catalog" from "board source unavailable"). A dimension leaves the cache as soon as the upstream later supplies a rating or tags, without waiting for the TTL; `includeNativeOnly: true` (the "force re-check" checkbox in the Fetch-bank tab) also bypasses the cache and re-asks (verdicts wrongly locked before the key-shape fix are invalidated once by the startup migration described below; the checkbox remains for other cases, e.g. wanting a rating the platform just added without waiting for the TTL). **Two extra rules apply to the `tags` dimension**: what gets cached is "the upstream really has no *usable algorithm* tags" — when Luogu only supplies contest/source/year tags (e.g. `2013`, `USACO`, `洛谷原创`, `O2优化`), purification empties them and that is a genuine verdict, so it is cached as usual (a fair share of Luogu's tag-less problems are of this kind: locking them is intentional, re-asking yields no algorithm tags); whereas when the **upstream supplied tag ids that we could not resolve to names** (`/_lfe/tags` silently degrades to an empty dictionary on failure) **nothing** is recorded, so "I failed to fetch the dictionary" is never mistaken for a 30-day verdict.
- **Problem-key shape check + AtCoder key normalization** (a real bug found on 2026-09-28): rows carried the display form `abc300a` while the kenkoooo whole table uses `abc300_a`, so the lookup missed; because AtCoder is a "single response *is* the complete bank" platform, that miss was recorded as a verdict and locked 30 days (in the local demo DB all 100 AtCoder gap rows were locked; 64 of them differed from the table key by one underscore). Two defences now: ① **normalize before querying** — AtCoder is looked up by "the stored key first, then the underscore-inserted form" (`atcoderProblemIdCandidates`; kenkoooo really does contain 20 ids with no underscore at all, e.g. `joi2011ho1`, so the candidate list must stay ordered and start with the stored key), and writes still use the stored key with no data migration; ② **a shape check before recording a verdict** (`absenceIsDefinitive`) — the row's contest prefix must actually exist in the whole table (`abc308i`'s prefix `abc308` does → the problem really is unindexed and the verdict stands; a typo like `abcc300a` has no such prefix → no cache is written, the row is reported as `failed` with a "suspicious key shape, no verdict recorded" note). Measured against the real kenkoooo snapshot × the 100 demo rows: 10 already canonical, 64 fixed by the underscore (`nativeFilled: 64`), 25 with a real contest but an unindexed problem (verdict as before), 1 (`abc316g`, whose entire contest is absent from the snapshot) left undecided and re-checked next run; ③ **old verdicts are invalidated once** (`invalidateUnreliableGapVerdicts` in `db/index.ts`): normalization and the shape check only affect verdicts written *after* this fix, so rows already locked would stay outside the backfill target set forever — the startup migration therefore clears AtCoder verdicts written before the fix whose key shape is unreliable (idempotent: a re-checked verdict carries a new timestamp and is no longer touched), so users do not have to know about the force re-check; the only cost is one extra kenkoooo table request on the next run, and per-problem platforms (Luogu/Nowcoder) are not touched at all. The same class of bug already existed on Nowcoder (historical key `NC20000` vs the site id `20000`) and was solved earlier by query-side normalization.
- **Upstream refusal (401/403) is recorded separately from "not found"**: for deleted / private / non-public problems Luogu answers 401 anonymously and 403 even with the configured cookie (measured: `T822401` and two others). That is a definite answer about *that row*, so it is now counted as `denied` (reported as "N problems with no public source (removed/private upstream)"), written to the negative cache and not requested again; HTTP 500 / 302 challenge pages / 504 still only mean "not obtained" (`failed`) and are retried next run with no cache. The only way out for such problems is to **fill the difficulty in by hand** (`PATCH /api/problems/:platform/:key/difficulty`): `difficulty_source` becomes `manual` (highest priority — backfill/sync/bank never overwrite it), the native value and scale are written from the same source (the CF number itself, so the row cannot end up as "manual 2400 + platform native 'Advanced' (≈2200)"), and the negative cache is cleared; passing `null` clears it and returns the row to "unknown" so backfill picks it up again.
- **Stored difficulty values can go stale, and the backfill corrects them**: when the mapping table is revised, values written by an older table are not migrated automatically. Whole-table platforms (CF / AtCoder / LeetCode / Jisuanke / Nowcoder / Daimayuan) rewrite them from the upstream's current value on every run (counted in `repaired`, with per-problem notes like "difficulty 700→800"); **Luogu is the exception**—it only has a per-problem source whose native-only rows are skipped by default, so stale Luogu values are not corrected unless you explicitly enable `includeNativeOnly`.
- **One backfill run can take over ten minutes, and it works synchronously while persisting as it goes**: the Nowcoder whole-table scan (up to 200 pages ≈400s) and the per-problem Luogu pass (≥4s each, hundreds of problems) come last. Every platform's writes are **committed in batches**, so if you close the page—or the **service restarts (in development `tsx watch` restarts on file changes)**—the platforms already completed are safely in the database and you only need to click once more to continue; the cheap platforms (qoj/atcoder/CF) come first and report within seconds.
- **You can stop a run at any time and click again to continue from where it left off**: "Stop backfill" (`POST /api/problems/backfill-difficulty/stop`) aborts the run **on the server**—in-flight upstream requests fail immediately and the current write batch is **committed rather than rolled back**, so **problems already in the database are unaffected** and the interrupted ones remain targets for the next run (the interrupted platform is reported with `stopped: true`; an abort is not counted as `failed` and writes no negative cache). Stopping has to be a server-side action: aborting the browser request alone would not help, because the server loop would keep writing. Refreshing or reopening the page does not lose progress either: `GET /api/problems/backfill-difficulty/run` reports "processing <platform> N/M (N problems this round)" plus the run state, which the UI uses to keep showing progress and the stop button. Only one run is allowed at a time (a second POST while running returns 409, which avoids two runs fighting over the same rows and upstream rate limits); run state is **not persisted across processes** (a service restart interrupts the run, and batched commits preserve the results).
- **Background continuation is an in-process plan**: when a sync is truncated by the per-run cap, it continues automatically in the background at a per-platform pace (20–90 seconds), up to 6 rounds by default (configurable in Settings, 0 disables, cancellable at any time); the plan is lost when the service restarts—clicking sync once resumes from the saved cursor.

## Cookie Configuration (Required for Luogu / Daimayuan / LeetCode / Jisuanke)

1. After logging into Luogu in your browser: F12 → Application → Cookies → `https://www.luogu.com.cn`
2. Copy the values of `_uid` and `__client_id`, paste them into the two input fields under "Settings → Luogu" and save (the app assembles the Cookie header; C3VK and other cookies auto-renew—no need to enter them)
3. Daimayuan: after logging into bs.daimayuan.top: F12 → Application → Cookies, copy the `sid` entry (session cookie), paste into "Settings → Daimayuan" and save (supports pasting the entire Cookie header—auto-extracts fields; re-copy when expired)
4. LeetCode: after logging into leetcode.cn: F12 → Application → Cookies, copy `LEETCODE_SESSION` and `csrftoken`, paste into "Settings → LeetCode" and save
5. Jisuanke: first make sure you are logged into www.jisuanke.com (avatar shown at top right), then F12 → Network → refresh → click any api request → Request Headers, copy the entire Cookie header, paste into "Settings → Jisuanke" and save (the handle field can be your nickname for reference only). Note: the site issues a guest `s` session even to logged-out visitors—copying `s` from the Application tab is usually a guest session and will be rejected
6. Go to "Problem Management" → Platform Sync → enter username/uid → Sync
7. When rebinding accounts, the new sync automatically clears the old account's submission data for that platform

## API Overview

```
GET  /api/health
POST /api/sync/all               # One-click sync all bound accounts (incremental per platform; single-platform failure doesn't affect others)
POST /api/sync/:platform          # Sync a single platform account (body: handle)
POST /api/import/manual           # Manual import (body: platform, rows[])
POST /api/import/csv              # CSV import (body: platform, csv)
GET  /api/stats                   # Overall stats (from/to/platform filter; account = per-account scope, must pair with platform, default = all accounts)
GET  /api/stats/weakness          # Weakness profile (minAttempts/topN; platform+account as above — the average AC-rate baseline narrows with the scope)
GET  /api/stats/trend             # Weekly trend (weeks; platform+account as above)
GET  /api/stats/heatmap           # Activity heatmap (days; platform+account as above)
GET  /api/stats/mastery           # Knowledge mastery map (submission data × template curriculum; platform+account as above)
GET  /api/stats/accounts          # Accounts that actually have submissions (platform/account/attempts/AC/solved/last submitted) — feeds the account-scope picker; manual imports (no account) are not listed
GET  /api/stats/summary           # Complete practice data summary (JSON: totals/platform/difficulty/tags/weakness/mastery/trends/recent ACs/stuck problems/review bank/course progress/check-ins)
GET  /api/problems                # Problem list (platform/difficulty/tag/q filter; tag includes synonymous English aliases)
GET  /api/today                   # Today's training recommendation (problems selected by weakness + planned tasks)
GET  /api/templates               # Full built-in template curriculum + personal progress (total/mastered/learning/next)
GET  /api/templates/next          # "Next lesson" recommendation (learning-first, then first unlearned in outline)
POST /api/templates/custom        # Create custom template | PATCH/DELETE /api/templates/custom/:id
PUT  /api/templates/:id/content   # "Write my template" for a lesson (idea/code/complexity/reference link)
POST /api/templates/:id/status    # Study status (body: { status: todo|learning|mastered })
PATCH /api/templates/:id/note     # Study note (body: { note })
GET  /api/reviews                 # Review queue (each item carries reviewCount/lapseCount; ?due=1 = due + overdue only)
GET  /api/reviews/due-count       # Review load breakdown: count = today's workload (overdue + due), plus overdue/dueToday/next7/total
POST /api/reviews/:id/feedback    # Review feedback (hard steps back two stages / ok one / easy two) → scheduled with the retention factor and logged to review_events
                                   # Returns { stage, nextDueOn, intervalDays, factor }; POST /api/reviews staggers new items 0–3 days by problem id
GET  /api/contests                # Five-platform contest aggregation (CF/AtCoder/Luogu/Nowcoder/Jisuanke; ?type=upcoming|finished&platform=&limit=)
GET  /api/contests/participated   # Post-contest review "My Contests": served from local DB (persisted), stale platforms refresh incrementally in the background
POST /api/contests/participated/refresh  # Force a synchronous participation fetch (incremental cursors apply, 30-page-per-run cap)
GET  /api/plans | POST /api/plans/generate | POST /api/plans/import | GET /api/plans/:id | DELETE /api/plans/:id
                                   # generate body: { days?, startDate?, dailyTasks?, requirements? } ← requirements = user-written training requirements, injected into AI prompt and prioritized
                                   # import body: { raw, startDate?, days? } ← any AI-returned plan JSON text
PATCH /api/plans/tasks/:taskId    # Edit single task (taskDate/title/kind/url/note, only updates submitted fields)
DELETE /api/plans/tasks/:taskId   # Delete single task (check-in records cascade-deleted)
POST /api/plans/:id/apply         # Apply AI plan modification (body: { raw }; preserves check-ins by matching "date + title")
POST /api/ai/chat                # Global AI assistant chat (body: { messages, planId?, listId?, contestKey? }; injects practice summary/weakness profile/ability level/contest calendar/current date; planId enables plan modification and plan creation when absent, listId links a problem list, contestKey links a participated contest for post-contest review; user messages can include attachments: [{ fileId, filename? }], ≤8, supporting images/PDF/multi-format documents/text and code; supports function calling tools: web search / fetch-url / pdf-parse)
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
POST /api/knowledge/build         # Run L1 rules + source-tag mapping (body: { rerun?: boolean })
GET  /api/knowledge/coverage      # Coverage report (total / annotated / uncovered / bySource / threshold)
GET  /api/knowledge/gaps          # Vocabulary gap report (unmapped source tags → affected problem count)
POST /api/knowledge/recompute-stats # Recompute concept stats (coverage & information content)
POST /api/knowledge/threshold     # Set statistical confidence threshold (body: { value: 0..1 }; affects mastery map, list stats, coverage annotated count, and compare uncovered bucket)
GET  /api/knowledge/taxonomy      # Full knowledge taxonomy
GET  /api/knowledge/problem/:platform/:key # Current annotations for a problem
PUT  /api/knowledge/:platform/:key # L3 manual correction (body: { codes: string[] })
GET  /api/knowledge/compare        # Tag-caliber vs knowledge-caliber weakness comparison
GET  /api/knowledge/sample         # Post-build random sample list (?rate=0.01)
GET  /api/knowledge/meta           # Pipeline/rules/knowledge-point metadata
POST /api/problems/:platform/:key/intent  # Record user-reported stuck point (body: { outcome, code? })
GET  /api/problems/:platform/:key/intents # Stuck-point records for a problem
PATCH /api/problems/:platform/:key/difficulty # Set/clear a problem's difficulty by hand (body: { difficulty: integer 800-3500 | null })
                                    # For problems the upstream genuinely cannot rate (deleted/private, Luogu "not rated",
                                    # CF gym/Unrated): sets difficulty_source='manual' (backfill/sync never overwrite it),
                                    # writes the native value/scale from the same source, clears the negative cache;
                                    # null clears it and returns the row to "unknown" (backfill targets it again)
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

Test coverage: database schema and constraints, config validation, CF/AtCoder/Nowcoder contest adapter normalization (mock + real network verification), CSV parsing, import dedup, incremental sync, stats/weakness/trends consistency with manual calculation, AI generation three paths (success/failure/unconfigured), post-contest review participation derivation (per-platform signals/calendar-window matching/review context rendering), update dual-channel logic and SHA256 verification parsing, document converters (Word/Excel/PPT/HTML/CSV/JSON/XML/EPub), Markdown math formula preprocessing pipeline, session-level attachment content caching.

## Sponsor

If this project helps your contest prep, buying the author a coffee is much appreciated ❤

[![Sponsor](https://img.shields.io/badge/Sponsor-❤-EA4AAA?style=for-the-badge&logo=githubsponsors)](https://github.com/sponsors/ZF3373)

You can also use the "Sponsor this project" button on the repository homepage (sponsor channels are configured in [.github/FUNDING.yml](./.github/FUNDING.yml)).

## License

This project's code is released under the [GPL-3.0 License](./LICENSE) (GNU General Public License v3.0): redistribution and modified versions of the project must likewise be licensed under GPL-3.0 with copyright notices retained.
Third-party dependencies and their licenses are listed in [CREDITS.md](./CREDITS.md); please report security issues through the private channel described in [SECURITY.md](./SECURITY.md)—do not file public Issues.
